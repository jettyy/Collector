const { fixture } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const googleTrends = require('../src/collectors/googleTrends');
const naverNews = require('../src/collectors/naverNews');
const signalbz = require('../src/collectors/signalbz');
const naverDatalab = require('../src/collectors/naverDatalab');

test('googleTrends: RSS 파싱 (키워드, 트래픽, 관련 기사)', () => {
  const items = googleTrends.parseRss(fixture('googleTrends.xml'));
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => [i.keyword, i.rank, i.rawMeta.traffic]),
    [
      ['청년도약계좌', 1, 20000],
      ['환율', 2, 5000],
      ['아이돌A 열애', 3, 50000],
    ],
  );
  assert.equal(items[0].rawMeta.articles.length, 2);
  assert.equal(items[0].rawMeta.articles[0].title, "청년도약계좌 10월 신청 시작'… 소득 기준 완화");
  assert.equal(items[0].rawMeta.articles[1].title, '청년도약계좌 정부 기여금 확대');
  assert.equal(items[2].rawMeta.articles.length, 0);
});

test('googleTrends: 트래픽 문자열 변환', () => {
  assert.equal(googleTrends.parseTraffic('2,000+'), 2000);
  assert.equal(googleTrends.parseTraffic('1만+'), 10000);
  assert.equal(googleTrends.parseTraffic(''), null);
});

test('naverNews: 섹션 헤드라인만 파싱하고 말머리 제거, 섹션 메타 부여', () => {
  const items = naverNews.parseSection(fixture('naverSection101.html'), '101');
  assert.equal(items.length, 2);
  assert.equal(items[0].keyword, '원달러 환율 1400원 돌파…수입물가 비상');
  assert.equal(items[0].rawMeta.section, '경제');
  assert.equal(items[0].rawMeta.kind, 'headline');
  assert.equal(items[0].rawMeta.cluster, 42);
  assert.equal(items[0].rawMeta.press, '한국경제');
});

test('naverNews: 랭킹 파싱 (언론사별 상위 N, URL 로 연예/스포츠 판별)', () => {
  const items = naverNews.parseRanking(fixture('naverRanking.html'), 3);
  assert.equal(items.length, 4);
  assert.equal(items[0].rawMeta.press, '한국경제');
  assert.equal(items[1].rawMeta.section, '연예');
  assert.equal(items[2].rawMeta.section, null);
  assert.equal(items[3].rawMeta.section, '스포츠');
});

test('naverNews: 기사 id 추출', () => {
  assert.equal(naverNews.articleId('https://n.news.naver.com/mnews/article/015/0005000001'), '015/0005000001');
  assert.equal(naverNews.articleId('https://n.news.naver.com/article/015/0005000001?ntype=RANKING'), '015/0005000001');
});

test('signalbz: API 응답 파싱', () => {
  const items = signalbz.parseApi({ top10: [{ rank: 1, keyword: '전기요금 인상', state: 'n' }, { rank: 2, keyword: ' ' }, { rank: 3, keyword: '독감 백신' }] });
  assert.deepEqual(items.map((i) => [i.keyword, i.rank]), [['전기요금 인상', 1], ['독감 백신', 3]]);
});

test('signalbz: HTML 폴백 파싱', () => {
  const html = `<div class="realtime-rank"><div class="rank-layer"><span class="rank-num">1</span><span class="rank-text">전기요금 인상</span></div>
    <div class="rank-layer"><span class="rank-num">2</span><span class="rank-text">독감 백신</span></div></div>`;
  assert.deepEqual(signalbz.parseHtml(html).map((i) => [i.keyword, i.rank]), [['전기요금 인상', 1], ['독감 백신', 2]]);
});

test('naverDatalab: 순위 응답 파싱', () => {
  const items = naverDatalab.parseRanks({ ranks: [{ rank: 1, keyword: '제습기' }, { rank: 2, keyword: '선풍기' }] }, '50000003');
  assert.deepEqual(items.map((i) => [i.keyword, i.rawMeta.datalabCategory]), [['제습기', '디지털/가전'], ['선풍기', '디지털/가전']]);
});
