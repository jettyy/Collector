const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { nowIso } = require('../utils');

let db = null;

// dbPath 생략 시 config.dbPath. 테스트에서는 ':memory:'
function init(dbPath = config.dbPath) {
  if (db) db.close();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function conn() {
  return db || init();
}

function close() {
  if (db) db.close();
  db = null;
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

const parseJson = (s, def) => {
  try {
    return s ? JSON.parse(s) : def;
  } catch {
    return def;
  }
};

// ---------- runs ----------

function startRun() {
  const info = conn().prepare('INSERT INTO runs (started_at) VALUES (?)').run(nowIso());
  return Number(info.lastInsertRowid);
}

function finishRun(id, stats) {
  conn()
    .prepare(
      `UPDATE runs SET finished_at=@finished_at, collected=@collected, candidates=@candidates,
       passed=@passed, new_keywords=@new_keywords, notified=@notified, errors=@errors WHERE id=@id`,
    )
    .run({
      id,
      finished_at: nowIso(),
      collected: stats.collected || 0,
      candidates: stats.candidates || 0,
      passed: stats.passed || 0,
      new_keywords: stats.newKeywords || 0,
      notified: stats.notified || 0,
      errors: JSON.stringify(stats.errors || []),
    });
}

// 현재 실행 직전에 "정상 종료된" 실행 id
function getPrevRunId(currentRunId) {
  const row = conn()
    .prepare('SELECT id FROM runs WHERE id < ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(currentRunId);
  return row ? row.id : null;
}

function listRuns(limit = 20) {
  return conn()
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, errors: parseJson(r.errors, []) }));
}

// ---------- keywords ----------

function findContinuing(normKey, prevRunId) {
  if (!prevRunId) return null;
  return conn()
    .prepare('SELECT * FROM keywords WHERE norm_key = ? AND last_run_id = ? ORDER BY id DESC LIMIT 1')
    .get(normKey, prevRunId);
}

function insertKeyword(k) {
  const now = nowIso();
  const info = conn()
    .prepare(
      `INSERT INTO keywords (keyword, norm_key, sources, score, label, reason, category,
        detected_at, last_seen_at, first_run_id, last_run_id)
       VALUES (@keyword, @norm_key, @sources, @score, @label, @reason, @category, @now, @now, @run_id, @run_id)`,
    )
    .run({
      keyword: k.keyword,
      norm_key: k.normKey,
      sources: JSON.stringify(k.sources || []),
      score: k.score ?? null,
      label: k.label ?? null,
      reason: k.reason ?? null,
      category: k.category ?? null,
      run_id: k.runId,
      now,
    });
  const id = Number(info.lastInsertRowid);
  insertArticles(id, k.articles || []);
  return id;
}

function touchKeyword(id, k) {
  const row = conn().prepare('SELECT sources, score FROM keywords WHERE id = ?').get(id);
  const sources = Array.from(new Set([...parseJson(row.sources, []), ...(k.sources || [])]));
  conn()
    .prepare(
      `UPDATE keywords SET last_seen_at=?, last_run_id=?, seen_count=seen_count+1,
       sources=?, score=MAX(COALESCE(score,0), ?), label=COALESCE(?, label), reason=COALESCE(?, reason) WHERE id=?`,
    )
    .run(nowIso(), k.runId, JSON.stringify(sources), k.score ?? 0, k.label ?? null, k.reason ?? null, id);
  const hasArticles = conn().prepare('SELECT 1 FROM articles WHERE keyword_id = ? LIMIT 1').get(id);
  if (!hasArticles) insertArticles(id, k.articles || []);
}

function insertArticles(keywordId, articles) {
  const stmt = conn().prepare('INSERT INTO articles (keyword_id, title, url) VALUES (?, ?, ?)');
  for (const a of articles) stmt.run(keywordId, a.title, a.url);
}

function wasNotifiedRecently(normKey, hours) {
  return !!conn()
    .prepare('SELECT 1 FROM keywords WHERE norm_key = ? AND notified = 1 AND notified_at >= ? LIMIT 1')
    .get(normKey, hoursAgoIso(hours));
}

function markNotified(id) {
  conn().prepare('UPDATE keywords SET notified = 1, notified_at = ? WHERE id = ?').run(nowIso(), id);
}

function setStatus(id, status) {
  return conn().prepare('UPDATE keywords SET status = ? WHERE id = ?').run(status, id).changes;
}

function setPublished(id, published) {
  return conn().prepare('UPDATE keywords SET published = ? WHERE id = ?').run(published ? 1 : 0, id).changes;
}

function hydrate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const arts = conn()
    .prepare(`SELECT keyword_id, title, url FROM articles WHERE keyword_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids);
  const byId = new Map();
  for (const a of arts) {
    if (!byId.has(a.keyword_id)) byId.set(a.keyword_id, []);
    byId.get(a.keyword_id).push({ title: a.title, url: a.url });
  }
  return rows.map((r) => ({
    ...r,
    sources: parseJson(r.sources, []),
    notified: !!r.notified,
    published: !!r.published,
    articles: byId.get(r.id) || [],
  }));
}

function getKeyword(id) {
  const row = conn().prepare('SELECT * FROM keywords WHERE id = ?').get(id);
  return row ? hydrate([row])[0] : null;
}

// 대시보드 목록. source 필터는 JSON 배열 문자열 LIKE로 처리 (출처 이름이 고정 영문이라 안전)
function listKeywords({ hours = 24, label, sources, notifiedOnly = false, limit = 200 } = {}) {
  const where = ['detected_at >= @since'];
  const params = { since: hoursAgoIso(hours), limit };
  if (label) {
    where.push('label = @label');
    params.label = label;
  }
  if (notifiedOnly) where.push('notified = 1');
  if (sources && sources.length) {
    const ors = sources.map((s, i) => {
      params[`src${i}`] = `%"${s}"%`;
      return `sources LIKE @src${i}`;
    });
    where.push(`(${ors.join(' OR ')})`);
  }
  const rows = conn()
    .prepare(
      `SELECT * FROM keywords WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(notified_at, detected_at) DESC, id DESC LIMIT @limit`,
    )
    .all(params);
  return hydrate(rows);
}

// 시간대별 신규 감지량 (epoch 시간 단위 버킷 → 클라이언트가 로컬 시간으로 표시)
function hourlyStats(hours = 24) {
  const rows = conn()
    .prepare('SELECT detected_at, label, notified FROM keywords WHERE detected_at >= ?')
    .all(hoursAgoIso(hours));
  const buckets = new Map();
  const nowHour = Math.floor(Date.now() / 3600000);
  for (let h = nowHour - hours + 1; h <= nowHour; h++) buckets.set(h, { hour: h * 3600000, info: 0, excluded: 0, notified: 0 });
  for (const r of rows) {
    const b = buckets.get(Math.floor(Date.parse(r.detected_at) / 3600000));
    if (!b) continue;
    if (r.label === '정보성') b.info++;
    else b.excluded++;
    if (r.notified) b.notified++;
  }
  return Array.from(buckets.values());
}

function sourceStats(hours = 24) {
  const rows = conn().prepare('SELECT sources, label FROM keywords WHERE detected_at >= ?').all(hoursAgoIso(hours));
  const out = {};
  for (const r of rows) {
    for (const s of parseJson(r.sources, [])) {
      out[s] = out[s] || { total: 0, info: 0 };
      out[s].total++;
      if (r.label === '정보성') out[s].info++;
    }
  }
  return out;
}

// ---------- caches ----------

function getLabelCache(key, maxAgeHours) {
  return (
    conn().prepare('SELECT * FROM label_cache WHERE cache_key = ? AND updated_at >= ?').get(key, hoursAgoIso(maxAgeHours)) ||
    null
  );
}

function setLabelCache(key, { label, topic, reason }) {
  conn()
    .prepare(
      `INSERT INTO label_cache (cache_key, label, topic, reason, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET label=excluded.label, topic=excluded.topic,
       reason=excluded.reason, updated_at=excluded.updated_at`,
    )
    .run(key, label, topic ?? null, reason ?? null, nowIso());
}

function getArticleCache(normKey, maxAgeHours) {
  const row = conn()
    .prepare('SELECT articles FROM article_cache WHERE norm_key = ? AND updated_at >= ?')
    .get(normKey, hoursAgoIso(maxAgeHours));
  return row ? parseJson(row.articles, null) : null;
}

function setArticleCache(normKey, articles) {
  conn()
    .prepare(
      `INSERT INTO article_cache (norm_key, articles, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(norm_key) DO UPDATE SET articles=excluded.articles, updated_at=excluded.updated_at`,
    )
    .run(normKey, JSON.stringify(articles), nowIso());
}

// 오래된 캐시/이력 정리 (기본 30일)
function prune(days = 30) {
  const since = hoursAgoIso(days * 24);
  const c = conn();
  c.prepare('DELETE FROM articles WHERE keyword_id IN (SELECT id FROM keywords WHERE detected_at < ?)').run(since);
  c.prepare('DELETE FROM keywords WHERE detected_at < ?').run(since);
  c.prepare('DELETE FROM runs WHERE started_at < ?').run(since);
  c.prepare('DELETE FROM label_cache WHERE updated_at < ?').run(hoursAgoIso(72));
  c.prepare('DELETE FROM article_cache WHERE updated_at < ?').run(hoursAgoIso(72));
}

module.exports = {
  init,
  close,
  conn,
  startRun,
  finishRun,
  getPrevRunId,
  listRuns,
  findContinuing,
  insertKeyword,
  touchKeyword,
  wasNotifiedRecently,
  markNotified,
  setStatus,
  setPublished,
  getKeyword,
  listKeywords,
  hourlyStats,
  sourceStats,
  getLabelCache,
  setLabelCache,
  getArticleCache,
  setArticleCache,
  prune,
};
