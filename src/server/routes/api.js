// 대시보드용 API
const express = require('express');
const db = require('../../db/db');
const scheduler = require('../../scheduler');
const { SOURCE_LABELS } = require('../../scoring/scorer');
const config = require('../../config');
const claude = require('../../filters/claudeClient');

const router = express.Router();

const clampHours = (v, def = 24) => Math.min(Math.max(Number(v) || def, 1), 24 * 30);

// GET /api/keywords?hours=24&label=정보성&sources=googleTrends,naverNews&notified=1&limit=200
router.get('/keywords', (req, res) => {
  const sources = String(req.query.sources || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SOURCE_LABELS[s]);
  const label = ['정보성', '제외'].includes(req.query.label) ? req.query.label : undefined;
  res.json(
    db.listKeywords({
      hours: clampHours(req.query.hours),
      label,
      sources,
      notifiedOnly: req.query.notified === '1',
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    }),
  );
});

// PATCH /api/keywords/:id  { published: true } | { status: 'ignored' }
router.patch('/keywords/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  if (!db.getKeyword(id)) return res.status(404).json({ error: 'not found' });
  if (typeof body.published === 'boolean') db.setPublished(id, body.published);
  if (['new', 'forwarded', 'ignored'].includes(body.status)) db.setStatus(id, body.status);
  res.json(db.getKeyword(id));
});

router.get('/stats/hourly', (req, res) => {
  res.json(db.hourlyStats(clampHours(req.query.hours)));
});

router.get('/stats/sources', (req, res) => {
  res.json(db.sourceStats(clampHours(req.query.hours)));
});

router.get('/runs', (req, res) => {
  res.json(db.listRuns(Math.min(Number(req.query.limit) || 20, 200)));
});

router.get('/meta', (req, res) => {
  res.json({
    sources: SOURCE_LABELS,
    collectors: config.collectors,
    cron: config.cronSchedule,
    running: scheduler.isRunning(),
    telegram: !!(config.telegram.token && config.telegram.chatId),
    ai: { provider: config.ai.provider, enabled: claude.enabled(), ...claude.getStatus() },
    naverSearch: !!(config.naver.clientId && config.naver.clientSecret),
  });
});

// POST /api/run  → 즉시 1회 실행 (수동 새로고침)
router.post('/run', (req, res) => {
  if (scheduler.isRunning()) return res.status(409).json({ error: '이미 실행 중' });
  scheduler.runCycle();
  res.status(202).json({ ok: true });
});

module.exports = router;
