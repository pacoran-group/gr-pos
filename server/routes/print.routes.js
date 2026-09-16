const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/print-queue/dapur - Layar Auto-Print Komputer C poll tiket baru
router.get('/dapur', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, trans_id, print_type, printer_target, payload_snapshot, created_at
       FROM web_print_log
       WHERE destination = 'dapur_screen' AND status = 'pending'
       ORDER BY id`
    );
    res.json({
      jobs: rows.map((r) => ({
        print_log_id: r.id,
        trans_id: r.trans_id,
        print_type: r.print_type,
        printer_target: r.printer_target,
        payload: typeof r.payload_snapshot === 'string' ? JSON.parse(r.payload_snapshot) : r.payload_snapshot,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/print-queue/:id/ack - tandai tiket sudah tercetak/diambil di Komputer C
router.post('/:id/ack', async (req, res, next) => {
  try {
    await pool.query("UPDATE web_print_log SET status = 'printed', printed_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/print-queue/:id/siap - dapur menekan "Pesanan Siap" setelah selesai
// masak -> muncul pop-up notifikasi di SEMUA komputer kasir (bukan papan/layar
// waiter terpisah - disederhanakan sesuai keputusan user 26 Agustus 2026).
router.post('/:id/siap', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT trans_id, payload_snapshot FROM web_print_log WHERE id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    const payload = typeof rows[0].payload_snapshot === 'string' ? JSON.parse(rows[0].payload_snapshot) : rows[0].payload_snapshot;
    const roomName = payload?.room_name || '';
    const roomId = payload?.room_id || 0;

    await pool.query(
      `INSERT INTO web_order_ready_notify (trans_id, room_id, message) VALUES (?, ?, ?)`,
      [rows[0].trans_id, roomId, `Pesanan untuk ${roomName || 'kamar'} sudah siap!`]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/print-queue/notify/pesanan-siap - kasir poll notifikasi pop-up
router.get('/notify/pesanan-siap', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, trans_id, room_id, message, created_at
       FROM web_order_ready_notify WHERE acked_at IS NULL ORDER BY id`
    );
    res.json({ notifications: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/print-queue/notify/pesanan-siap/:id/ack - kasir menutup pop-up
router.post('/notify/pesanan-siap/:id/ack', async (req, res, next) => {
  try {
    await pool.query('UPDATE web_order_ready_notify SET acked_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
