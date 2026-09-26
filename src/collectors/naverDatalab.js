// 네이버 데이터랩 인기 검색어
// 네이버 "급상승 검색어"(실검)는 2021년 2월 서비스가 종료되어 공식 수집 경로가 없다.
// 대신 데이터랩 쇼핑인사이트의 분야별 인기 검색어 순위를 수집한다 (생활/가전/식품 등 정보성 주제 위주).
// 일 단위 데이터라 10분마다 크게 바뀌지 않으며, scorer 의 신규 등장 diff 로 새로 진입한 키워드만 알림 대상이 된다.
const { http } = require('../utils');
const config = require('../config');

const SOURCE = 'naverDatalab';

const ENDPOINTS = {
  rank: 'https://datalab.naver.com/shoppingInsight/getCategoryKeywordRank.naver',
  referer: 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
};

const CATEGORY_NAMES = {
  50000000: '패션의류',
  50000001: '패션잡화',
  50000002: '화장품/미용',
  50000003: '디지털/가전',
  50000004: '가구/인테리어',
  50000005: '출산/육아',
  50000006: '식품',
  50000007: '스포츠/레저',
  50000008: '생활/건강',
  50000009: '여가/생활편의',
};

function ymd(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
}

// 응답 예: { ranks: [{ rank: 1, keyword: "...", linkId: "..." }], ... }
function parseRanks(data, cid) {
  const list = (data && (data.ranks || data.result || data.data)) || [];
  if (!Array.isArray(list)) return [];
  return list
    .map((r, i) => ({
      keyword: String(r.keyword || '').trim(),
      source: SOURCE,
      rank: Number(r.rank) || i + 1,
      rawMeta: { kind: 'keyword', datalabCategory: CATEGORY_NAMES[cid] || cid },
    }))
    .filter((r) => r.keyword);
}

async function fetchCategory(cid) {
  const end = new Date(Date.now() - 24 * 3600 * 1000); // 데이터랩은 전일까지 집계
  const body = new URLSearchParams({
    cid,
    timeUnit: 'date',
    startDate: ymd(end),
    endDate: ymd(end),
    age: '',
    gender: '',
    device: '',
    page: '1',
    count: String(config.naver.datalabTopN),
  });
  const { data } = await http.post(ENDPOINTS.rank, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: ENDPOINTS.referer,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  return parseRanks(data, cid);
}

async function collect() {
  const results = await Promise.allSettled(config.naver.datalabCategories.map(fetchCategory));
  const items = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  if (!items.length) {
    const firstErr = results.find((r) => r.status === 'rejected');
    throw new Error(firstErr ? firstErr.reason.message : '데이터랩 응답에 순위가 없음');
  }
  return items;
}

module.exports = { name: SOURCE, collect, parseRanks, ENDPOINTS, CATEGORY_NAMES };
