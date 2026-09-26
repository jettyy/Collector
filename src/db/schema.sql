-- 10분 주기 실행 기록
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  collected INTEGER DEFAULT 0,     -- 수집된 원본 항목 수
  candidates INTEGER DEFAULT 0,    -- 그룹핑 후 후보 키워드 수
  passed INTEGER DEFAULT 0,        -- 정보성 판정 수
  new_keywords INTEGER DEFAULT 0,  -- 신규 등장 수
  notified INTEGER DEFAULT 0,      -- 텔레그램 발송 수
  errors TEXT                      -- JSON 배열: 수집기/단계별 오류
);

-- 키워드 "등장 이력". 같은 키워드가 연속 주기에 계속 잡히면 새 행을 만들지 않고
-- last_seen_at/seen_count만 갱신한다. 한동안 사라졌다 다시 뜨면 새 행.
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  norm_key TEXT NOT NULL,
  sources TEXT,                    -- JSON 배열, 감지된 출처 목록
  score REAL,
  label TEXT,                      -- 정보성 / 제외
  reason TEXT,                     -- 판정 근거 (category:연예, ai, heuristic 등)
  category TEXT,                   -- 네이버 섹션 (있을 때)
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_run_id INTEGER,
  last_run_id INTEGER,
  seen_count INTEGER DEFAULT 1,
  notified INTEGER DEFAULT 0,
  notified_at TEXT,
  status TEXT DEFAULT 'new',       -- new / forwarded / ignored
  published INTEGER DEFAULT 0      -- 대시보드: 블로그 발행 완료 체크
);
CREATE INDEX IF NOT EXISTS idx_keywords_norm ON keywords(norm_key, last_run_id);
CREATE INDEX IF NOT EXISTS idx_keywords_detected ON keywords(detected_at);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER,
  title TEXT,
  url TEXT,
  FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_articles_kw ON articles(keyword_id);

-- AI 판정 캐시: 같은 키워드/헤드라인을 매 주기 다시 분류하지 않도록
CREATE TABLE IF NOT EXISTS label_cache (
  cache_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  topic TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- 관련 기사 검색 캐시 (네이버 검색 API 호출 절약)
CREATE TABLE IF NOT EXISTS article_cache (
  norm_key TEXT PRIMARY KEY,
  articles TEXT NOT NULL,          -- JSON [{title,url}]
  updated_at TEXT NOT NULL
);
