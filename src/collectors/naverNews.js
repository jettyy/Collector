// 네이버 뉴스 크롤러
//  - 섹션 홈(정치/경제/사회/생활문화/세계/IT) 헤드라인: 섹션 메타데이터가 붙어 1차 필터에 쓰인다.
//    헤드라인 = 여러 언론사가 동시에 다루는 기사 묶음(클러스터)이라 그 자체가 급상승 신호다.
//  - 언론사별 랭킹(많이 본 뉴스): 섹션 정보가 없으므로 URL/섹션 헤드라인 매칭으로 섹션을 추정한다.
// 결과 항목의 keyword 는 기사 제목이고, 짧은 주제어는 이후 aiClassifier 가 뽑는다(rawMeta.kind='headline').
const cheerio = require('cheerio');
const config = require('../config');
const { http, cleanHeadline, warn } = require('../utils');

const SOURCE = 'naverNews';

const ENDPOINTS = {
  section: (sid) => `https://news.naver.com/section/${sid}`,
  ranking: 'https://news.naver.com/main/ranking/popularDay.naver',
};

const SECTION_NAMES = {
  100: '정치',
  101: '경제',
  102: '사회',
  103: '생활문화',
  104: '세계',
  105: 'IT',
};

// 네이버 개편 시 여기만 수정
const SELECTORS = {
  headlineItem: '.as_headline .sa_item, .section_article.as_headline li',
  headlineLink: 'a.sa_text_title',
  headlineTitle: '.sa_text_strong',
  headlineCluster: '.sa_text_cluster_num, .sa_text_cluster',
  headlinePress: '.sa_text_press',
  rankingBox: '.rankingnews_box',
  rankingPress: '.rankingnews_name',
  rankingItem: '.rankingnews_list > li',
  rankingLink: 'a.list_title',
};

// n.news.naver.com/mnews/article/015/0005123456 → "015/0005123456"
function articleId(url = '') {
  const m = String(url).match(/article\/(\d{3})\/(\d{6,})/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// URL 만으로 판단 가능한 섹션 (연예/스포츠는 별도 도메인·경로)
function sectionFromUrl(url = '') {
  if (/entertain|\/entertain\//.test(url)) return '연예';
  if (/sports\.news\.naver|\/sports\//.test(url)) return '스포츠';
  const sid = String(url).match(/[?&]sid1?=(\d{3})/);
  return sid ? SECTION_NAMES[sid[1]] || null : null;
}

function parseSection(html, sid) {
  const $ = cheerio.load(html);
  const section = SECTION_NAMES[sid] || null;
  const out = [];
  $(SELECTORS.headlineItem).each((i, el) => {
    const $el = $(el);
    const $a = $el.find(SELECTORS.headlineLink).first();
    const url = $a.attr('href') || '';
    const title = cleanHeadline($el.find(SELECTORS.headlineTitle).first().text() || $a.text());
    if (!title || !url) return;
    const cluster = Number(($el.find(SELECTORS.headlineCluster).first().text().match(/\d+/) || [])[0]) || null;
    out.push({
      keyword: title,
      source: SOURCE,
      rank: i + 1,
      rawMeta: {
        kind: 'headline',
        type: 'section',
        section,
        title,
        url,
        cluster,
        press: $el.find(SELECTORS.headlinePress).first().text().trim() || null,
      },
    });
  });
  const seen = new Set();
  return out.filter((it) => !seen.has(it.rawMeta.url) && seen.add(it.rawMeta.url));
}

function parseRanking(html, perPress = config.naver.rankingPerPress) {
  const $ = cheerio.load(html);
  const out = [];
  $(SELECTORS.rankingBox).each((_, box) => {
    const $box = $(box);
    const press = $box.find(SELECTORS.rankingPress).first().text().trim() || null;
    $box
      .find(SELECTORS.rankingItem)
      .slice(0, perPress)
      .each((i, li) => {
        const $a = $(li).find(SELECTORS.rankingLink).first();
        const url = $a.attr('href') || '';
        const title = cleanHeadline($a.text());
        if (!title || !url) return;
        out.push({
          keyword: title,
          source: SOURCE,
          rank: i + 1,
          rawMeta: { kind: 'headline', type: 'ranking', section: sectionFromUrl(url), title, url, press },
        });
      });
  });
  return out;
}

async function collect() {
  const failures = [];
  const bySection = await Promise.all(
    config.naver.sectionIds.map(async (sid) => {
      try {
        const { data } = await http.get(ENDPOINTS.section(sid));
        return parseSection(data, sid);
      } catch (e) {
        failures.push(`섹션 ${sid}: ${e.message}`);
        return [];
      }
    }),
  );
  const sectionItems = bySection.flat();

  let rankingItems = [];
  try {
    const { data } = await http.get(ENDPOINTS.ranking);
    rankingItems = parseRanking(data);
  } catch (e) {
    failures.push(`랭킹: ${e.message}`);
  }

  const total = config.naver.sectionIds.length + 1;
  if (failures.length === total) throw new Error(`모든 요청 실패 (${failures[0]})`);
  if (failures.length) warn(SOURCE, `일부 실패: ${failures.join(' / ')}`);
  if (!sectionItems.length && !rankingItems.length) throw new Error('네이버 뉴스에서 항목을 하나도 찾지 못함 (셀렉터 확인 필요)');
  return mergeRankingIntoSections(sectionItems, rankingItems);
}

// 섹션 헤드라인이면서 많이 본 뉴스에도 오른 기사는 한 건으로 합치고 ranked 표시 (중복 가점 방지)
function mergeRankingIntoSections(sectionItems, rankingItems) {
  const byArticle = new Map(sectionItems.map((it) => [articleId(it.rawMeta.url), it]));
  const rest = [];
  for (const it of rankingItems) {
    const same = byArticle.get(articleId(it.rawMeta.url));
    if (same) same.rawMeta.ranked = true;
    else rest.push(it);
  }
  return [...sectionItems, ...rest];
}

module.exports = {
  name: SOURCE,
  collect,
  parseSection,
  parseRanking,
  mergeRankingIntoSections,
  sectionFromUrl,
  articleId,
  ENDPOINTS,
  SELECTORS,
  SECTION_NAMES,
};
