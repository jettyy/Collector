// 환경변수 → 설정 객체. 모든 모듈은 process.env 대신 여기서 값을 읽는다.
const path = require('path');
require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');

function str(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v.trim();
}
function num(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' ? n : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}
function list(name, def = []) {
  const v = str(name);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def;
}

// "블로그봇1:-100123,블로그봇2:-100456" → [{ name, chatId }]
function parseBlogChats(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const idx = entry.lastIndexOf(':');
      if (idx > 0 && /^-?\d+$/.test(entry.slice(idx + 1).trim())) {
        return { name: entry.slice(0, idx).trim(), chatId: entry.slice(idx + 1).trim() };
      }
      return { name: `블로그봇${i + 1}`, chatId: entry };
    });
}

const config = {
  root: ROOT,
  port: num('PORT', 3000),
  host: str('HOST', '127.0.0.1'),
  dbPath: path.resolve(ROOT, str('DB_PATH', 'data/trend.db')),

  cronSchedule: str('CRON_SCHEDULE', '*/10 * * * *'),
  timezone: str('TZ_NAME', 'Asia/Seoul'),
  runOnStart: bool('RUN_ON_START', true),

  collectors: list('ENABLED_COLLECTORS', ['signalbz', 'googleTrends', 'naverNews', 'naverDatalab']),
  httpTimeoutMs: num('HTTP_TIMEOUT_MS', 15000),

  naver: {
    clientId: str('NAVER_CLIENT_ID'),
    clientSecret: str('NAVER_CLIENT_SECRET'),
    // 네이버 뉴스 섹션: 100 정치, 101 경제, 102 사회, 103 생활/문화, 104 세계, 105 IT/과학
    sectionIds: list('NAVER_SECTION_IDS', ['100', '101', '102', '103', '104', '105']),
    rankingPerPress: num('NAVER_RANKING_PER_PRESS', 3),
    // 쇼핑인사이트 카테고리 cid (기본: 디지털/가전, 생활/건강, 식품)
    datalabCategories: list('NAVER_DATALAB_CATEGORIES', ['50000003', '50000008', '50000006']),
    datalabTopN: num('NAVER_DATALAB_TOP_N', 10),
    articlesPerKeyword: num('ARTICLES_PER_KEYWORD', 3),
  },

  filter: {
    excludePolitics: bool('EXCLUDE_POLITICS', true),
    excludeWorld: bool('EXCLUDE_WORLD', false),
  },

  ai: {
    // cli: Claude Code CLI(claude -p)로 구독 계정(Pro/Max) 사용 · api: ANTHROPIC_API_KEY 과금 · off: 휴리스틱만
    provider: str('AI_PROVIDER', 'cli').toLowerCase(),
    maxItemsPerCall: num('AI_MAX_ITEMS_PER_CALL', 80),
    labelCacheHours: num('LABEL_CACHE_HOURS', 12),
    cli: {
      path: str('CLAUDE_CLI_PATH', 'claude'),
      model: str('CLAUDE_MODEL'), // 비우면 Claude Code 기본 모델 (예: opus, sonnet, haiku)
      effort: str('CLAUDE_EFFORT', 'low'),
      timeoutMs: num('CLAUDE_CLI_TIMEOUT_MS', 180000),
    },
    api: {
      key: str('ANTHROPIC_API_KEY'),
      model: str('ANTHROPIC_MODEL', 'claude-opus-5'),
      effort: str('ANTHROPIC_EFFORT', 'low'),
    },
  },

  scoring: {
    minScoreToNotify: num('MIN_SCORE_TO_NOTIFY', 1.2),
    renotifyHours: num('RENOTIFY_HOURS', 6),
    maxAlertsPerRun: num('MAX_ALERTS_PER_RUN', 5),
    notifyOnFirstRun: bool('NOTIFY_ON_FIRST_RUN', false),
  },

  telegram: {
    token: str('TELEGRAM_BOT_TOKEN'),
    chatId: str('TELEGRAM_CHAT_ID'),
    blogChats: parseBlogChats(str('BLOG_BOT_CHATS')),
    polling: bool('TELEGRAM_POLLING', true),
    apiRoot: str('TELEGRAM_API_ROOT'), // 로컬 Bot API 서버 사용 시
  },
};

module.exports = config;
module.exports.parseBlogChats = parseBlogChats;
