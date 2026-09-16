/**
 * Tutup Kasir / Shift. Lihat migration 018 & services/cashierShift.service.js.
 *
 *  POST /api/cashier/shift/open   { opening_float }      -> buka shift (kasir)
 *  GET  /api/cashier/shift/current                        -> shift terbuka user + angka live
 *  POST /api/cashier/shift/:id/close { counted_cash, note } -> tutup + laporan
 *  GET  /api/cashier/shift/:id                            -> 1 laporan shift
 *  GET  /api/cashier/shift/history?from=&to=&user_id=     -> daftar shift
 *       (kasir: hanya miliknya; admin/supervisor: semua)
 */
const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const svc = require('../services/cashierShift.service');
const { businessDayRange } = require('../services/dailyClose.service');

const router = express.Router();
router.use(requireAuth);

const MANAGE = ['admin', 'supervisor'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post('/shift/open', async (req, res, next) => {
  try {
    const shift = await svc.openShift({
      userId: req.user.user_id,
      terminalId: req.terminalId,
      openingFloat: req.body.opening_float,
    });
    res.status(201).json({ shift });
  } catch (err) { next(err); }
});

router.get('/shift/current', async (req, res, next) => {
  try {
    const open = await svc.getOpenShift(req.user.user_id);
    if (!open) return res.json({ shift: null });
    const report = await svc.computeShiftTotals(open.id);
    res.json({ shift: report.shift, report });
  } catch (err) { next(err); }
});

router.post('/shift/:id/close', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const shift = await svc.getShift(id);
    // kasir hanya boleh tutup shift-nya sendiri; admin/supervisor boleh paksa.
    if (shift.user_id !== req.user.user_id && !MANAGE.includes(req.user.role)) {
      throw new AppError(403, 'Kamu hanya bisa menutup shift milikmu sendiri.');
    }
    if (req.body.counted_cash == null || !Number.isFinite(Number(req.body.counted_cash))) {
      throw new AppError(400, 'counted_cash (kas fisik dihitung) wajib diisi.');
    }
    const report = await svc.closeShift({
      shiftId: id,
      countedCash: req.body.counted_cash,
      note: req.body.note,
      closedByUserId: req.user.user_id,
    });
    res.json({ report });
  } catch (err) { next(err); }
});

router.get('/shift/history', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    // kasir -> hanya shift sendiri
    if (!MANAGE.includes(req.user.role)) {
      where.push('s.user_id = ?');
      params.push(req.user.user_id);
    } else if (req.query.user_id) {
      where.push('s.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (DATE_RE.test(req.query.from || '')) {
      where.push('s.opened_at >= ?');
      params.push(businessDayRange(req.query.from).start_str);
    }
    if (DATE_RE.test(req.query.to || '')) {
      where.push('s.opened_at < ?');
      params.push(businessDayRange(req.query.to).end_str);
    }
    const [rows] = await pool.query(
      `SELECT s.id, s.user_id, s.terminal_id, s.status, s.opened_at, s.closed_at,
              s.opening_float, s.counted_cash, s.expected_cash, s.variance, s.note,
              COALESCE(u.full_name, u.username, CONCAT('User#', s.user_id)) AS cashier_name
         FROM web_cashier_shift s
         LEFT JOIN web_users u ON u.user_id = s.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.id DESC
        LIMIT 200`,
      params
    );
    res.json({ shifts: rows });
  } catch (err) { next(err); }
});

router.get('/shift/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const shift = await svc.getShift(id);
    if (shift.user_id !== req.user.user_id && !MANAGE.includes(req.user.role)) {
      throw new AppError(403, 'Bukan shift milikmu.');
    }
    const report = await svc.computeShiftTotals(id);
    res.json({ report });
  } catch (err) { next(err); }
});

module.exports = router;
