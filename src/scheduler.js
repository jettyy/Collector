// 10분 주기 오케스트레이터
// 수집(병렬) → 그룹핑 → categoryFilter → 관련기사(키워드 그룹) → aiClassifier(배치)
//   → 주제어 병합 → 관련기사(헤드라인 주제어) → 스코어링 → DB diff → 텔레그램
// ※ 관련기사를 AI 판정보다 먼저 붙이는 이유: 시그널·데이터랩 키워드는 기사 제목이 없어
//   "키워드+기사제목"으로 판정하려면 검색 결과가 필요하다. 검색 결과는 1시간 캐시된다.
const cron = require('node-cron');
const config = require('./config');
const db = require('./db/db');
const { collectAll } = require('./collectors');
const categoryFilter = require('./filters/categoryFilter');
const aiClassifier = require('./filters/aiClassifier');
const articleMatcher = require('./enrich/articleMatcher');
const scorer = require('./scoring/scorer');
const telegram = require('./notify/telegramBot');
const { log, warn } = require('./utils');

let running = false;
let lastSummary = null;
let task = null;

async function runCycle({ dryRun = false, collectors } = {}) {
  if (running) {
    warn('cycle', '이전 주기가 아직 실행 중이라 건너뜀');
    return null;
  }
  running = true;
  const t0 = Date.now();
  const runId = db.startRun();
  const isFirstRun = db.getPrevRunId(runId) === null;
  const stats = { collected: 0, candidates: 0, passed: 0, newKeywords: 0, notified: 0, errors: [] };

  try {
    const { items, errors } = await collectAll(collectors);
    stats.errors.push(...errors);
    stats.collected = items.length;

    let groups = scorer.groupItems(items);
    categoryFilter.apply(groups);

    const pre = await articleMatcher.enrich(groups.filter((g) => g.label === null));
    stats.errors.push(...pre.errors);

    const ai = await aiClassifier.classify(groups);
    stats.errors.push(...ai.errors);

    // 카테고리로 제외된 헤드라인(주제어 없음)은 버리고, 같은 주제끼리 병합
    groups = groups.filter((g) => !(g.isHeadline && !g.topic));
    groups = scorer.mergeByKeyword(groups);

    const post = await articleMatcher.enrich(groups.filter((g) => g.label === '정보성'));
    stats.errors.push(...post.errors);

    scorer.finalize(groups);
    stats.candidates = groups.length;
    stats.passed = groups.filter((g) => g.label === '정보성').length;

    const { newCount, queue, suppressedFirstRun } = scorer.applyDiff(groups, runId, { isFirstRun });
    stats.newKeywords = newCount;
    if (suppressedFirstRun) log('cycle', '첫 실행이라 알림 없이 기준선만 저장 (NOTIFY_ON_FIRST_RUN=true 로 변경 가능)');

    if (queue.length) {
      if (dryRun || !telegram.enabled()) {
        for (const g of queue) log('cycle', `[알림 대상${dryRun ? ' · dry-run' : ''}] ${g.keyword} (${g.sources.join(',')}, ${g.score})`);
      } else {
        const r = await telegram.sendAlerts(queue);
        stats.notified = r.sent;
        stats.errors.push(...r.errors);
      }
    }

    lastSummary = { runId, at: new Date().toISOString(), ms: Date.now() - t0, ...stats, queue: queue.map((g) => g.keyword) };
    log(
      'cycle',
      `#${runId} 완료 ${Date.now() - t0}ms · 수집 ${stats.collected} · 후보 ${stats.candidates} · 정보성 ${stats.passed} · 신규 ${stats.newKeywords} · 알림 ${stats.notified}${stats.errors.length ? ` · 오류 ${stats.errors.length}` : ''}`,
    );
    return { ...lastSummary, groups };
  } catch (e) {
    warn('cycle', `주기 실행 실패: ${e.stack || e.message}`);
    stats.errors.push({ stage: 'cycle', message: e.message });
    return null;
  } finally {
    db.finishRun(runId, stats);
    running = false;
  }
}

function statusText() {
  if (!lastSummary) return running ? '첫 수집 실행 중...' : '아직 실행 기록 없음';
  const s = lastSummary;
  return [
    `최근 실행 #${s.runId} (${new Date(s.at).toLocaleString('ko-KR', { timeZone: config.timezone })})`,
    `수집 ${s.collected} · 후보 ${s.candidates} · 정보성 ${s.passed} · 신규 ${s.newKeywords} · 알림 ${s.notified}`,
    s.errors.length ? `오류: ${s.errors.map((e) => e.source || e.stage).join(', ')}` : '오류 없음',
  ].join('\n');
}

function start() {
  if (!cron.validate(config.cronSchedule)) throw new Error(`잘못된 CRON_SCHEDULE: ${config.cronSchedule}`);
  task = cron.schedule(config.cronSchedule, () => runCycle(), {
    timezone: config.timezone,
    noOverlap: true,
    name: 'trend-cycle',
  });
  // 하루 한 번 오래된 이력 정리
  cron.schedule('17 4 * * *', () => db.prune(30), { timezone: config.timezone, name: 'prune' });
  log('scheduler', `등록: "${config.cronSchedule}" (${config.timezone})`);
  if (config.runOnStart) runCycle();
  return task;
}

function stop() {
  if (task) task.stop();
  task = null;
}

module.exports = { runCycle, start, stop, statusText, isRunning: () => running, getLastSummary: () => lastSummary };
