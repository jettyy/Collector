// 테스트는 외부 API 를 절대 호출하지 않도록 키를 비운 상태로 설정을 로드한다.
// (dotenv 는 이미 정의된 환경변수를 덮어쓰지 않으므로 로컬 .env 가 있어도 안전)
Object.assign(process.env, {
  ANTHROPIC_API_KEY: '',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  NAVER_CLIENT_ID: '',
  NAVER_CLIENT_SECRET: '',
  NOTIFY_ON_FIRST_RUN: 'true',
  MIN_SCORE_TO_NOTIFY: '1.2',
  RENOTIFY_HOURS: '6',
  MAX_ALERTS_PER_RUN: '5',
  EXCLUDE_POLITICS: 'true',
});

const fs = require('fs');
const path = require('path');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const kw = (keyword, source, rank = 1, meta = {}) => ({ keyword, source, rank, rawMeta: { kind: 'keyword', ...meta } });
const headline = (title, section, url, meta = {}) => ({
  keyword: title,
  source: 'naverNews',
  rank: 1,
  rawMeta: { kind: 'headline', type: 'section', section, title, url, ...meta },
});

module.exports = { fixture, kw, headline };
