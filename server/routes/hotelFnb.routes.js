/**
 * Modul "F&B Hotel". Lihat migration 007_fnb_hotel.sql,
 * server/services/hotelFnb.service.js.
 *
 *  POST /api/hotel-fnb/orders                 -> buat order (kasir/admin/supervisor)
 *  GET  /api/hotel-fnb/orders?date=YYYY-MM-DD -> daftar order hari usaha itu
 *  POST /api/hotel-fnb/orders/:id/cancel      -> batalkan order (wajib alasan)
 *  GET  /api/hotel-fnb/daily?date=&format=csv -> pratinjau rekap LIVE (admin/supervisor)
 *  POST /api/hotel-fnb/daily/close {date,send}-> simpan snapshot (+ email kalau send)
 *  GET  /api/hotel-fnb/daily/history?limit=30
 *  GET  /api/hotel-fnb/daily/:business_date[?format=csv]
 *  POST /api/hotel-fnb/daily/:business_date/resend
 */
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const mailer = require('../services/mailer.service');
const svc = require('../services/hotelFnb.service');
const { HOTEL_UNIT_ID, HOTEL_FNB_RECIPIENTS, HOTEL_FNB_CC, hotelFnbMailConfigured } = require('../config/hotel');

const router = express.Router();
router.use(requireAuth);

const ORDER_ROLES = ['kasir', 'admin', 'supervisor'];
const ADMIN = ['admin', 'supervisor'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(v) {
  const d = (v || '').trim() || svc.defaultBusinessDate();
  if (!DATE_RE.test(d)) throw new AppError(400, 'Parameter date harus format YYYY-MM-DD.');
  return d;
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDateTime(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function rowMeta(row) {
  if (!row) return null;
  const { payload, ...meta } = row;
  if (meta.business_date != null) meta.business_date = fmtDate(meta.business_date);
  for (const k of ['generated_at', 'range_start', 'range_end', 'emailed_at', 'created_at', 'updated_at']) {
    if (k in meta) meta[k] = fmtDateTime(meta[k]);
  }
  return meta;
}

// Kirim email rekap + update baris web_fnb_hotel_close.
async function emailReport(report, businessDate) {
  try {
    if (!hotelFnbMailConfigured()) {
      throw new AppError(500, 'SMTP / HOTEL_FNB_RECIPIENTS belum dikonfigurasi di .env.');
    }
    await mailer.sendMail({
      subject: svc.subjectFor(report),
      html: svc.renderHtmlEmail(report),
      csv: svc.toCsv(report),
      csvFilename: svc.csvFilename(businessDate),
      to: HOTEL_FNB_RECIPIENTS,
      cc: HOTEL_FNB_CC,
    });
    const emailTo = [].concat(HOTEL_FNB_RECIPIENTS, HOTEL_FNB_CC).join(', ').slice(0, 500);
    await pool.query(
      `UPDATE web_fnb_hotel_close SET emailed_at = NOW(), email_to = ?, email_error = NULL
        WHERE unit_id = ? AND business_date = ?`,
      [emailTo, HOTEL_UNIT_ID, businessDate]
    );
    return { emailed: true, email_error: null };
  } catch (e) {
    const email_error = String(e.message).slice(0, 500);
    await pool.query(
      `UPDATE web_fnb_hotel_close SET email_error = ? WHERE unit_id = ? AND business_date = ?`,
      [email_error, HOTEL_UNIT_ID, businessDate]
    );
    return { emailed: false, email_error };
  }
}

// --- Order ---

router.post('/orders', requireRole(...ORDER_ROLES), async (req, res, next) => {
  try {
    const { hotel_room_no, cust_name, items, note, request_key } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw new AppError(400, 'items wajib diisi.');

    const result = await withTransaction(async (conn) => {
      const cached = await svc.getIdempotent(conn, request_key);
      if (cached) return cached;
      const r = await svc.createOrder(conn, {
        hotelRoomNo: hotel_room_no,
        custName: cust_name,
        items,
        note,
        userId: req.user.user_id,
        userName: req.user.full_name,
        terminalId: req.terminalId,
      });
      await svc.saveIdempotent(conn, request_key, r.order_id, r);
      return r;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/orders', requireRole(...ORDER_ROLES), async (req, res, next) => {
  try {
    const date = resolveDate(req.query.date);
    const range = svc.businessDayRange(date);
    const [rows] = await pool.query(
      `SELECT o.order_id, o.hotel_room_no, o.cust_name, o.status,
              o.total_amount, o.sc_component, o.base_amount,
              DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              cu.full_name AS created_by_name,
              o.cancelled_reason,
              DATE_FORMAT(o.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at
         FROM web_fnb_hotel_order o
         LEFT JOIN web_users cu ON cu.user_id = o.created_by_user_id
        WHERE o.created_at >= ? AND o.created_at < ?
        ORDER BY o.created_at DESC`,
      [range.start_str, range.end_str]
    );
    // item ringkas per order
    const ids = rows.map((r) => r.order_id);
    let items = {};
    if (ids.length) {
      const [d] = await pool.query(
        `SELECT order_id, product_name_snapshot AS name, qty
           FROM web_fnb_hotel_order_details
          WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
        ids
      );
      for (const x of d) (items[x.order_id] = items[x.order_id] || []).push(`${x.qty}x ${x.name}`);
    }
    res.json({
      business_date: date,
      orders: rows.map((r) => ({ ...r, items: (items[r.order_id] || []).join(', ') })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:id/cancel', requireRole(...ORDER_ROLES), async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    const out = await withTransaction((conn) =>
      svc.cancelOrder(conn, req.params.id, { userId: req.user.user_id, reason })
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// --- Rekap harian ---

router.get('/daily', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = resolveDate(req.query.date);
    const report = await svc.computeReport(date);
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      return sendCsv(res, svc.csvFilename(date), svc.toCsv(report));
    }
    res.json({
      report,
      recipients: HOTEL_FNB_RECIPIENTS,
      cc: HOTEL_FNB_CC,
      smtp_configured: hotelFnbMailConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/daily/close', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = resolveDate(req.body && req.body.date);
    const send = Boolean(req.body && req.body.send);
    const { row, report } = await svc.generateAndPersist(date, req.user.user_id);
    let emailed = false;
    let email_error = null;
    if (send) ({ emailed, email_error } = await emailReport(report, date));
    res.json({ daily_close: rowMeta(row), report, emailed, email_error });
  } catch (err) {
    next(err);
  }
});

router.get('/daily/history', requireRole(...ADMIN), async (req, res, next) => {
  try {
    let limit = Number(req.query.limit) || 30;
    limit = Math.max(1, Math.min(180, limit));
    const [rows] = await pool.query(
      `SELECT c.unit_id,
              DATE_FORMAT(c.business_date, '%Y-%m-%d')          AS business_date,
              c.version,
              DATE_FORMAT(c.generated_at, '%Y-%m-%d %H:%i:%s')   AS generated_at,
              c.generated_by_user_id, gu.full_name AS generated_by_name,
              c.order_count, c.total_amount,
              DATE_FORMAT(c.emailed_at, '%Y-%m-%d %H:%i:%s')     AS emailed_at,
              c.email_to, c.email_error,
              DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s')     AS created_at
         FROM web_fnb_hotel_close c
         LEFT JOIN web_users gu ON gu.user_id = c.generated_by_user_id
        WHERE c.unit_id = ?
        ORDER BY c.business_date DESC
        LIMIT ?`,
      [HOTEL_UNIT_ID, limit]
    );
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/daily/:business_date', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = req.params.business_date;
    if (!DATE_RE.test(date)) throw new AppError(400, 'business_date harus format YYYY-MM-DD.');
    const [[row]] = await pool.query(
      'SELECT * FROM web_fnb_hotel_close WHERE unit_id = ? AND business_date = ?',
      [HOTEL_UNIT_ID, date]
    );
    if (!row) throw new AppError(404, `Rekap F&B Hotel untuk ${date} belum ada.`);
    const report = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      return sendCsv(res, svc.csvFilename(date), svc.toCsv(report));
    }
    res.json({ daily_close: rowMeta(row), report });
  } catch (err) {
    next(err);
  }
});

router.post('/daily/:business_date/resend', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = req.params.business_date;
    if (!DATE_RE.test(date)) throw new AppError(400, 'business_date harus format YYYY-MM-DD.');
    const [[row]] = await pool.query(
      'SELECT * FROM web_fnb_hotel_close WHERE unit_id = ? AND business_date = ?',
      [HOTEL_UNIT_ID, date]
    );
    if (!row) throw new AppError(404, `Rekap F&B Hotel untuk ${date} belum ada.`);
    const report = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const { emailed, email_error } = await emailReport(report, date);
    res.json({ emailed, email_error });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
