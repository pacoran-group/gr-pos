/**
 * Tutup Kasir / Shift (klerek). Lihat migration 018_cashier_shift.sql.
 *
 * 1 shift = 1 kasir (user_id) di 1 terminal, dari "Buka Kasir" sampai
 * "Tutup Kasir". Semua baris web_tr_trans_payments yang dibuat user itu
 * selama shift terbuka ditandai shift_id (lihat trans.routes.js).
 *
 * Tutup Kasir: sistem hitung penjualan per metode + KAS SEHARUSNYA
 * (opening_float + penjualan tunai), kasir input KAS FISIK, sistem catat
 * SELISIH (+lebih / -kurang) + snapshot laporan.
 */
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');

const METHODS = ['tunai', 'qris', 'kartu', 'lainnya'];
function normMethod(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'cash' || s === 'tunai') return 'tunai';
  if (s === 'qris') return 'qris';
  if (s === 'card' || s === 'kartu' || s === 'debit' || s === 'credit') return 'kartu';
  return 'lainnya';
}

/** Shift terbuka milik user ini (di terminal manapun). null kalau tak ada. */
async function getOpenShift(userId, conn = pool) {
  const [rows] = await conn.query(
    "SELECT * FROM web_cashier_shift WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

/** id shift terbuka user ini, atau null. Dipakai saat menandai pembayaran. */
async function getOpenShiftId(conn, userId) {
  const [rows] = await conn.query(
    "SELECT id FROM web_cashier_shift WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows.length ? rows[0].id : null;
}

async function openShift({ userId, terminalId, openingFloat }) {
  const existing = await getOpenShift(userId);
  if (existing) {
    throw new AppError(409, `Kamu sudah punya shift terbuka (sejak ${fmt(existing.opened_at)}). Tutup dulu sebelum buka lagi.`);
  }
  const float = Math.max(0, Math.round(Number(openingFloat) || 0));
  const [r] = await pool.query(
    `INSERT INTO web_cashier_shift (user_id, terminal_id, status, opening_float)
     VALUES (?, ?, 'open', ?)`,
    [userId, terminalId || 'unknown', float]
  );
  return getShift(r.insertId);
}

async function getShift(shiftId, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM web_cashier_shift WHERE id = ?', [shiftId]);
  if (!rows.length) throw new AppError(404, `Shift ${shiftId} tidak ditemukan.`);
  return rows[0];
}

/**
 * Ringkasan angka shift. Untuk shift 'open', jendela = opened_at .. NOW().
 * Untuk 'closed', jendela = opened_at .. closed_at.
 */
async function computeShiftTotals(shiftId, conn = pool) {
  const shift = await getShift(shiftId, conn);

  const [payRows] = await conn.query(
    `SELECT p.kind, p.method, p.amount, p.trans_id
       FROM web_tr_trans_payments p
      WHERE p.shift_id = ?`,
    [shiftId]
  );

  const byMethod = Object.fromEntries(METHODS.map((m) => [m, { amount: 0, count: 0 }]));
  const byKind = { buka: 0, tambah: 0, settle: 0, refund: 0 };
  const transSet = new Set();
  let collected = 0;
  for (const p of payRows) {
    const mth = normMethod(p.method);
    const amt = Number(p.amount);
    byMethod[mth].amount += amt;
    byMethod[mth].count += 1;
    if (byKind[p.kind] != null) byKind[p.kind] += amt;
    collected += amt;
    transSet.add(p.trans_id);
  }

  // kamar dibuka & ditutup oleh kasir ini dalam jendela shift
  const winEnd = shift.status === 'closed' && shift.closed_at ? shift.closed_at : new Date();
  const [[openedRow]] = await conn.query(
    `SELECT COUNT(*) AS c FROM web_tr_trans
      WHERE opened_by_user_id = ? AND is_test = 0 AND start_time >= ? AND start_time <= ?`,
    [shift.user_id, shift.opened_at, winEnd]
  );
  const [[closedRow]] = await conn.query(
    `SELECT COUNT(*) AS c FROM web_tr_trans
      WHERE closed_by_user_id = ? AND status = 'closed' AND is_test = 0
        AND end_time >= ? AND end_time <= ?`,
    [shift.user_id, shift.opened_at, winEnd]
  );

  const opening_float = Number(shift.opening_float) || 0;
  const cash_sales = byMethod.tunai.amount;
  const expected_cash = opening_float + cash_sales; // v1: tanpa pengeluaran kas

  return {
    shift: {
      id: shift.id,
      user_id: shift.user_id,
      terminal_id: shift.terminal_id,
      status: shift.status,
      opened_at: fmt(shift.opened_at),
      closed_at: shift.closed_at ? fmt(shift.closed_at) : null,
      opening_float,
      counted_cash: shift.counted_cash == null ? null : Number(shift.counted_cash),
      expected_cash: shift.expected_cash == null ? null : Number(shift.expected_cash),
      variance: shift.variance == null ? null : Number(shift.variance),
      note: shift.note || null,
    },
    by_method: METHODS.map((m) => ({ method: m, amount: byMethod[m].amount, count: byMethod[m].count })),
    by_kind: byKind,
    totals: {
      collected,
      payment_count: payRows.length,
      trans_count: transSet.size,
      rooms_opened: Number(openedRow.c),
      rooms_closed: Number(closedRow.c),
    },
    cash: {
      opening_float,
      cash_sales,
      non_cash: byMethod.qris.amount + byMethod.kartu.amount + byMethod.lainnya.amount,
      expected_cash,
      counted_cash: shift.counted_cash == null ? null : Number(shift.counted_cash),
      variance: shift.variance == null ? null : Number(shift.variance),
    },
  };
}

async function closeShift({ shiftId, countedCash, note, closedByUserId }) {
  const shift = await getShift(shiftId);
  if (shift.status === 'closed') throw new AppError(409, 'Shift ini sudah ditutup.');

  const totals = await computeShiftTotals(shiftId);
  const counted = Math.round(Number(countedCash) || 0);
  const expected = totals.cash.expected_cash;
  const variance = counted - expected;

  await pool.query(
    `UPDATE web_cashier_shift
       SET status = 'closed', closed_at = NOW(), counted_cash = ?, expected_cash = ?,
           variance = ?, note = ?, closed_by_user_id = ?, totals_snapshot = ?
     WHERE id = ?`,
    [counted, expected, variance, (note || '').slice(0, 255) || null, closedByUserId,
      JSON.stringify({ ...totals, cash: { ...totals.cash, counted_cash: counted, variance } }), shiftId]
  );

  return computeShiftTotals(shiftId);
}

// --- format ---
const pad = (n) => String(n).padStart(2, '0');
function fmt(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  getOpenShift,
  getOpenShiftId,
  openShift,
  getShift,
  computeShiftTotals,
  closeShift,
  normMethod,
};
