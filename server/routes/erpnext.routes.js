/**
 * Integrasi ERPNext - lihat server/services/erpnextSync.service.js.
 *
 * - GET  /api/erpnext/status              -> config (tanpa secret) + hasil tick terakhir
 * - GET  /api/erpnext/check               -> cek koneksi & master data di ERP (read-only)
 * - GET  /api/erpnext/preview/:date       -> payload Journal Entry (dry-run, tidak mengirim)
 * - POST /api/erpnext/send/:date          -> kirim / kirim ulang Tutup Hari tanggal itu
 * - GET  /api/erpnext/expense/:id/preview -> payload JE 1 pengeluaran (dry-run)
 * - POST /api/erpnext/expense/:id/send    -> kirim / kirim ulang 1 pengeluaran (shift harus sudah tutup)
 */
const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { UNIT_ID } = require('../config/unit');
const C = require('../config/erpnext');
const erp = require('../services/erpnextSync.service');
const dailyClose = require('../services/dailyClose.service');

const router = express.Router();
router.use(requireAuth);
const ADMIN = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(req) {
  const d = String(req.params.date || '');
  if (!DATE_RE.test(d)) throw new AppError(400, 'Tanggal harus format YYYY-MM-DD.');
  return d;
}

router.get('/status', requireRole(...ADMIN), (req, res) => {
  res.json({
    enabled: C.ERPNEXT_SENDER_ENABLED,
    url: C.ERPNEXT_URL || null,
    company: C.ERPNEXT_COMPANY || null,
    cost_center: C.ERPNEXT_COST_CENTER || null,
    api_key_set: Boolean(C.ERPNEXT_API_KEY),
    api_secret_set: Boolean(C.ERPNEXT_API_SECRET),
    accounts: {
      kas: C.ERPNEXT_ACCOUNT_KAS || null,
      qris: C.ERPNEXT_ACCOUNT_QRIS || null,
      kartu: C.ERPNEXT_ACCOUNT_KARTU || null,
      selisih: C.ERPNEXT_ACCOUNT_SELISIH || null,
      penjualan: C.ERPNEXT_ACCOUNT_PENJUALAN || null,
      service_charge: C.ERPNEXT_ACCOUNT_SC || null,
      pb1: C.ERPNEXT_ACCOUNT_PB1 || null,
    },
    missing_config: C.missingConfig(),
    last_run: erp.getLastRun(),
  });
});

router.get('/check', requireRole('admin'), async (req, res, next) => {
  try {
    res.json(await erp.checkSetup());
  } catch (err) {
    next(err);
  }
});

// Pratinjau: pakai snapshot Tutup Hari tersimpan kalau ada, kalau belum
// hitung laporan saat ini (tanpa menyimpan).
router.get('/preview/:date', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const date = dateParam(req);
    const [[row]] = await pool.query(
      'SELECT payload FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
      [UNIT_ID, date]
    );
    const report = row
      ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload)
      : await dailyClose.computeReport(date);
    const je = await erp.buildJournalEntry(report);
    res.json({ source: row ? 'tutup_hari_tersimpan' : 'hitung_langsung', ...je });
  } catch (err) {
    next(err);
  }
});

router.post('/send/:date', requireRole('admin'), async (req, res, next) => {
  try {
    const date = dateParam(req);
    const result = await erp.sendNow(date);
    if (!result) throw new AppError(404, `Belum ada Tutup Hari tersimpan untuk ${date}. Jalankan Tutup Hari dulu.`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID pengeluaran tidak valid.');
  return id;
}

router.get('/expense/:id/preview', requireRole(...ADMIN), async (req, res, next) => {
  try {
    const e = await erp.getExpense(idParam(req));
    if (!e) throw new AppError(404, 'Pengeluaran tidak ditemukan.');
    res.json({ shift_status: e.shift_status, ...erp.buildExpenseJournalEntry(e) });
  } catch (err) {
    next(err);
  }
});

router.post('/expense/:id/send', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await erp.sendExpenseNow(idParam(req));
    if (!result) throw new AppError(404, 'Pengeluaran tidak ditemukan.');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
