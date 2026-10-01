/**
 * Pengeluaran unit. Lihat migration 013_expense.sql & 026_expense_shift_erp.sql.
 *
 * Menangkap TOTAL pengeluaran level-header (tanggal kuitansi, vendor,
 * kategori, total, catatan, link bukti kuitansi). Tidak ada rincian per-item.
 *
 * Sejak migration 026 (keputusan user 1 Okt 2026):
 *   - Semua pengeluaran dibayar TUNAI dari LACI KASIR. Yang mencatat (kasir,
 *     atau admin/supervisor dgn shift sendiri) WAJIB punya shift kasir yang
 *     sedang buka; pengeluaran memotong "kas seharusnya" shift itu
 *     (cashierShift.computeShiftTotals).
 *   - Kategori wajib -> menentukan akun beban di ERPNext (web_expense_category).
 *   - business_date = hari usaha saat DICATAT = posting_date JE di ERPNext.
 *   - Setelah shift-nya ditutup, pengeluaran TERKUNCI (tak bisa edit/hapus)
 *     lalu dikirim ke ERPNext (erpnextSync.service.js).
 *   - Kasir hanya melihat & mengubah pengeluaran yang ia catat sendiri.
 * Pengeluaran lama (shift_id NULL) hanya bisa diubah admin/supervisor.
 *
 * Kalau SYNC_OUTBOX_ENABLED, create/update juga menulis 1 baris
 * web_sync_outbox (aggregate 'expense').
 */
const crypto = require('crypto');
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { UNIT_ID, UNIT_NAME, SYNC_OUTBOX_ENABLED } = require('../config/unit');
const { defaultBusinessDate } = require('../services/dailyClose.service');

const router = express.Router();
router.use(requireAuth);
const MANAGE = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];
const RECORD = [...MANAGE, 'kasir'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// mysql2 mengembalikan kolom DATE sebagai objek Date (bergeser ke hari
// sebelumnya saat di-JSON di zona WIB). Format di SQL supaya klien terima
// string 'YYYY-MM-DD' apa adanya - konsisten dgn dailyClose.service.js.
const EXP_SELECT = `e.expense_id, DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
  e.vendor_name, e.category, c.label AS category_label, e.paying_unit, e.charged_unit,
  e.amount, e.note, e.receipt_url, e.created_by_user_id, e.created_at, e.updated_at,
  e.shift_id, DATE_FORMAT(e.business_date, '%Y-%m-%d') AS business_date,
  s.status AS shift_status, e.erp_status, e.erp_doc, e.erp_error,
  u.full_name AS created_by_name`;
const EXP_FROM = `FROM web_expense e
  LEFT JOIN web_expense_category c ON c.code = e.category
  LEFT JOIN web_cashier_shift s ON s.id = e.shift_id
  LEFT JOIN web_users u ON u.user_id = e.created_by_user_id`;

const isManager = (req) => MANAGE.includes(req.user.role);

/** Editable = shift masih buka (atau baris lama tanpa shift & user manager). */
function lockReason(row, req) {
  if (!isManager(req) && row.created_by_user_id !== req.user.user_id) {
    return 'Kasir hanya bisa mengubah pengeluaran yang ia catat sendiri.';
  }
  if (row.shift_id == null) {
    return isManager(req) ? null : 'Pengeluaran lama hanya bisa diubah admin/supervisor.';
  }
  if (row.shift_status !== 'open') {
    return 'Shift kasir untuk pengeluaran ini sudah ditutup - data terkunci (sudah/akan dikirim ke ERPNext). Koreksi lewat Accounting di ERPNext.';
  }
  return null;
}

async function activeCategories(conn = pool) {
  const [rows] = await conn.query(
    'SELECT code, label FROM web_expense_category WHERE active = 1 ORDER BY sort_order, label'
  );
  return rows;
}

async function parseBody(body, conn) {
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

  const category = String(b.category || '').trim();
  const cats = await activeCategories(conn);
  if (!cats.some((c) => c.code === category)) throw new AppError(400, 'Kategori pengeluaran wajib dipilih.');

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Total pengeluaran harus angka lebih dari 0.');
  if (amount > 1e12) throw new AppError(400, 'Total pengeluaran tidak masuk akal (terlalu besar).');

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

  return { expense_date, vendor_name, category, amount: Math.round(amount * 100) / 100, note, receipt_url };
}

function outboxPayload(row) {
  return {
    event_uid: crypto.randomUUID(),
    source_unit_id: UNIT_ID,
    expense_id: row.expense_id,
    expense_date: row.expense_date,
    business_date: row.business_date,
    vendor_name: row.vendor_name,
    category: row.category,
    paying_unit: row.paying_unit,
    charged_unit: row.charged_unit,
    amount: Number(row.amount),
    note: row.note,
    receipt_url: row.receipt_url,
    shift_id: row.shift_id,
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

async function fetchOne(conn, id) {
  const [[row]] = await conn.query(`SELECT ${EXP_SELECT} ${EXP_FROM} WHERE e.expense_id = ?`, [id]);
  return row || null;
}

// GET /api/expenses/categories
router.get('/categories', requireRole(...RECORD), async (req, res, next) => {
  try {
    res.json({ categories: await activeCategories() });
  } catch (err) {
    next(err);
  }
});

// GET /api/expenses[?from=YYYY-MM-DD&to=YYYY-MM-DD]
// Kasir: hanya pengeluaran yang ia catat sendiri.
router.get('/', requireRole(...RECORD), async (req, res, next) => {
  try {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;

    const where = [];
    const params = [];
    if (from) { where.push('e.expense_date >= ?'); params.push(from); }
    if (to) { where.push('e.expense_date <= ?'); params.push(to); }
    if (!isManager(req)) { where.push('e.created_by_user_id = ?'); params.push(req.user.user_id); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT ${EXP_SELECT} ${EXP_FROM} ${whereSql}
        ORDER BY e.expense_date DESC, e.expense_id DESC`,
      params
    );
    for (const r of rows) r.locked_reason = lockReason(r, req);
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

// POST /api/expenses - uang keluar dari laci shift kasir yang sedang buka.
router.post('/', requireRole(...RECORD), async (req, res, next) => {
  try {
    const row = await withTransaction(async (conn) => {
      const b = await parseBody(req.body, conn);
      const [[shift]] = await conn.query(
        "SELECT id FROM web_cashier_shift WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [req.user.user_id]
      );
      if (!shift) {
        throw new AppError(409, 'Buka Kasir dulu - pengeluaran dibayar dari laci kasir, jadi harus tercatat di shift kasir yang sedang buka.');
      }
      const [r] = await conn.query(
        `INSERT INTO web_expense
           (expense_date, vendor_name, category, shift_id, business_date, paying_unit, charged_unit,
            amount, note, receipt_url, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.expense_date, b.vendor_name, b.category, shift.id, defaultBusinessDate(), UNIT_NAME, UNIT_NAME,
          b.amount, b.note, b.receipt_url, req.user.user_id]
      );
      const created = await fetchOne(conn, r.insertId);
      await emitOutbox(conn, created);
      return created;
    });
    res.status(201).json({ expense: row });
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/:id - hanya selama shift-nya masih buka.
router.put('/:id', requireRole(...RECORD), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID pengeluaran tidak valid.');
    const row = await withTransaction(async (conn) => {
      await conn.query('SELECT expense_id FROM web_expense WHERE expense_id = ? FOR UPDATE', [id]);
      const ex = await fetchOne(conn, id);
      if (!ex) throw new AppError(404, `Pengeluaran #${id} tidak ada.`);
      const why = lockReason(ex, req);
      if (why) throw new AppError(409, why);
      const b = await parseBody(req.body, conn);
      await conn.query(
        `UPDATE web_expense SET expense_date = ?, vendor_name = ?, category = ?, amount = ?, note = ?, receipt_url = ?
          WHERE expense_id = ?`,
        [b.expense_date, b.vendor_name, b.category, b.amount, b.note, b.receipt_url, id]
      );
      const updated = await fetchOne(conn, id);
      await emitOutbox(conn, updated);
      return updated;
    });
    res.json({ expense: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/expenses/:id - hanya selama shift-nya masih buka.
router.delete('/:id', requireRole(...RECORD), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID pengeluaran tidak valid.');
    await withTransaction(async (conn) => {
      await conn.query('SELECT expense_id FROM web_expense WHERE expense_id = ? FOR UPDATE', [id]);
      const ex = await fetchOne(conn, id);
      if (!ex) throw new AppError(404, `Pengeluaran #${id} tidak ada.`);
      const why = lockReason(ex, req);
      if (why) throw new AppError(409, why);
      await conn.query('DELETE FROM web_expense WHERE expense_id = ?', [id]);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
