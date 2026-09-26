// signal.bz류 실검 대체 서비스 크롤러
// 1순위: signal.bz 내부 JSON API, 2순위: HTML 셀렉터 파싱.
// 페이지 구조가 자주 바뀌므로 URL/셀렉터는 아래 상수만 고치면 되도록 분리했다.
const cheerio = require('cheerio');
const { http, warn } = require('../utils');

const SOURCE = 'signalbz';

const ENDPOINTS = {
  api: 'https://api.signal.bz/news/realtime',
  page: 'https://signal.bz/',
};

// HTML 폴백용 셀렉터 (signal.bz 개편 시 여기만 수정)
const SELECTORS = {
  item: '.realtime-rank .rank-layer, .rank-column .rank-layer, ol.rank-list > li',
  rank: '.rank-num, .rank',
  text: '.rank-text, .keyword, a',
};

// API 응답 예: { top10: [{ rank: 1, keyword: "...", state: "n" }], ... }
function parseApi(data) {
  const list = Array.isArray(data) ? data : data && (data.top10 || data.list || data.data || data.keywords);
  if (!Array.isArray(list)) return [];
  return list
    .map((it, i) => ({
      keyword: String(typeof it === 'string' ? it : it.keyword || it.text || it.title || '').trim(),
      source: SOURCE,
      rank: Number(it.rank) || i + 1,
      rawMeta: { kind: 'keyword', state: it.state || null },
    }))
    .filter((it) => it.keyword);
}

function parseHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $(SELECTORS.item).each((i, el) => {
    const $el = $(el);
    const keyword = $el.find(SELECTORS.text).first().text().trim() || $el.text().trim();
    const rank = Number($el.find(SELECTORS.rank).first().text().replace(/\D/g, '')) || i + 1;
    if (keyword) out.push({ keyword: keyword.replace(/^\d+\s*/, ''), source: SOURCE, rank, rawMeta: { kind: 'keyword' } });
  });
  const seen = new Set();
  return out.filter((it) => !seen.has(it.keyword) && seen.add(it.keyword));
}

async function collect() {
  try {
    const { data } = await http.get(ENDPOINTS.api, { headers: { Referer: ENDPOINTS.page, Accept: 'application/json' } });
    const items = parseApi(data);
    if (items.length) return items;
  } catch (e) {
    warn(SOURCE, `API 실패 → HTML 폴백: ${e.message}`);
  }
  const { data: html } = await http.get(ENDPOINTS.page);
  return parseHtml(html);
}

module.exports = { name: SOURCE, collect, parseApi, parseHtml, ENDPOINTS, SELECTORS };
