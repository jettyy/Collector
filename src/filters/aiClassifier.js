// 2차 필터: Claude 배치 판정 (기본: 구독 계정의 Claude Code CLI, AI_PROVIDER 로 변경)
//  - 카테고리 메타데이터로 결론이 안 난 그룹(review)에 "정보성 / 제외" 라벨을 붙인다
//  - 네이버 기사 제목만 있는 헤드라인 그룹에는 짧은 주제어(topic)도 뽑는다
//  - 주기당 1회 배치 호출 (항목이 많으면 AI_MAX_ITEMS_PER_CALL 단위로 분할)
//  - 같은 키워드/헤드라인은 LABEL_CACHE_HOURS 동안 캐시 재사용 → 반복 비용 없음
//  - Claude 를 쓸 수 없거나 호출이 실패하면 규칙 기반 휴리스틱으로 대체 (캐시하지 않음)
const config = require('../config');
const claude = require('./claudeClient');
const db = require('../db/db');
const { titlesOf } = require('../scoring/scorer');
const { log, warn, cleanHeadline } = require('../utils');

const SYSTEM_PROMPT = `너는 한국 실시간 트렌드 키워드를 블로그 소재 관점에서 분류하는 편집자다.
각 항목이 정보성(label "info")인지 제외(label "exclude")인지 판정한다.
- 정보성: 생활정보, 경제 데이터(금리·환율·물가·부동산·주가 지표 등), IT·과학·신제품, 제도·정책 변경(시행일·신청방법·지원금 등), 날씨·재난 대비, 건강, 소비자 정보처럼 사람들이 검색해서 "알아야 할" 내용.
- 제외: 연예인 가십·열애·결혼·이혼, 스포츠 경기 결과, 정치인·정당 공방, 수사·재판·소송·고소 논란, 사건사고 자극 보도, 밈·단발성 화제처럼 휘발성이 강한 내용.
애매하면 "이 주제로 정보성 블로그 글을 쓸 수 있는가"로 판단한다.

각 항목의 topic 도 채운다.
- type 이 "keyword" 이면 topic 은 입력 키워드를 그대로 쓴다.
- type 이 "headline"(뉴스 기사 제목) 이면 사람들이 실제로 검색할 법한 2~12자 핵심 주제어로 요약한다 (예: "주담대 금리 인하", "아이폰17 출시", "청년도약계좌"). 인물 이름보다 이슈를 우선한다.
모든 id 에 대해 정확히 하나씩 결과를 낸다.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          topic: { type: 'string' },
          label: { type: 'string', enum: ['info', 'exclude'] },
        },
        required: ['id', 'topic', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// ---- 휴리스틱 대체 판정 ----
const EXCLUDE_PATTERNS = [
  /열애|결혼|이혼|파경|불륜|결별|컴백|데뷔|아이돌|배우|가수|예능|드라마\s?출연|팬미팅|걸그룹|보이그룹|열연/,
  /대통령|국회|의원|여당|야당|민주당|국민의힘|총선|대선|탄핵|장관\s?후보|청문회|정당|대표\s?회담/,
  /검찰|기소|구속|영장|재판|판결|선고|소송|고소|고발|혐의|수사|체포|논란|폭로|갑질|사과문/,
  /경기|홈런|골|승리|패배|결승|리그|감독\s?경질|이적|선발|득점/,
  /사망|숨져|살해|흉기|추락|화재로|실종/,
];

function heuristicLabel(text) {
  return EXCLUDE_PATTERNS.some((re) => re.test(text)) ? '제외' : '정보성';
}

function heuristicTopic(headline) {
  const t = cleanHeadline(headline)
    .replace(/["'“”‘’「」『』]/g, ' ')
    .split(/[,…·|]|\.\.\.|\s[-–—]\s/)[0]
    .trim();
  return t.split(/\s+/).slice(0, 3).join(' ');
}

// ---- 판정 대상 선별 ----
function cacheKey(g) {
  return g.isHeadline ? g.normKey : `k:${g.normKey}`;
}

function needsWork(g) {
  if (g.categoryDecision === 'exclude') return false; // 제외 확정은 주제어도 필요 없음
  return g.label === null || g.isHeadline;
}

function applyResult(g, { label, topic }, reason) {
  if (g.isHeadline && topic) g.topic = topic.trim();
  if (g.label === null) {
    g.label = label;
    g.reason = reason;
  }
}

function buildUserContent(batch) {
  const lines = batch.map(({ g }, i) => ({
    id: i,
    type: g.isHeadline ? 'headline' : 'keyword',
    text: g.keyword,
    section: g.category || undefined,
    titles: g.isHeadline ? undefined : titlesOf(g, 3),
  }));
  return `다음은 방금 수집된 실시간 키워드와 관련 기사 제목 목록이다. 각 항목을 판정하라.\n\n${JSON.stringify(lines, null, 1)}`;
}

const LABELS = { info: '정보성', exclude: '제외' };

async function callClaude(batch) {
  const out = await claude.complete({ system: SYSTEM_PROMPT, user: buildUserContent(batch), schema: OUTPUT_SCHEMA });
  return (out.results || []).map((r) => ({ ...r, label: LABELS[r.label] || r.label }));
}

async function classify(groups) {
  const errors = [];
  const pending = [];
  let cached = 0;

  for (const g of groups) {
    if (!needsWork(g)) continue;
    const hit = db.getLabelCache(cacheKey(g), config.ai.labelCacheHours);
    if (hit) {
      applyResult(g, hit, hit.reason || 'ai');
      cached++;
    } else {
      pending.push({ g });
    }
  }

  const useAi = claude.enabled();
  let aiCount = 0;
  if (pending.length && useAi) {
    for (let i = 0; i < pending.length; i += config.ai.maxItemsPerCall) {
      const batch = pending.slice(i, i + config.ai.maxItemsPerCall);
      try {
        const results = await callClaude(batch);
        for (const r of results) {
          const item = batch[r.id];
          if (!item || item.done || !['정보성', '제외'].includes(r.label)) continue;
          const topic = item.g.isHeadline ? r.topic : item.g.keyword;
          applyResult(item.g, { label: r.label, topic }, 'ai');
          db.setLabelCache(cacheKey(item.g), { label: r.label, topic, reason: 'ai' });
          item.done = true;
          aiCount++;
        }
      } catch (e) {
        const msg = e.message;
        warn('ai', `배치 판정 실패 → 휴리스틱 대체: ${msg}`);
        errors.push({ stage: 'aiClassifier', message: msg });
      }
    }
  }

  // AI 결과가 없는 항목은 휴리스틱
  let heuristic = 0;
  for (const item of pending) {
    if (item.done) continue;
    const g = item.g;
    const text = [g.keyword, ...titlesOf(g, 3)].join(' ');
    applyResult(g, { label: heuristicLabel(text), topic: g.isHeadline ? heuristicTopic(g.keyword) : g.keyword }, 'heuristic');
    heuristic++;
  }

  log('ai', `판정: 캐시 ${cached} / AI ${aiCount} / 휴리스틱 ${heuristic}${useAi ? '' : ` (AI 꺼짐: AI_PROVIDER=${config.ai.provider})`}`);
  return { errors };
}

module.exports = { classify, heuristicLabel, heuristicTopic, buildUserContent, SYSTEM_PROMPT, OUTPUT_SCHEMA };
