const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const roomPlayer = require('../services/roomPlayer.service');
const legacyRoomState = require('../services/legacyRoomState.service');
const { allottedMs, getWindowForTime, CREDIT_HOURS_PER_THRESHOLD, PAYMENT_SPARE_MIN, TEST_MODE_MINUTES } = require('../services/threshold.service');
const { BILLING_MODE, RESTO_TAX_PCT, priceIncludesTax } = require('../config/billing');

const router = express.Router();
const SOFT_LOCK_TTL_SECONDS = Number(process.env.SOFT_LOCK_TTL_SECONDS || 120);

router.use(requireAuth);

// GET /api/rooms - dashboard status semua kamar + info soft-lock + transaksi aktif
router.get('/', async (req, res, next) => {
  try {
    const [rooms] = await pool.query(
      `SELECT room_id, room_name, room_type, status FROM m_room ORDER BY room_id`
    );

    // Threshold saat ini per tipe kamar (harga_sewa siang / harga_sewa1 malam) -
    // dipakai halaman Orders utk menampilkan "belanja sekian = sekian jam"
    // sebelum kamar dibuka.
    const [promos] = await pool.query('SELECT room_type, harga_sewa, harga_sewa1 FROM m_promo');
    const windowNow = getWindowForTime();
    const thByType = Object.fromEntries(
      promos.map((p) => [p.room_type, Number(windowNow === 'siang' ? p.harga_sewa : p.harga_sewa1)])
    );

    const [maintenance] = await pool.query(
      `SELECT room_id, reason FROM web_room_maintenance WHERE is_maintenance = 1`
    );
    const maintByRoom = Object.fromEntries(maintenance.map((m) => [m.room_id, m.reason]));

    const [softLocks] = await pool.query(
      `SELECT sl.room_id, sl.terminal_id, sl.user_id, sl.locked_at, u.full_name
       FROM web_room_soft_lock sl
       JOIN web_users u ON u.user_id = sl.user_id
       WHERE sl.locked_at >= (NOW() - INTERVAL ? SECOND)`,
      [SOFT_LOCK_TTL_SECONDS]
    );
    const lockByRoom = Object.fromEntries(softLocks.map((l) => [l.room_id, l]));

    // is_test disertakan supaya dashboard bisa menandai sesi percobaan
    // (Mode Test) dengan badge berbeda. SISA WAKTU karaoke sekarang FLAT
    // (2 jam paket + spare bayar + extra_minutes manual) - lihat
    // threshold.service.js: allottedMs. fnb_gross tetap diambil untuk
    // info lain di dashboard.
    const [activeTrans] = await pool.query(
      `SELECT t.trans_id, t.room_id, t.cust_name, t.person, t.start_time, t.is_test,
              t.rate_mode, t.comp_hours,
              t.threshold_amount, t.member_disc_fnb, t.extra_minutes,
              COALESCE(SUM(d.subtotal), 0) AS fnb_gross
       FROM web_tr_trans t
       LEFT JOIN web_tr_trans_details d ON d.trans_id = t.trans_id
       WHERE t.status = 'active'
       GROUP BY t.trans_id`
    );
    const transByRoom = Object.fromEntries(
      activeTrans.map((t) => {
        const netFnb = Number(t.fnb_gross) - Number(t.member_disc_fnb || 0);
        const totalMs = allottedMs({
          extraMinutes: t.extra_minutes,
          rateMode: t.rate_mode,
          compHours: t.comp_hours,
        });
        // Mode Test (tes fisik room): player nyala, auto-mati TEST_MODE_MINUTES
        // sejak start_time -> hitung mundur dari situ.
        // COMP (VIP/VVIP): expires_at dihitung dari comp_hours.
        const expiresAt = t.is_test
          ? new Date(new Date(t.start_time).getTime() + TEST_MODE_MINUTES * 60000).toISOString()
          : new Date(new Date(t.start_time).getTime() + totalMs).toISOString();
        return [
          t.room_id,
          {
            trans_id: t.trans_id,
            room_id: t.room_id,
            cust_name: t.cust_name,
            person: t.person,
            start_time: t.start_time,
            is_test: t.is_test,
            rate_mode: t.rate_mode,
            comp_hours: t.comp_hours == null ? null : Number(t.comp_hours),
            net_fnb: netFnb,
            threshold_amount: Number(t.threshold_amount),
            extra_minutes: Number(t.extra_minutes || 0),
            allotted_ms: t.is_test ? null : totalMs,
            expires_at: expiresAt, // dashboard hitung mundur dari sini (null utk Mode Test)
          },
        ];
      })
    );

    // Kamar yang menyala di server lama (154) menurut cache read-only
    // (web_legacy_room_state) TAPI gr-pos tak punya transaksi aktifnya =
    // sedang dilayani sistem lama. Ditandai status "legacy" terpisah di grid.
    // Baris cache yang basi (stale) diabaikan supaya tak menandai info usang.
    let legacyActiveByRoom = {};
    try {
      const states = await legacyRoomState.getStates();
      legacyActiveByRoom = Object.fromEntries(
        states.filter((s) => s.is_active && !s.stale).map((s) => [s.room_id, true])
      );
    } catch (_) {
      legacyActiveByRoom = {};
    }

    const result = rooms.map((r) => ({
      room_id: r.room_id,
      room_name: r.room_name,
      room_type: r.room_type,
      threshold_amount: thByType[r.room_type] ?? null,
      threshold_window: windowNow,
      base_hours: CREDIT_HOURS_PER_THRESHOLD,
      payment_spare_min: PAYMENT_SPARE_MIN,
      hours_per_threshold: CREDIT_HOURS_PER_THRESHOLD, // kompat lama
      billing_mode: BILLING_MODE,
      resto_tax_pct: RESTO_TAX_PCT,
      price_includes_tax: priceIncludesTax(),
      test_mode_minutes: TEST_MODE_MINUTES,
      is_maintenance: Boolean(maintByRoom[r.room_id] !== undefined),
      maintenance_reason: maintByRoom[r.room_id] || null,
      active_trans: transByRoom[r.room_id] || null,
      // menyala di 154 & bukan transaksi gr-pos -> dikelola sistem lama
      legacy_active: Boolean(legacyActiveByRoom[r.room_id]) && !transByRoom[r.room_id],
      soft_lock: lockByRoom[r.room_id]
        ? {
            terminal_id: lockByRoom[r.room_id].terminal_id,
            locked_by: lockByRoom[r.room_id].full_name,
            locked_at: lockByRoom[r.room_id].locked_at,
          }
        : null,
    }));

    res.json({ rooms: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/rooms/:id/soft-lock - kasir sedang membuka layar aksi utk room ini
router.post('/:id/soft-lock', async (req, res, next) => {
  try {
    const roomId = Number(req.params.id);
    await pool.query(
      `INSERT INTO web_room_soft_lock (room_id, terminal_id, user_id, locked_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE terminal_id = VALUES(terminal_id), user_id = VALUES(user_id), locked_at = NOW()`,
      [roomId, req.terminalId, req.user.user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rooms/:id/soft-lock - kasir batal/keluar dari layar aksi
router.delete('/:id/soft-lock', async (req, res, next) => {
  try {
    const roomId = Number(req.params.id);
    await pool.query('DELETE FROM web_room_soft_lock WHERE room_id = ?', [roomId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/rooms/:id/maintenance - set kamar rusak/maintenance
// head_unit SENGAJA tidak dimasukkan - aksi ini disembunyikan dari role itu.
router.post('/:id/maintenance', requireRole('admin', 'head_karaoke', 'supervisor'), async (req, res, next) => {
  try {
    const roomId = Number(req.params.id);
    const { reason } = req.body;
    // Jangan tandai maintenance kalau kamar sedang dipakai (ada sesi aktif) -
    // classify() di dashboard menaruh maintenance di atas occupied, sesi bisa
    // "hilang" dari layar. Tutup / batalkan dulu sesinya.
    const [act] = await pool.query(
      "SELECT trans_id FROM web_tr_trans WHERE room_id = ? AND status = 'active' LIMIT 1",
      [roomId]
    );
    if (act.length) {
      return res.status(409).json({ error: 'Kamar sedang ada sesi aktif. Tutup / batalkan sesinya dulu sebelum set maintenance.' });
    }
    await pool.query(
      `INSERT INTO web_room_maintenance (room_id, is_maintenance, reason, set_by, set_at)
       VALUES (?, 1, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE is_maintenance = 1, reason = VALUES(reason), set_by = VALUES(set_by), set_at = NOW(), cleared_at = NULL`,
      [roomId, reason || null, req.user.user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rooms/:id/maintenance - kamar sudah selesai diperbaiki
// head_unit SENGAJA tidak dimasukkan - aksi ini disembunyikan dari role itu.
router.delete('/:id/maintenance', requireRole('admin', 'head_karaoke', 'supervisor'), async (req, res, next) => {
  try {
    const roomId = Number(req.params.id);
    await pool.query(
      `UPDATE web_room_maintenance SET is_maintenance = 0, cleared_at = NOW() WHERE room_id = ?`,
      [roomId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/rooms/:id/player - nyalakan/matikan aplikasi pemutar lagu room
// SECARA MANUAL (khusus admin/supervisor). Menggantikan UPDATE m_room manual
// lewat Navicat ke server lama: perintah diantre ke web_room_player_outbox
// lalu dikirim worker ke 154. Lihat services/roomPlayer.service.js.
router.post('/:id/player', requireRole('admin', 'head_karaoke', 'head_unit', 'supervisor'), async (req, res, next) => {
  try {
    const roomId = Number(req.params.id);
    const state = String(req.body.state || '').toLowerCase();
    if (!['on', 'off'].includes(state)) throw new AppError(400, "state harus 'on' atau 'off'.");
    await roomPlayer.enqueue(pool, {
      roomId, desiredState: state, reason: 'manual', userId: req.user.user_id,
    });
    res.json({ ok: true, room_id: roomId, desired_state: state });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
