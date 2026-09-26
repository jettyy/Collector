// 키워드별 관련 기사 제목+링크 매칭 (네이버 뉴스 검색 API)
// https://developers.naver.com/docs/serviceapi/search/news/news.md
// 일일 호출 한도(25,000회)를 아끼기 위해 결과를 article_cache 에 캐시한다.
const config = require('../config');
const db = require('../db/db');
const { http, stripTags, warn } = require('../utils');

const ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const CACHE_HOURS = 1;

function parseSearch(data, max = config.naver.articlesPerKeyword) {
  return ((data && data.items) || []).slice(0, max).map((it) => ({
    title: stripTags(it.title),
    url: it.link && it.link.includes('naver.com') ? it.link : it.originallink || it.link,
  }));
}

async function searchNews(query) {
  const { data } = await http.get(ENDPOINT, {
    params: { query, display: Math.max(config.naver.articlesPerKeyword, 5), sort: 'sim' },
    headers: {
      'X-Naver-Client-Id': config.naver.clientId,
      'X-Naver-Client-Secret': config.naver.clientSecret,
    },
  });
  return parseSearch(data);
}

// groups 중 기사가 부족한 그룹에 검색 결과를 채운다 (헤드라인 그룹은 주제어가 정해진 뒤에만)
async function enrich(groups, { onlyMissing = true } = {}) {
  const errors = [];
  if (!config.naver.clientId || !config.naver.clientSecret) return { errors, searched: 0 };
  const want = config.naver.articlesPerKeyword;
  const targets = groups.filter((g) => !g.isHeadline && (!onlyMissing || g.articles.length < want) && g.label !== '제외');

  let searched = 0;
  // 동시 요청은 4개로 제한 (검색 API 초당 호출 제한 대비)
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const g = queue.shift();
      let found = db.getArticleCache(g.normKey, CACHE_HOURS);
      if (!found) {
        try {
          found = await searchNews(g.keyword);
          db.setArticleCache(g.normKey, found);
          searched++;
        } catch (e) {
          const msg = e.response ? `HTTP ${e.response.status}` : e.message;
          if (!errors.length) warn('enrich', `뉴스 검색 실패 (${g.keyword}): ${msg}`);
          errors.push({ stage: 'articleMatcher', keyword: g.keyword, message: msg });
          continue;
        }
      }
      const seen = new Set(g.articles.map((a) => a.url));
      for (const a of found) {
        if (g.articles.length >= want) break;
        if (!seen.has(a.url)) g.articles.push(a);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { errors: errors.slice(0, 5), searched };
}

module.exports = { enrich, searchNews, parseSearch };
