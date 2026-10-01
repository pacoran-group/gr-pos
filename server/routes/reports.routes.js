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

const ADMIN = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];
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
      voidCsv: svc.voidCsv(report),
      voidCsvFilename: svc.voidCsvFilename(businessDate),
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
              dc.erp_status, dc.erp_doc, dc.erp_error,
              DATE_FORMAT(dc.erp_synced_at, '%Y-%m-%d %H:%i:%s') AS erp_synced_at,
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

// =====================================================================
// GET /api/reports/voids?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
// Laporan item yang di-VOID, dikelompokkan per KASIR yang membuka sesi
// kamar tsb (web_tr_trans.opened_by_user_id) - "di masa kasir mana".
// Dipakai sebagai bahan penilaian staf. admin/supervisor, read-only.
// Rentang tanggal memakai hari-usaha (EOD cutoff) spt laporan lain.
// =====================================================================
router.get('/voids', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const from = resolveDate(req.query.from);
    const to = resolveDate(req.query.to || req.query.from);
    if (to < from) throw new AppError(400, 'Tanggal "to" tidak boleh sebelum "from".');
    const start = svc.businessDayRange(from).start_str;
    const end = svc.businessDayRange(to).end_str;

    const [rows] = await pool.query(
      `SELECT v.id, v.created_at, v.trans_id, v.product_id, v.product_name_snapshot,
              v.void_qty, v.price, v.subtotal_voided, v.reason, v.approved_at_terminal,
              t.room_id, t.room_type_snapshot,
              COALESCE(r.room_name, CONCAT('Room ', t.room_id)) AS room_name,
              t.opened_by_user_id AS kasir_id,
              COALESCE(ku.full_name, ku.username, CONCAT('User#', t.opened_by_user_id)) AS kasir_name,
              COALESCE(au.full_name, au.username, CONCAT('User#', v.approved_by_user_id)) AS approved_by_name
         FROM web_tr_trans_void v
         JOIN web_tr_trans t   ON t.trans_id = v.trans_id
         LEFT JOIN m_room r    ON r.room_id = t.room_id
         LEFT JOIN web_users ku ON ku.user_id = t.opened_by_user_id
         LEFT JOIN web_users au ON au.user_id = v.approved_by_user_id
        WHERE t.is_test = 0
          AND v.created_at >= ? AND v.created_at < ?
        ORDER BY v.created_at DESC`,
      [start, end]
    );

    const norm = rows.map((x) => ({
      id: x.id,
      created_at: fmtDateTime(x.created_at),
      trans_id: x.trans_id,
      room_name: x.room_name,
      room_type: x.room_type_snapshot,
      kasir_id: x.kasir_id,
      kasir_name: x.kasir_name,
      product_id: x.product_id,
      product_name: x.product_name_snapshot,
      void_qty: Number(x.void_qty),
      price: Number(x.price),
      subtotal_voided: Number(x.subtotal_voided),
      reason: x.reason || '',
      approved_by_name: x.approved_by_name,
      terminal: x.approved_at_terminal,
    }));

    if ((req.query.format || '').toLowerCase() === 'csv') {
      const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
      const head = ['Tanggal/Jam', 'Kasir (pembuka sesi)', 'Room', 'Tipe', 'Trans', 'Produk',
        'Qty Void', 'Harga', 'Nilai Void', 'Alasan', 'Di-void oleh (admin)', 'Terminal'];
      const lines = [head.map(esc).join(',')];
      for (const x of norm) {
        lines.push([x.created_at, x.kasir_name, x.room_name, x.room_type, x.trans_id, x.product_name,
          x.void_qty, x.price, x.subtotal_voided, x.reason, x.approved_by_name, x.terminal].map(esc).join(','));
      }
      return sendCsv(res, `laporan-void_${from}_sd_${to}.csv`, lines.join('\r\n'));
    }

    // --- agregasi per kasir ---
    const byKasir = new Map();
    let totalQty = 0;
    let totalValue = 0;
    for (const x of norm) {
      const key = x.kasir_id == null ? 0 : x.kasir_id;
      if (!byKasir.has(key)) {
        byKasir.set(key, {
          kasir_id: x.kasir_id, kasir_name: x.kasir_name,
          void_count: 0, void_qty: 0, void_value: 0, items: [],
        });
      }
      const g = byKasir.get(key);
      g.void_count += 1;
      g.void_qty += x.void_qty;
      g.void_value += x.subtotal_voided;
      g.items.push(x);
      totalQty += x.void_qty;
      totalValue += x.subtotal_voided;
    }
    const by_kasir = [...byKasir.values()].sort((a, b) => b.void_value - a.void_value);

    res.json({
      from, to,
      summary: {
        total_voids: norm.length,
        total_qty: totalQty,
        total_value: totalValue,
        distinct_kasir: by_kasir.length,
      },
      by_kasir,
      rows: norm,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
