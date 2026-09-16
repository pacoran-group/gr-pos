const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const masterSync = require('../services/masterSync.service');
const legacyRoomState = require('../services/legacyRoomState.service');
const outboxSender = require('../services/outboxSender.service');
const opnamePuller = require('../services/opnamePuller.service');

const router = express.Router();
router.use(requireAuth);

// POST /api/sync/master - jalankan sinkron master-data 154 -> Server02 sekarang.
// Manual = SEMUA tabel (FAST + SLOW), dengan fingerprint-skip.
router.post('/master', requireRole('admin', 'head_karaoke', 'head_unit', 'supervisor'), async (req, res, next) => {
  try {
    const result = await masterSync.syncMasterData({ trigger: 'manual', scope: 'all' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/sync/master/last - hasil sinkron terakhir (untuk ditampilkan di UI).
router.get('/master/last', async (req, res) => {
  res.json({ last: masterSync.getLastResult() });
});

// GET /api/sync/legacy-rooms - status room menurut cache 154 + room "orphan"
// (aktif di 154 tapi gr-pos tak punya transaksinya - biasanya ditangani
// aplikasi lama saat operasi paralel / Plan B). Untuk panel di dashboard.
router.get('/legacy-rooms', async (req, res, next) => {
  try {
    const [states, orphans] = await Promise.all([
      legacyRoomState.getStates(),
      legacyRoomState.getOrphans(),
    ]);
    res.json({ states, orphans, last_poll: legacyRoomState.getLastPoll() });
  } catch (err) {
    next(err);
  }
});

// POST /api/sync/outbox - kirim baris web_sync_outbox yang belum terkirim ke
// endpoint ingest pusat SEKARANG (selain jadwal berkala worker). 1 tick.
router.post('/outbox', requireRole('admin', 'head_karaoke', 'head_unit', 'supervisor'), async (req, res, next) => {
  try {
    const result = await outboxSender.flushOnce();
    res.json(result || { skipped: 'worker nonaktif / SYNC_SENDER_ENABLED off' });
  } catch (err) {
    next(err);
  }
});

// GET /api/sync/outbox/status - ringkasan antrean outbox pusat (pending, beku,
// terkirim 24 jam, umur baris pending tertua, hasil tick terakhir).
router.get('/outbox/status', async (req, res, next) => {
  try {
    res.json(await outboxSender.getStatus());
  } catch (err) {
    next(err);
  }
});

// POST /api/sync/opname-pull - tarik antrean approval Stock Opname dari n8n
// SEKARANG (selain jadwal berkala worker). 1 tick.
router.post('/opname-pull', requireRole('admin', 'head_karaoke', 'head_unit', 'supervisor'), async (req, res, next) => {
  try {
    const result = await opnamePuller.flushOnce();
    res.json(result || { skipped: 'worker nonaktif / OPNAME_POLL_ENABLED off' });
  } catch (err) {
    next(err);
  }
});

// GET /api/sync/opname-pull/status - ringkasan poll approval opname (aktif,
// hasil tick terakhir) - buat panel dashboard / debugging.
router.get('/opname-pull/status', async (req, res, next) => {
  try {
    res.json(await opnamePuller.getStatus());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
