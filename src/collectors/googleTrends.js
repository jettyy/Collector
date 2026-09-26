// 구글 트렌드 실시간 인기 검색어 (한국)
// google-trends-api 패키지의 realTimeTrends 엔드포인트는 구글 쪽 변경으로 더 이상 동작하지 않아
// 공식 "Trending now" RSS 피드를 파싱한다. 항목마다 관련 뉴스 제목/링크가 함께 온다.
const cheerio = require('cheerio');
const { http, stripTags } = require('../utils');

const SOURCE = 'googleTrends';

const ENDPOINTS = {
  rss: 'https://trends.google.com/trending/rss?geo=KR',
};

// RSS 태그 이름 (네임스페이스 ht:)
const TAGS = {
  item: 'item',
  title: 'title',
  traffic: 'ht\\:approx_traffic',
  newsItem: 'ht\\:news_item',
  newsTitle: 'ht\\:news_item_title',
  newsUrl: 'ht\\:news_item_url',
  newsSource: 'ht\\:news_item_source',
};

// "2,000+" / "1만+" → 2000 / 10000
function parseTraffic(s = '') {
  const t = String(s).replace(/[,+\s]/g, '');
  const m = t.match(/^([\d.]+)(만|천|K|M)?$/i);
  if (!m) return null;
  const mult = { 만: 10000, 천: 1000, k: 1000, m: 1000000 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function parseRss(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const out = [];
  $(TAGS.item).each((i, el) => {
    const $el = $(el);
    const keyword = stripTags($el.children(TAGS.title).first().text());
    if (!keyword) return;
    const articles = [];
    $el.find(TAGS.newsItem).each((_, n) => {
      const $n = $(n);
      const title = stripTags($n.find(TAGS.newsTitle).first().text());
      const url = $n.find(TAGS.newsUrl).first().text().trim();
      if (title && url) articles.push({ title, url, press: $n.find(TAGS.newsSource).first().text().trim() || null });
    });
    out.push({
      keyword,
      source: SOURCE,
      rank: i + 1,
      rawMeta: { kind: 'keyword', traffic: parseTraffic($el.find(TAGS.traffic).first().text()), articles },
    });
  });
  return out;
}

async function collect() {
  const { data } = await http.get(ENDPOINTS.rss, { responseType: 'text' });
  return parseRss(data);
}

module.exports = { name: SOURCE, collect, parseRss, parseTraffic, ENDPOINTS };
