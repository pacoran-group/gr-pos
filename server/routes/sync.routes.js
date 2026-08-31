const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const masterSync = require('../services/masterSync.service');
const legacyRoomState = require('../services/legacyRoomState.service');

const router = express.Router();
router.use(requireAuth);

// POST /api/sync/master - jalankan sinkron master-data 154 -> Server02 sekarang.
// Manual = SEMUA tabel (FAST + SLOW), dengan fingerprint-skip.
router.post('/master', requireRole('admin', 'supervisor'), async (req, res, next) => {
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

module.exports = router;
