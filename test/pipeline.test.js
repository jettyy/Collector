const { kw, headline, fixture } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db/db');
const scorer = require('../src/scoring/scorer');
const categoryFilter = require('../src/filters/categoryFilter');
const aiClassifier = require('../src/filters/aiClassifier');
const telegram = require('../src/notify/telegramBot');
const { ALL } = require('../src/collectors');
const scheduler = require('../src/scheduler');
const googleTrends = require('../src/collectors/googleTrends');
const { normalizeKeyword, cleanHeadline } = require('../src/utils');

test('utils: 키워드 정규화 / 헤드라인 정리', () => {
  assert.equal(normalizeKeyword('아이폰 17!'), normalizeKeyword('아이폰17'));
  assert.equal(cleanHeadline('[속보] 금리 인하 (종합)'), '금리 인하');
  assert.equal(cleanHeadline('<b>청년</b> &amp; 계좌'), '청년 & 계좌');
});

test('scorer: 출처 교차 그룹핑 + 헤드라인은 포함된 가장 긴 키워드에 붙음', () => {
  const groups = scorer.groupItems([
    kw('환율', 'googleTrends', 2),
    kw('환 율', 'signalbz', 5),
    kw('원달러 환율', 'signalbz', 1),
    headline('원달러 환율 1400원 돌파', '경제', 'https://n/1'),
    headline('주담대 금리 하락', '경제', 'https://n/2'),
  ]);
  const byKey = Object.fromEntries(groups.map((g) => [g.normKey, g]));
  assert.equal(byKey['환율'].items.length, 2);
  assert.equal(byKey['원달러환율'].items.length, 2, '헤드라인은 더 긴 "원달러 환율" 그룹에 붙어야 함');
  assert.ok(byKey['h:주담대금리하락'].isHeadline);
});

test('scorer: 교차 출처일수록 점수 상승', () => {
  const [single] = scorer.finalize(scorer.groupItems([kw('환율', 'googleTrends', 1)]));
  const [cross] = scorer.finalize(scorer.groupItems([kw('환율', 'googleTrends', 1), kw('환율', 'signalbz', 1)]));
  assert.ok(cross.score > single.score * 1.5, `${cross.score} vs ${single.score}`);
  assert.deepEqual(cross.sources.sort(), ['googleTrends', 'signalbz']);
});

test('categoryFilter: 섹션 메타 기반 제외/포함/검토', () => {
  const [ent, eco, soc, none, kwWithPol] = [
    [headline('아이돌 열애', '연예', 'u1')],
    [headline('금리 하락', '경제', 'u2')],
    [headline('독감 유행', '사회', 'u3')],
    [kw('제습기', 'naverDatalab')],
    [kw('환율', 'googleTrends'), headline('대통령 환율 대책', '정치', 'u4')],
  ].map((items) => ({ items }));
  assert.equal(categoryFilter.evaluate(ent).decision, 'exclude');
  assert.equal(categoryFilter.evaluate(eco).decision, 'include');
  assert.equal(categoryFilter.evaluate(soc).decision, 'review');
  assert.equal(categoryFilter.evaluate(none).decision, 'review');
  assert.equal(categoryFilter.evaluate(kwWithPol).decision, 'review', '다른 출처가 있으면 정치 기사 1건 매칭으로 제외하지 않음');
});

test('aiClassifier: API 키 없으면 휴리스틱 판정 + 헤드라인 주제어 추출', async () => {
  db.init(':memory:');
  const groups = scorer.groupItems([
    kw('아이돌A 열애', 'googleTrends'),
    kw('전기요금 인상', 'signalbz'),
    headline('독감 백신 무료접종 시작, 대상은?', '사회', 'u1'),
  ]);
  categoryFilter.apply(groups);
  await aiClassifier.classify(groups);
  const byKw = Object.fromEntries(groups.map((g) => [g.keyword, g]));
  assert.equal(byKw['아이돌A 열애'].label, '제외');
  assert.equal(byKw['전기요금 인상'].label, '정보성');
  const h = groups.find((g) => g.isHeadline);
  assert.equal(h.label, '정보성');
  assert.equal(h.topic, '독감 백신 무료접종');
  assert.equal(h.reason, 'heuristic');
});

test('aiClassifier: 판정 캐시가 있으면 재사용', async () => {
  db.init(':memory:');
  db.setLabelCache('k:전기요금인상', { label: '제외', topic: '전기요금 인상', reason: 'ai' });
  const groups = scorer.groupItems([kw('전기요금 인상', 'signalbz')]);
  categoryFilter.apply(groups);
  await aiClassifier.classify(groups);
  assert.equal(groups[0].label, '제외');
  assert.equal(groups[0].reason, 'ai');
});

test('aiClassifier: 요청 본문에 키워드/헤드라인 구분과 기사 제목 포함', () => {
  const groups = scorer.groupItems(googleTrends.parseRss(fixture('googleTrends.xml')));
  const body = aiClassifier.buildUserContent(groups.map((g) => ({ g })));
  assert.match(body, /"type": "keyword"/);
  assert.match(body, /청년도약계좌 정부 기여금 확대/);
});

test('scorer.applyDiff: 신규만 알림, 연속 감지는 갱신, 재알림 방지', () => {
  db.init(':memory:');
  const make = (items) => {
    const groups = scorer.groupItems(items);
    for (const g of groups) g.label = '정보성';
    return scorer.finalize(groups);
  };

  // 1회차: 환율(단일 출처, 점수 충분) → 알림
  let run = db.startRun();
  let r = scorer.applyDiff(make([kw('환율', 'googleTrends', 1), kw('제습기', 'naverDatalab', 1)]), run, { isFirstRun: true });
  assert.deepEqual(r.queue.map((g) => g.keyword), ['환율'], '데이터랩 단독(0.6)은 기준 미달');
  for (const g of r.queue) db.markNotified(g.id);
  db.finishRun(run, {});

  // 2회차: 환율 계속 → 신규 아님, 제습기가 교차 확인되며 기준 초과 → 승격 알림
  run = db.startRun();
  r = scorer.applyDiff(make([kw('환율', 'googleTrends', 1), kw('제습기', 'naverDatalab', 1), kw('제습기', 'signalbz', 3)]), run);
  assert.equal(r.newCount, 0);
  assert.deepEqual(r.queue.map((g) => [g.keyword, g.isNew]), [['제습기', false]]);
  db.finishRun(run, {});
  const rows = db.listKeywords({ hours: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((k) => k.keyword === '환율').seen_count, 2);

  // 3회차: 환율 사라짐 → 4회차 재등장: 새 행이지만 6시간 내 알림 이력 → 알림 X
  run = db.startRun();
  scorer.applyDiff(make([kw('제습기', 'naverDatalab', 1)]), run);
  db.finishRun(run, {});
  run = db.startRun();
  r = scorer.applyDiff(make([kw('환율', 'googleTrends', 1)]), run);
  assert.equal(r.newCount, 1);
  assert.equal(r.queue.length, 0);
});

test('telegram: 메시지 포맷과 버튼', () => {
  const text = telegram.formatMessage({
    keyword: '환율 <급등>',
    sources: ['googleTrends', 'naverNews'],
    score: 2.5,
    category: '경제',
    articles: [{ title: 'A&B', url: 'https://x/?a=1&b=2' }],
  });
  assert.match(text, /신규 트렌드: 환율 &lt;급등&gt;/);
  assert.match(text, /출처: 구글트렌드, 네이버뉴스 \(교차 2건\)/);
  assert.match(text, /<a href="https:\/\/x\/\?a=1&amp;b=2">A&amp;B<\/a>/);
  const kb = telegram.buildKeyboard(7);
  assert.equal(kb.inline_keyboard.at(-1)[0].callback_data, 'ign:7');
});

test('scheduler.runCycle: 수집기 stub 으로 전체 파이프라인 (dry-run)', async () => {
  db.init(':memory:');
  const orig = {};
  const stubs = {
    googleTrends: async () => googleTrends.parseRss(fixture('googleTrends.xml')),
    naverNews: async () => {
      const n = require('../src/collectors/naverNews');
      return n.mergeRankingIntoSections(n.parseSection(fixture('naverSection101.html'), '101'), n.parseRanking(fixture('naverRanking.html'), 3));
    },
    signalbz: async () => {
      throw new Error('차단됨');
    },
    naverDatalab: async () => [],
  };
  for (const [name, fn] of Object.entries(stubs)) {
    orig[name] = ALL[name].collect;
    ALL[name].collect = fn;
  }
  try {
    const r = await scheduler.runCycle({ dryRun: true, collectors: Object.keys(stubs) });
    assert.ok(r, '실행 결과가 있어야 함');
    const byKw = Object.fromEntries(r.groups.map((g) => [g.keyword, g]));
    assert.equal(byKw['환율'].label, '정보성');
    assert.deepEqual(byKw['환율'].sources.sort(), ['googleTrends', 'naverNews']);
    assert.equal(byKw['아이돌A 열애'].label, '제외');
    assert.ok(!r.groups.some((g) => g.keyword.includes('손흥민')), '스포츠 헤드라인은 저장 대상에서 빠짐');
    assert.ok(r.errors.some((e) => e.source === 'signalbz'), '실패한 수집기는 오류로만 기록');
    assert.ok(r.queue.includes('환율'));
    const runs = db.listRuns(1);
    assert.ok(runs[0].finished_at);
    assert.ok(db.listKeywords({ hours: 1, label: '정보성' }).some((k) => k.keyword === '환율' && k.articles.length > 0));
  } finally {
    for (const [name, fn] of Object.entries(orig)) ALL[name].collect = fn;
  }
});

test('scorer.applyDiff: 첫 실행 기준선은 다음 주기에도 알림으로 쏟아지지 않음', () => {
  db.init(':memory:');
  const make = (items) => {
    const groups = scorer.groupItems(items);
    for (const g of groups) g.label = '정보성';
    return scorer.finalize(groups);
  };
  const origFirst = require('../src/config').scoring.notifyOnFirstRun;
  require('../src/config').scoring.notifyOnFirstRun = false;
  try {
    let run = db.startRun();
    let r = scorer.applyDiff(make([kw('환율', 'googleTrends', 1)]), run, { isFirstRun: true });
    assert.equal(r.queue.length, 0);
    assert.ok(r.suppressedFirstRun);
    db.finishRun(run, {});
    run = db.startRun();
    r = scorer.applyDiff(make([kw('환율', 'googleTrends', 1), kw('금리', 'googleTrends', 2)]), run);
    assert.deepEqual(r.queue.map((g) => g.keyword), ['금리']);
  } finally {
    require('../src/config').scoring.notifyOnFirstRun = origFirst;
  }
});

test('naverNews: 섹션 헤드라인과 같은 랭킹 기사는 하나로 합치고 ranked 표시', () => {
  const n = require('../src/collectors/naverNews');
  const items = n.mergeRankingIntoSections(n.parseSection(fixture('naverSection101.html'), '101'), n.parseRanking(fixture('naverRanking.html'), 3));
  assert.equal(items.filter((i) => i.keyword.includes('환율')).length, 1);
  assert.equal(items.find((i) => i.keyword.includes('환율')).rawMeta.ranked, true);
});

test('telegram: 버튼 콜백 → 상태 저장, 다른 방의 콜백은 거부', async () => {
  db.init(':memory:');
  const config = require('../src/config');
  const run = db.startRun();
  const id = db.insertKeyword({ keyword: '환율', normKey: '환율', sources: ['googleTrends'], score: 2, label: '정보성', runId: run });
  const answers = [];
  const ctx = (chatId, data) => ({
    callbackQuery: { data, message: { chat: { id: chatId }, message_id: 1 } },
    answerCallbackQuery: async (o) => answers.push(o),
  });
  const orig = config.telegram.chatId;
  config.telegram.chatId = '111';
  try {
    await telegram.handleCallback(ctx(999, `ign:${id}`));
    assert.equal(db.getKeyword(id).status, 'new');
    assert.equal(answers.at(-1).text, '권한 없음');
    await telegram.handleCallback(ctx(111, `fwd:${id}:0`));
    assert.match(answers.at(-1).text, /BLOG_BOT_CHATS/);
  } finally {
    config.telegram.chatId = orig;
  }
});

test('config: BLOG_BOT_CHATS 파싱', () => {
  const { parseBlogChats } = require('../src/config');
  assert.deepEqual(parseBlogChats('요리봇:-100123, -100456'), [
    { name: '요리봇', chatId: '-100123' },
    { name: '블로그봇2', chatId: '-100456' },
  ]);
});
