/**
 * Laporan "Tutup Hari" (End-of-Day). Lihat migration 006_daily_close.sql,
 * server/services/dailyClose.service.js, server/services/mailer.service.js.
 *
 * Semua endpoint: admin/supervisor.
 *  GET  /api/reports/daily?date=YYYY-MM-DD[&format=csv]   -> pratinjau LIVE (tidak menyimpan/kirim)
 *  POST /api/reports/daily/close  { date, send }          -> hitung + simpan snapshot (+ email kalau send)
 *  GET  /api/reports/daily/history?limit=30               -> daftar tutup-hari tersimpan (tanpa payload)
 *  GET  /api/reports/daily/:business_date[?format=csv]    -> snapshot tersimpan (tanpa hitung ulang)
 *  POST /api/reports/daily/:business_date/resend          -> kirim ulang email dari snapshot tersimpan
 */
const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const cfg = require('../config/report');
const { UNIT_ID } = require('../config/unit');
const svc = require('../services/dailyClose.service');
const mailer = require('../services/mailer.service');

const router = express.Router();
router.use(requireAuth);

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

// Kirim email dari objek report + update baris web_daily_close.
async function emailReport(report, businessDate) {
  try {
    await mailer.sendDailyClose({
      subject: svc.subjectFor(report),
      html: svc.renderHtmlEmail(report),
      csv: svc.toCsv(report),
      csvFilename: svc.csvFilename(businessDate),
    });
    const emailTo = [].concat(cfg.EOD_REPORT_RECIPIENTS, cfg.EOD_REPORT_CC).join(', ').slice(0, 500);
    await pool.query(
      `UPDATE web_daily_close SET emailed_at = NOW(), email_to = ?, email_error = NULL
        WHERE unit_id = ? AND business_date = ?`,
      [emailTo, UNIT_ID, businessDate]
    );
    return { emailed: true, email_error: null };
  } catch (e) {
    const email_error = String(e.message).slice(0, 500);
    await pool.query(
      `UPDATE web_daily_close SET email_error = ? WHERE unit_id = ? AND business_date = ?`,
      [email_error, UNIT_ID, businessDate]
    );
    return { emailed: false, email_error };
  }
}

// GET /api/reports/daily
router.get('/daily', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = resolveDate(req.query.date);
    const report = await svc.computeReport(date);
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      return sendCsv(res, svc.csvFilename(date), svc.toCsv(report));
    }
    res.json({
      report,
      recipients: cfg.EOD_REPORT_RECIPIENTS,
      cc: cfg.EOD_REPORT_CC,
      smtp_configured: cfg.smtpConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/daily/close  { date, send }
router.post('/daily/close', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = resolveDate(req.body && req.body.date);
    const send = Boolean(req.body && req.body.send);
    const { row, report } = await svc.generateAndPersist(date, req.user.user_id);

    let emailed = false;
    let email_error = null;
    if (send) {
      ({ emailed, email_error } = await emailReport(report, date));
    }
    res.json({ daily_close: rowMeta(row), report, emailed, email_error });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/daily/history?limit=30
router.get('/daily/history', requireRole(...ADMIN), async (req, res, next) => {
  try {
    let limit = Number(req.query.limit) || 30;
    limit = Math.max(1, Math.min(180, limit));
    const [rows] = await pool.query(
      `SELECT dc.unit_id,
              DATE_FORMAT(dc.business_date, '%Y-%m-%d')        AS business_date,
              dc.version,
              DATE_FORMAT(dc.generated_at, '%Y-%m-%d %H:%i:%s') AS generated_at,
              dc.generated_by_user_id, gu.full_name AS generated_by_name,
              DATE_FORMAT(dc.range_start, '%Y-%m-%d %H:%i:%s')  AS range_start,
              DATE_FORMAT(dc.range_end,   '%Y-%m-%d %H:%i:%s')  AS range_end,
              dc.csv_row_count,
              DATE_FORMAT(dc.emailed_at, '%Y-%m-%d %H:%i:%s')   AS emailed_at,
              dc.email_to, dc.email_error,
              DATE_FORMAT(dc.created_at, '%Y-%m-%d %H:%i:%s')   AS created_at
         FROM web_daily_close dc
         LEFT JOIN web_users gu ON gu.user_id = dc.generated_by_user_id
        WHERE dc.unit_id = ?
        ORDER BY dc.business_date DESC
        LIMIT ?`,
      [UNIT_ID, limit]
    );
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/daily/:business_date  (snapshot tersimpan)
router.get('/daily/:business_date', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = req.params.business_date;
    if (!DATE_RE.test(date)) throw new AppError(400, 'business_date harus format YYYY-MM-DD.');
    const [[row]] = await pool.query(
      'SELECT * FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
      [UNIT_ID, date]
    );
    if (!row) throw new AppError(404, `Tutup Hari untuk ${date} belum ada.`);
    const report = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      return sendCsv(res, svc.csvFilename(date), svc.toCsv(report));
    }
    res.json({ daily_close: rowMeta(row), report });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/daily/:business_date/resend
router.post('/daily/:business_date/resend', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = req.params.business_date;
    if (!DATE_RE.test(date)) throw new AppError(400, 'business_date harus format YYYY-MM-DD.');
    const [[row]] = await pool.query(
      'SELECT * FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
      [UNIT_ID, date]
    );
    if (!row) throw new AppError(404, `Tutup Hari untuk ${date} belum ada.`);
    const report = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const { emailed, email_error } = await emailReport(report, date);
    res.json({ emailed, email_error });
  } catch (err) {
    next(err);
  }
});

// Baris web_daily_close tanpa payload besar. mysql2 mengembalikan DATE/DATETIME
// sebagai objek Date (bergeser ke UTC saat JSON) - format ke string lokal
// stabil supaya business_date tidak meleset 1 hari di klien.
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

module.exports = router;
