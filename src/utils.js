const axios = require('axios');
const config = require('./config');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: config.httpTimeoutMs,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  },
});

function log(scope, ...args) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: config.timezone });
  console.log(`[${ts}] [${scope}]`, ...args);
}
function warn(scope, ...args) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: config.timezone });
  console.warn(`[${ts}] [${scope}]`, ...args);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return m;
  });
}

function stripTags(s = '') {
  return decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// 비교용 키: 소문자, 공백/문장부호 제거. "아이폰 17" == "아이폰17"
function normalizeKeyword(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 뉴스 제목에서 [단독], (종합) 같은 말머리 제거
function cleanHeadline(s = '') {
  return stripTags(s)
    .replace(/^(\s*[[(【<〈][^\])】>〉]{1,12}[\])】>〉]\s*)+/, '')
    .replace(/\s*[[(【<〈](종합|속보|단독|영상|포토|사진|인터뷰|르포|이슈)[^\])】>〉]*[\])】>〉]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { http, USER_AGENT, log, warn, decodeEntities, stripTags, normalizeKeyword, cleanHeadline, escapeHtml, nowIso };
