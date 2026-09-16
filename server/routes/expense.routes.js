/**
 * Pengeluaran unit - CRUD sederhana. Lihat migration 013_expense.sql.
 *
 * Menggantikan alur "scan QR -> form n8n". Menangkap TOTAL pengeluaran
 * level-header (tanggal, vendor, unit bisnis, unit beban, total, catatan,
 * link bukti kuitansi). Tidak ada rincian per-item di sini.
 *
 * Semua endpoint: admin / supervisor (data finance-sensitif). Kasir tidak
 * melihat halaman ini (nav difilter di UX; server tetap menegakkan role).
 *
 * Kalau SYNC_OUTBOX_ENABLED, create/update juga menulis 1 baris
 * web_sync_outbox (aggregate 'expense') supaya kelak bisa dikonsolidasi
 * ke sistem pusat - konsisten dgn daily_close & stock_movement.
 */
const crypto = require('crypto');
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { UNIT_ID, UNIT_NAME, SYNC_OUTBOX_ENABLED } = require('../config/unit');

const router = express.Router();
router.use(requireAuth);
const MANAGE = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// mysql2 mengembalikan kolom DATE sebagai objek Date (bergeser ke hari
// sebelumnya saat di-JSON di zona WIB). Format di SQL supaya klien terima
// string 'YYYY-MM-DD' apa adanya - konsisten dgn dailyClose.service.js.
const EXP_COLS = `expense_id, DATE_FORMAT(expense_date, '%Y-%m-%d') AS expense_date,
  vendor_name, paying_unit, charged_unit, amount, note, receipt_url,
  created_by_user_id, created_at, updated_at`;

function parseBody(body) {
  const b = body || {};

  const expense_date = String(b.expense_date || '').trim();
  if (!DATE_RE.test(expense_date) || Number.isNaN(Date.parse(expense_date))) {
    throw new AppError(400, 'Tanggal transaksi wajib diisi (format YYYY-MM-DD).');
  }
  // toleransi 1 hari ke depan (beda timezone); tolak yang jelas salah ketik.
  const maxAhead = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  if (expense_date > maxAhead) throw new AppError(400, 'Tanggal transaksi tidak boleh di masa depan.');

  const vendor_name = String(b.vendor_name || '').trim();
  if (!vendor_name) throw new AppError(400, 'Nama vendor wajib diisi.');
  if (vendor_name.length > 150) throw new AppError(400, 'Nama vendor maksimal 150 karakter.');

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Total pengeluaran harus angka lebih dari 0.');
  if (amount > 1e12) throw new AppError(400, 'Total pengeluaran tidak masuk akal (terlalu besar).');

  const paying_unit = String(b.paying_unit || UNIT_NAME).trim().slice(0, 60) || UNIT_NAME;
  const charged_unit = String(b.charged_unit || '').trim().slice(0, 60) || paying_unit;

  const note = b.note ? String(b.note).slice(0, 500) : null;

  let receipt_url = b.receipt_url ? String(b.receipt_url).trim().slice(0, 500) : null;
  if (receipt_url) {
    let ok = false;
    try {
      const u = new URL(receipt_url);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) { ok = false; }
    if (!ok) throw new AppError(400, 'Link bukti harus URL yang valid (diawali http:// atau https://).');
  }

  return { expense_date, vendor_name, paying_unit, charged_unit, amount: Math.round(amount * 100) / 100, note, receipt_url };
}

function outboxPayload(row) {
  return {
    event_uid: crypto.randomUUID(),
    source_unit_id: UNIT_ID,
    expense_id: row.expense_id,
    expense_date: row.expense_date,
    vendor_name: row.vendor_name,
    paying_unit: row.paying_unit,
    charged_unit: row.charged_unit,
    amount: Number(row.amount),
    note: row.note,
    receipt_url: row.receipt_url,
    created_by_user_id: row.created_by_user_id,
    updated_at: row.updated_at,
  };
}

async function emitOutbox(conn, row) {
  if (!SYNC_OUTBOX_ENABLED) return;
  const payload = outboxPayload(row);
  await conn.query(
    `INSERT INTO web_sync_outbox (event_uid, aggregate, aggregate_id, unit_id, payload)
     VALUES (?, 'expense', ?, ?, ?)`,
    [payload.event_uid, `EXP:${UNIT_ID}:${row.expense_id}`, UNIT_ID, JSON.stringify(payload)]
  );
}

// GET /api/expenses[?from=YYYY-MM-DD&to=YYYY-MM-DD&unit=]
router.get('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;
    const unit = (req.query.unit || '').trim();

    const where = [];
    const params = [];
    if (from) { where.push('e.expense_date >= ?'); params.push(from); }
    if (to) { where.push('e.expense_date <= ?'); params.push(to); }
    if (unit) { where.push('(e.paying_unit = ? OR e.charged_unit = ?)'); params.push(unit, unit); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT e.expense_id, DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
              e.vendor_name, e.paying_unit, e.charged_unit,
              e.amount, e.note, e.receipt_url, e.created_by_user_id, e.created_at, e.updated_at,
              u.full_name AS created_by_name
         FROM web_expense e
         LEFT JOIN web_users u ON u.user_id = e.created_by_user_id
         ${whereSql}
        ORDER BY e.expense_date DESC, e.expense_id DESC`,
      params
    );
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    res.json({
      expenses: rows,
      summary: { count: rows.length, total },
      this_unit: { unit_id: UNIT_ID, unit_name: UNIT_NAME },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses
router.post('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const b = parseBody(req.body);
    const row = await withTransaction(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO web_expense
           (expense_date, vendor_name, paying_unit, charged_unit, amount, note, receipt_url, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.expense_date, b.vendor_name, b.paying_unit, b.charged_unit, b.amount, b.note, b.receipt_url, req.user.user_id]
      );
      const [[created]] = await conn.query(`SELECT ${EXP_COLS} FROM web_expense WHERE expense_id = ?`, [r.insertId]);
      await emitOutbox(conn, created);
      return created;
    });
    res.status(201).json({ expense: row });
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/:id
router.put('/:id', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID pengeluaran tidak valid.');
    const b = parseBody(req.body);
    const row = await withTransaction(async (conn) => {
      const [ex] = await conn.query('SELECT expense_id FROM web_expense WHERE expense_id = ?', [id]);
      if (!ex.length) throw new AppError(404, `Pengeluaran #${id} tidak ada.`);
      await conn.query(
        `UPDATE web_expense SET
           expense_date = ?, vendor_name = ?, paying_unit = ?, charged_unit = ?,
           amount = ?, note = ?, receipt_url = ?
         WHERE expense_id = ?`,
        [b.expense_date, b.vendor_name, b.paying_unit, b.charged_unit, b.amount, b.note, b.receipt_url, id]
      );
      const [[updated]] = await conn.query(`SELECT ${EXP_COLS} FROM web_expense WHERE expense_id = ?`, [id]);
      await emitOutbox(conn, updated);
      return updated;
    });
    res.json({ expense: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [r] = await pool.query('DELETE FROM web_expense WHERE expense_id = ?', [id]);
    if (!r.affectedRows) throw new AppError(404, `Pengeluaran #${id} tidak ada.`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
