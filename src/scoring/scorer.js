// 출처 교차 가중치 스코어링 + 직전 주기 대비 신규/지속 판정
const config = require('../config');
const db = require('../db/db');
const { normalizeKeyword } = require('../utils');

const SOURCE_WEIGHTS = {
  googleTrends: 1.2,
  signalbz: 1.0,
  naverNews: 0.8,
  naverDatalab: 0.6,
};

const SOURCE_LABELS = {
  googleTrends: '구글트렌드',
  signalbz: '시그널',
  naverNews: '네이버뉴스',
  naverDatalab: '데이터랩',
};

function newGroup(keyword, normKey, isHeadline) {
  return { keyword, normKey, isHeadline, items: [], label: null, reason: null, category: null, articles: [] };
}

// 원본 항목 → 키워드 그룹
//  - kind=keyword 항목은 정규화 키로 묶는다
//  - kind=headline(네이버 기사 제목)은 제목에 포함된 가장 긴 키워드 그룹에 증거로 붙이고,
//    어디에도 안 붙으면 헤드라인 단독 그룹이 된다 (주제어는 aiClassifier 가 채움)
function groupItems(items) {
  const byKey = new Map();
  const headlines = [];
  for (const it of items) {
    if (it.rawMeta && it.rawMeta.kind === 'headline') {
      headlines.push(it);
      continue;
    }
    const key = normalizeKeyword(it.keyword);
    if (key.length < 2) continue;
    if (!byKey.has(key)) byKey.set(key, newGroup(it.keyword, key, false));
    byKey.get(key).items.push(it);
  }

  const keywordGroups = [...byKey.values()].sort((a, b) => b.normKey.length - a.normKey.length);
  const headlineGroups = new Map();
  for (const h of headlines) {
    const title = normalizeKeyword(h.rawMeta.title || h.keyword);
    const match = keywordGroups.find((g) => title.includes(g.normKey));
    if (match) {
      match.items.push(h);
      continue;
    }
    const key = `h:${title}`;
    if (!headlineGroups.has(key)) headlineGroups.set(key, newGroup(h.keyword, key, true));
    headlineGroups.get(key).items.push(h);
  }

  const groups = [...byKey.values(), ...headlineGroups.values()];
  groups.forEach(collectArticles);
  return groups;
}

function collectArticles(g) {
  const seen = new Set(g.articles.flatMap((a) => [a.url, normalizeKeyword(a.title)]));
  const add = (a) => {
    if (!a || !a.url || !a.title) return;
    const t = normalizeKeyword(a.title);
    if (seen.has(a.url) || seen.has(t)) return;
    seen.add(a.url);
    seen.add(t);
    g.articles.push({ title: a.title, url: a.url });
  };
  for (const it of g.items) {
    if (it.rawMeta.kind === 'headline') add({ title: it.rawMeta.title, url: it.rawMeta.url });
    for (const a of it.rawMeta.articles || []) add(a);
  }
}

function sourcesOf(g) {
  return [...new Set(g.items.map((it) => it.source))];
}

// 기사 제목 목록 (AI 판정 입력용)
function titlesOf(g, max = 3) {
  return g.articles.slice(0, max).map((a) => a.title);
}

// aiClassifier 가 헤드라인 그룹에 주제어(topic)를 붙인 뒤 같은 주제끼리 병합
function mergeByKeyword(groups) {
  const byKey = new Map();
  for (const g of groups) {
    if (g.isHeadline && g.topic) {
      g.keyword = g.topic;
      g.normKey = normalizeKeyword(g.topic);
      g.isHeadline = false;
    }
    if (!g.normKey || g.normKey.length < 2) continue;
    const prev = byKey.get(g.normKey);
    if (!prev) {
      byKey.set(g.normKey, g);
      continue;
    }
    prev.items.push(...g.items);
    collectArticles(prev);
    // 카테고리 제외가 하나라도 있으면 제외, 아니면 정보성 우선
    if (g.label === '제외' && String(g.reason || '').startsWith('category')) {
      prev.label = '제외';
      prev.reason = g.reason;
    } else if (prev.label !== '정보성' && g.label === '정보성' && !String(prev.reason || '').startsWith('category')) {
      prev.label = '정보성';
      prev.reason = g.reason;
    }
    prev.category = prev.category || g.category;
  }
  return [...byKey.values()];
}

function rankFactor(rank) {
  if (!rank) return 1;
  return 1.5 - Math.min(rank, 20) / 40; // 1위 1.475 ~ 20위 이하 1.0
}

function score(g) {
  const bySource = new Map();
  for (const it of g.items) {
    const list = bySource.get(it.source) || [];
    list.push(it);
    bySource.set(it.source, list);
  }
  let base = 0;
  for (const [source, list] of bySource) {
    const w = SOURCE_WEIGHTS[source] ?? 0.5;
    const best = Math.max(...list.map((it) => rankFactor(it.rank)));
    let s = w * best;
    if (source === 'naverNews') {
      // 여러 언론사/섹션에서 동시에 다뤄지거나 헤드라인 클러스터가 크면 가점
      const cluster = Math.max(0, ...list.map((it) => it.rawMeta.cluster || 0));
      const ranked = list.some((it) => it.rawMeta.ranked || it.rawMeta.type === 'ranking');
      s += Math.min(0.5, 0.1 * (list.length - 1)) + Math.min(0.3, cluster / 100) + (ranked ? 0.2 : 0);
    }
    if (source === 'googleTrends') {
      const traffic = Math.max(0, ...list.map((it) => it.rawMeta.traffic || 0));
      if (traffic > 0) s += Math.min(0.5, Math.log10(traffic) / 10);
    }
    base += s;
  }
  const cross = 1 + 0.5 * (bySource.size - 1);
  return Math.round(base * cross * 100) / 100;
}

function finalize(groups) {
  for (const g of groups) {
    g.sources = sourcesOf(g);
    g.score = score(g);
  }
  return groups.sort((a, b) => b.score - a.score);
}

// DB 반영 + 알림 큐 산출
//  - 직전 실행에서도 잡힌 키워드: 기존 행 갱신 (중복 알림 X)
//  - 새로 등장: 새 행. 정보성 + 점수 기준 이상 + N시간 내 알림 이력 없음 → 알림 큐
//  - 지속 중인데 아직 알림 안 간 키워드가 교차 출처 증가 등으로 기준을 넘으면 → 알림 큐 (승격)
function applyDiff(groups, runId, { isFirstRun = false } = {}) {
  const prevRunId = db.getPrevRunId(runId);
  const { minScoreToNotify, renotifyHours, maxAlertsPerRun, notifyOnFirstRun } = config.scoring;
  const queue = [];
  let newCount = 0;

  for (const g of groups) {
    const row = { ...g, runId };
    const existing = db.findContinuing(g.normKey, prevRunId);
    let id;
    let isNew = false;
    if (existing) {
      db.touchKeyword(existing.id, row);
      id = existing.id;
    } else {
      id = db.insertKeyword(row);
      isNew = true;
      newCount++;
    }
    g.id = id;
    g.isNew = isNew;
    if (g.label !== '정보성' || g.score < minScoreToNotify) continue;
    // 지속 키워드는 "이번에 처음 기준을 넘은 경우"에만 승격 알림 (이미 자격이 있던 건 첫 실행 기준선 등으로 의도적 미발송)
    if (existing && (existing.notified || (existing.label === '정보성' && existing.score >= minScoreToNotify))) continue;
    if (db.wasNotifiedRecently(g.normKey, renotifyHours)) continue;
    queue.push(g);
  }

  const suppress = isFirstRun && !notifyOnFirstRun;
  return {
    newCount,
    queue: suppress ? [] : queue.sort((a, b) => b.score - a.score).slice(0, maxAlertsPerRun),
    suppressedFirstRun: suppress && queue.length > 0,
  };
}

module.exports = { groupItems, mergeByKeyword, finalize, applyDiff, score, rankFactor, titlesOf, sourcesOf, SOURCE_WEIGHTS, SOURCE_LABELS };
