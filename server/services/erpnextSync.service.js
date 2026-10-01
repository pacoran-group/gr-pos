/**
 * Kirim Tutup Hari -> ERPNext sebagai 1 Journal Entry DRAFT per hari per
 * unit. Spesifikasi: INTEGRASI-ERPNEXT.md. Status per hari disimpan di
 * web_daily_close.erp_* (migration 025).
 *
 * Alur:
 *   1. dailyClose.generateAndPersist() menandai hari itu erp_status =
 *      'pending' (di DALAM transaksi DB - murni tulis lokal, tanpa jaringan),
 *      lalu memanggil kick() SETELAH commit.
 *   2. Worker (kick + interval ERPNEXT_RETRY_INTERVAL_MS) mengambil baris
 *      'pending'/'failed', membangun JE dari snapshot laporan tersimpan
 *      (web_daily_close.payload), cek idempotensi lewat custom field
 *      `custom_gr_pos_ref` (Unique di ERPNext), lalu POST. Gagal (ERP/
 *      internet mati) -> 'failed' + dicoba ulang otomatis.
 *   3. Gagal kirim TIDAK PERNAH membuat Tutup Hari sendiri gagal.
 *
 * JE dibuat DRAFT (tanpa docstatus) - Accounting review & Submit manual.
 */
const { pool } = require('../config/db');
const { UNIT_ID } = require('../config/unit');
const C = require('../config/erpnext');

const MAX_ATTEMPTS = 50;
const LOOKBACK_DAYS = 45;
let running = false;
let lastRun = null;

const r0 = (x) => Math.round(Number(x) || 0);

function remarkFor(unitId, businessDate) {
  return `gr-pos:${unitId}:${businessDate}`;
}

// ---------------------------------------------------------------------
// HTTP ke Frappe REST API
// ---------------------------------------------------------------------
function frappeError(status, body) {
  let msg = '';
  if (body && typeof body === 'object') {
    if (body._server_messages) {
      try {
        msg = JSON.parse(body._server_messages)
          .map((m) => { try { return JSON.parse(m).message; } catch { return m; } })
          .join(' | ');
      } catch { /* abaikan */ }
    }
    if (!msg && body.exception) msg = String(body.exception).split('\n')[0];
    if (!msg && body.message) msg = typeof body.message === 'string' ? body.message : JSON.stringify(body.message);
    if (!msg && body.exc_type) msg = body.exc_type;
  } else if (body) {
    msg = String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  const hint = status === 401 || status === 403
    ? ' (cek ERPNEXT_API_KEY/SECRET & hak akses akun integrasi)'
    : '';
  return new Error(`ERPNext HTTP ${status}: ${(msg || 'tanpa pesan').replace(/<[^>]+>/g, '')}${hint}`);
}

async function frappe(method, path, body) {
  if (typeof fetch !== 'function') throw new Error('global fetch tidak tersedia (butuh Node >= 18).');
  const missing = C.missingConfig().filter((k) => ['ERPNEXT_URL', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET'].includes(k));
  if (missing.length) throw new Error(`Config ERPNext belum lengkap di .env: ${missing.join(', ')}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), C.ERPNEXT_TIMEOUT_MS);
  try {
    const res = await fetch(C.ERPNEXT_URL + path, {
      method,
      headers: {
        Authorization: `token ${C.ERPNEXT_API_KEY}:${C.ERPNEXT_API_SECRET}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw frappeError(res.status, data);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`ERPNext tidak merespons dalam ${Math.round(C.ERPNEXT_TIMEOUT_MS / 1000)} detik.`);
    if (err.cause && err.cause.code) throw new Error(`Tidak bisa menghubungi ERPNext (${err.cause.code}).`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const resourcePath = (doctype, name) =>
  `/api/resource/${encodeURIComponent(doctype)}${name ? '/' + encodeURIComponent(name) : ''}`;

// ---------------------------------------------------------------------
// Payload Journal Entry
// ---------------------------------------------------------------------

/** Referensi unik per hari per unit, disimpan di custom field ERPNext. */
function refFor(unitId, businessDate) {
  return `${unitId}:${businessDate}`;
}

/** Fallback utk snapshot Tutup Hari lama (sebelum receipts_by_method ada):
 *  hitung penerimaan sebenarnya dari tabel pembayaran. */
async function liveReceipts(report) {
  const out = { tunai: 0, qris: 0, kartu: 0, lainnya: 0 };
  const ids = (report.transactions || []).map((t) => t.trans_id);
  if (!ids.length) return out;
  const [rows] = await pool.query(
    `SELECT LOWER(method) AS method, COALESCE(SUM(amount), 0) AS amt
       FROM web_tr_trans_payments
      WHERE trans_id IN (${ids.map(() => '?').join(',')})
      GROUP BY LOWER(method)`,
    ids
  );
  for (const r of rows) {
    const m = r.method === 'cash' ? 'tunai'
      : r.method === 'qris' ? 'qris'
      : ['card', 'debit', 'credit'].includes(r.method) ? 'kartu' : 'lainnya';
    out[m] += Number(r.amt);
  }
  return out;
}

const rp = (n) => 'Rp' + Math.round(n).toLocaleString('id-ID');

/**
 * Bangun payload JE dari `report` (snapshot Tutup Hari / computeReport).
 *
 * Debit  : Kas = tunai tercatat + SELISIH TUTUP KASIR (= uang yg benar-benar
 *          dihitung kasir; keputusan "Selisih A" 30 Sep 2026), Piutang QRIS,
 *          Piutang EDC Kartu - dari penerimaan SEBENARNYA (receipts_by_method),
 *          bukan payment_mix (perkiraan).
 * Kredit : Penjualan (DPP), Service Charge, PB1 - dari tagihan.
 * Selisih Kas Harian = penyeimbang: kasir kurang setor -> debit (nama kasir
 *          dicantumkan di user_remark utk ditagihkan), lebih -> kredit.
 *
 * Mengembalikan { skip, reason } kalau tidak perlu dikirim.
 */
async function buildJournalEntry(report) {
  const s = report.summary || {};
  const unitId = (report.unit && report.unit.unit_id) || UNIT_ID;
  const ref = refFor(unitId, report.business_date);
  const remarkHead = remarkFor(unitId, report.business_date);
  if (!s.closed_count) return { skip: true, reason: 'tidak ada transaksi selesai hari itu', ref, remark: remarkHead };

  const rec = report.receipts_by_method || (await liveReceipts(report));
  const shifts = (report.by_shift || []).filter((x) => x.variance != null);
  const variance = r0(shifts.reduce((a, x) => a + Number(x.variance), 0));

  const sc = r0(s.service_charge_total);
  const pb1 = r0(s.resto_tax_total);
  const dpp = r0(s.net_revenue) - sc;

  let kas = r0(rec.tunai) + r0(rec.lainnya) + variance;
  let qris = r0(rec.qris);
  let kartu = r0(rec.kartu);
  if (!C.ERPNEXT_ACCOUNT_QRIS) { kas += qris; qris = 0; }
  if (!C.ERPNEXT_ACCOUNT_KARTU) { kas += kartu; kartu = 0; }

  const debits = [[C.ERPNEXT_ACCOUNT_KAS, kas], [C.ERPNEXT_ACCOUNT_QRIS, qris], [C.ERPNEXT_ACCOUNT_KARTU, kartu]];
  const credits = [[C.ERPNEXT_ACCOUNT_PENJUALAN, dpp], [C.ERPNEXT_ACCOUNT_SC, sc], [C.ERPNEXT_ACCOUNT_PB1, pb1]];
  const diff = debits.reduce((a, [, v]) => a + v, 0) - credits.reduce((a, [, v]) => a + v, 0);

  const line = (account, debit, credit) => ({
    account,
    cost_center: C.ERPNEXT_COST_CENTER,
    debit_in_account_currency: debit,
    credit_in_account_currency: credit,
  });
  const accounts = [];
  for (const [acc, v] of debits) {
    if (v > 0) accounts.push(line(acc, v, 0));
    else if (v < 0) accounts.push(line(acc, 0, -v));
  }
  if (diff > 0) accounts.push(line(C.ERPNEXT_ACCOUNT_SELISIH, 0, diff));      // kas lebih
  else if (diff < 0) accounts.push(line(C.ERPNEXT_ACCOUNT_SELISIH, -diff, 0)); // kas kurang
  for (const [acc, v] of credits) {
    if (v > 0) accounts.push(line(acc, 0, v));
    else if (v < 0) accounts.push(line(acc, -v, 0));
  }

  const sumD = accounts.reduce((a, l) => a + l.debit_in_account_currency, 0);
  const sumC = accounts.reduce((a, l) => a + l.credit_in_account_currency, 0);
  if (sumD !== sumC) throw new Error(`JE tidak balance (debit ${sumD} vs kredit ${sumC}) - bug, jangan kirim.`);
  if (!sumD) return { skip: true, reason: 'semua nilai 0', ref, remark: remarkHead };

  // Keterangan utk Accounting: selisih per kasir (yang minus ditagihkan).
  const shiftNotes = shifts
    .filter((x) => r0(x.variance) !== 0)
    .map((x) => `${x.cashier_name} ${r0(x.variance) < 0 ? 'KURANG' : 'lebih'} ${rp(Math.abs(x.variance))} (shift #${x.id})`);
  const recorded = r0(rec.tunai) + r0(rec.lainnya) + r0(rec.qris) + r0(rec.kartu);
  const billed = dpp + sc + pb1;
  const remarkParts = [remarkHead];
  if (shiftNotes.length) remarkParts.push('Selisih Tutup Kasir: ' + shiftNotes.join('; '));
  if (recorded !== billed) remarkParts.push(`Pembayaran tercatat ${rp(recorded)} vs tagihan ${rp(billed)}`);

  return {
    skip: false,
    ref,
    remark: remarkParts.join(' | '),
    total: sumD,
    detail: { receipts: rec, shift_variance: variance, shift_notes: shiftNotes, recorded, billed, selisih: diff },
    payload: {
      doctype: 'Journal Entry',
      voucher_type: 'Journal Entry',
      company: C.ERPNEXT_COMPANY,
      posting_date: report.business_date,
      user_remark: remarkParts.join(' | '),
      [C.ERPNEXT_REF_FIELD]: ref,
      accounts,
    },
  };
}

/** Semua JE (termasuk yg di-cancel) utk referensi hari ini: `ref` & `ref#n`. */
async function findJournalEntries(ref) {
  // Dua query (persis & '#n') - BUKAN like 'ref%': 'KRK-GR:EXP-1%' juga
  // cocok dgn EXP-10..EXP-19 dst & bisa memotong hasil di limit.
  const out = [];
  for (const f of [[C.ERPNEXT_REF_FIELD, '=', ref], [C.ERPNEXT_REF_FIELD, 'like', `${ref}#%`]]) {
    const q = new URLSearchParams({
      filters: JSON.stringify([f]),
      fields: JSON.stringify(['name', 'docstatus', 'total_debit', C.ERPNEXT_REF_FIELD]),
      limit_page_length: '100',
    });
    const res = await frappe('GET', `${resourcePath('Journal Entry')}?${q}`);
    out.push(...((res && res.data) || []));
  }
  return out.filter((d) => {
    const v = String(d[C.ERPNEXT_REF_FIELD] || '');
    return v === ref || /^#\d+$/.test(v.slice(ref.length)) && v.startsWith(ref);
  });
}

/** Baris akun dinormalisasi -> string yg bisa dibandingkan. */
function linesKey(accounts) {
  return (accounts || [])
    .map((a) => `${a.account}|${r0(a.debit_in_account_currency)}|${r0(a.credit_in_account_currency)}`)
    .sort()
    .join('\n');
}

/** JE hari itu sudah ada. Bandingkan PER BARIS akun (bukan cuma total:
 *  selisih kasir berubah -> Kas & Selisih bergeser, total bisa sama). */
async function existsResult(ex, je) {
  let same = r0(ex.total_debit) === je.total;
  if (same) {
    try {
      const doc = await frappe('GET', resourcePath('Journal Entry', ex.name));
      same = linesKey(doc && doc.data && doc.data.accounts) === linesKey(je.payload.accounts);
    } catch (_) { /* tak bisa baca detail -> cukup banding total */ }
  }
  return {
    status: 'exists',
    doc: ex.name,
    note: same
      ? null
      : `JE ${ex.name} sudah ada tapi angkanya beda dgn laporan terbaru (total ${rp(je.total)}) - koreksi: cancel JE lama di ERPNext lalu tekan Kirim ke ERP lagi.`,
  };
}

/** Kirim 1 laporan. Mengembalikan { status, doc, note }. Tidak menyentuh DB. */
async function sendReport(report) {
  const missing = C.missingConfig();
  if (missing.length) throw new Error(`Config ERPNext belum lengkap di .env: ${missing.join(', ')}`);
  return sendJournalEntry(await buildJournalEntry(report));
}

/** Kirim 1 JE hasil build*: cek dobel via ref, kirim (akhiran #n kalau yang
 *  lama sudah di-cancel), tangani balapan Unique. Tidak menyentuh DB. */
async function sendJournalEntry(je) {
  if (je.skip) return { status: 'skipped', doc: null, note: je.reason };

  const all = await findJournalEntries(je.ref);
  const active = all.find((d) => Number(d.docstatus) !== 2);
  if (active) return existsResult(active, je);

  // Yang tersisa hanya JE yg sudah di-cancel -> field Unique masih memegang
  // `ref`, jadi kirim ulang memakai akhiran #2, #3, ...
  const payload = { ...je.payload };
  if (all.length) payload[C.ERPNEXT_REF_FIELD] = `${je.ref}#${all.length + 1}`;
  try {
    const res = await frappe('POST', resourcePath('Journal Entry'), payload);
    return { status: 'sent', doc: res && res.data && res.data.name, note: null };
  } catch (err) {
    // Balapan 2 proses: ERPNext menolak karena Unique -> anggap sudah ada.
    if (/Duplicate|UniqueValidation|unique|unik|sudah ada|already exists/i.test(err.message)) {
      const again = (await findJournalEntries(je.ref)).find((d) => Number(d.docstatus) !== 2);
      if (again) return existsResult(again, je);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Pengeluaran (migration 026): 1 JE draft per pengeluaran
// ---------------------------------------------------------------------
const EXPENSE_SQL = `SELECT e.expense_id, DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
    DATE_FORMAT(e.business_date, '%Y-%m-%d') AS business_date, e.vendor_name, e.category,
    c.label AS category_label, c.erp_account, e.amount, e.note, e.receipt_url, e.shift_id,
    s.status AS shift_status, u.full_name AS created_by_name
  FROM web_expense e
  LEFT JOIN web_expense_category c ON c.code = e.category
  LEFT JOIN web_cashier_shift s ON s.id = e.shift_id
  LEFT JOIN web_users u ON u.user_id = e.created_by_user_id`;

function expenseRef(id) {
  return `${UNIT_ID}:EXP-${id}`;
}

/**
 * Debit akun beban kategori / Kredit Kas Penjualan unit (tunai dari laci).
 * posting_date = hari usaha saat dicatat (uang keluar dari laci hari itu),
 * tanggal kuitansi masuk keterangan. Lihat migration 026.
 */
function buildExpenseJournalEntry(e) {
  const ref = expenseRef(e.expense_id);
  if (!e.category || !e.shift_id) return { skip: true, reason: 'pengeluaran lama (tanpa kategori/shift) - tidak dikirim', ref };
  if (!e.erp_account) return { skip: true, reason: `kategori '${e.category}' belum dipetakan ke akun ERPNext`, ref };
  const amount = r0(e.amount);
  if (!(amount > 0)) return { skip: true, reason: 'nominal 0', ref };
  const parts = [
    `gr-pos:${ref}`,
    `${e.category_label || e.category}: ${e.vendor_name}`,
    `kuitansi ${e.expense_date}`,
    `dicatat ${e.created_by_name || '-'} (shift #${e.shift_id})`,
  ];
  if (e.note) parts.push(e.note);
  if (e.receipt_url) parts.push(e.receipt_url);
  const line = (account, debit, credit) => ({
    account, cost_center: C.ERPNEXT_COST_CENTER,
    debit_in_account_currency: debit, credit_in_account_currency: credit,
  });
  const remark = parts.join(' | ');
  return {
    skip: false,
    ref,
    remark,
    total: amount,
    payload: {
      doctype: 'Journal Entry',
      voucher_type: 'Journal Entry',
      company: C.ERPNEXT_COMPANY,
      posting_date: e.business_date || e.expense_date,
      user_remark: remark,
      [C.ERPNEXT_REF_FIELD]: ref,
      accounts: [line(e.erp_account, amount, 0), line(C.ERPNEXT_ACCOUNT_KAS, 0, amount)],
    },
  };
}

async function processExpense(e) {
  try {
    const missing = C.missingConfig();
    if (missing.length) throw new Error(`Config ERPNext belum lengkap di .env: ${missing.join(', ')}`);
    const out = await sendJournalEntry(buildExpenseJournalEntry(e));
    await pool.query(
      `UPDATE web_expense SET erp_status = ?, erp_doc = ?, erp_error = ?, erp_synced_at = NOW(), erp_attempts = erp_attempts + 1
        WHERE expense_id = ?`,
      [out.status, out.doc, out.note ? String(out.note).slice(0, 500) : null, e.expense_id]
    );
    console.log(`[erpnext] pengeluaran #${e.expense_id}: ${out.status}${out.doc ? ' ' + out.doc : ''}${out.note ? ' - ' + out.note : ''}`);
    return { expense_id: e.expense_id, ...out };
  } catch (err) {
    await pool.query(
      "UPDATE web_expense SET erp_status = 'failed', erp_error = ?, erp_attempts = erp_attempts + 1 WHERE expense_id = ?",
      [String(err.message).slice(0, 500), e.expense_id]
    );
    console.error(`[erpnext] pengeluaran #${e.expense_id}: GAGAL - ${err.message}`);
    return { expense_id: e.expense_id, status: 'failed', error: err.message };
  }
}

/** Pengeluaran yang siap dikirim: shift sudah ditutup (terkunci). */
async function pendingExpenses() {
  const [rows] = await pool.query(
    `${EXPENSE_SQL}
      WHERE s.status = 'closed' AND e.category IS NOT NULL
        AND (e.erp_status IS NULL OR e.erp_status = 'pending'
             OR (e.erp_status = 'failed' AND e.erp_attempts < ? AND e.business_date >= CURDATE() - INTERVAL ? DAY))
      ORDER BY e.expense_id`,
    [MAX_ATTEMPTS, LOOKBACK_DAYS]
  );
  return rows;
}

async function getExpense(id) {
  const [[row]] = await pool.query(`${EXPENSE_SQL} WHERE e.expense_id = ?`, [id]);
  return row || null;
}

/** Kirim/kirim ulang 1 pengeluaran SEKARANG (admin). Hanya kalau shift tutup. */
async function sendExpenseNow(id) {
  const e = await getExpense(id);
  if (!e) return null;
  if (e.shift_status !== 'closed') {
    return { expense_id: id, status: 'skipped', note: 'shift kasir belum ditutup - pengeluaran baru dikirim setelah Tutup Kasir' };
  }
  await pool.query("UPDATE web_expense SET erp_status = 'pending', erp_attempts = 0 WHERE expense_id = ?", [id]);
  return processExpense(e);
}

// ---------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------
async function processRow(row) {
  const report = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  try {
    const out = await sendReport(report);
    await pool.query(
      `UPDATE web_daily_close
          SET erp_status = ?, erp_doc = ?, erp_error = ?, erp_synced_at = NOW(), erp_attempts = erp_attempts + 1
        WHERE unit_id = ? AND business_date = ?`,
      [out.status, out.doc, out.note ? String(out.note).slice(0, 500) : null, row.unit_id, row.business_date]
    );
    console.log(`[erpnext] ${report.business_date}: ${out.status}${out.doc ? ' ' + out.doc : ''}${out.note ? ' - ' + out.note : ''}`);
    return { business_date: report.business_date, ...out };
  } catch (err) {
    await pool.query(
      `UPDATE web_daily_close
          SET erp_status = 'failed', erp_error = ?, erp_attempts = erp_attempts + 1
        WHERE unit_id = ? AND business_date = ?`,
      [String(err.message).slice(0, 500), row.unit_id, row.business_date]
    );
    console.error(`[erpnext] ${report.business_date}: GAGAL - ${err.message}`);
    return { business_date: report.business_date, status: 'failed', error: err.message };
  }
}

let rerun = false;
async function tick() {
  if (!C.ERPNEXT_SENDER_ENABLED) return null;
  if (running) { rerun = true; return null; } // kick saat sedang jalan -> ulang setelah selesai
  running = true;
  try {
    const [rows] = await pool.query(
      `SELECT unit_id, business_date, payload FROM web_daily_close
        WHERE unit_id = ?
          AND (erp_status = 'pending'
               OR (erp_status = 'failed' AND erp_attempts < ? AND business_date >= CURDATE() - INTERVAL ? DAY))
        ORDER BY business_date`,
      [UNIT_ID, MAX_ATTEMPTS, LOOKBACK_DAYS]
    );
    const results = [];
    for (const row of rows) results.push(await processRow(row));
    for (const e of await pendingExpenses()) results.push(await processExpense(e));
    lastRun = { at: new Date().toISOString(), results };
    return lastRun;
  } catch (err) {
    console.error('[erpnext] tick error:', err.message);
    return null;
  } finally {
    running = false;
    if (rerun) { rerun = false; setImmediate(() => { tick().catch(() => {}); }); }
  }
}

/** Dipanggil setelah Tutup Hari / Tutup Kasir commit - kirim segera tanpa menunggu interval. */
function kick() {
  if (C.ERPNEXT_SENDER_ENABLED) setImmediate(() => { tick().catch(() => {}); });
}

/** Kirim/kirim ulang 1 tanggal SEKARANG (tombol di Reports). */
async function sendNow(businessDate) {
  const [[row]] = await pool.query(
    'SELECT unit_id, business_date, payload FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
    [UNIT_ID, businessDate]
  );
  if (!row) return null;
  await pool.query(
    "UPDATE web_daily_close SET erp_status = 'pending', erp_attempts = 0 WHERE unit_id = ? AND business_date = ?",
    [UNIT_ID, businessDate]
  );
  return processRow(row);
}

/** Cek read-only: koneksi, login akun integrasi, company, cost center, akun. */
async function checkSetup() {
  const checks = [];
  const add = async (what, name, fn) => {
    if (!name) { checks.push({ what, name: null, ok: false, error: 'belum diisi di .env' }); return; }
    try { await fn(); checks.push({ what, name, ok: true }); }
    catch (e) { checks.push({ what, name, ok: false, error: e.message }); }
  };
  let user = null;
  await add('Login API', C.ERPNEXT_URL || null, async () => {
    const r = await frappe('GET', '/api/method/frappe.auth.get_logged_user');
    user = r && r.message;
  });
  if (checks[0].ok) {
    // 403 = Company ADA tapi akun integrasi tak boleh membacanya (404 kalau
    // tidak ada). Membuat JE tidak butuh izin baca Company -> anggap OK.
    await add('Company', C.ERPNEXT_COMPANY, async () => {
      try { await frappe('GET', resourcePath('Company', C.ERPNEXT_COMPANY)); }
      catch (e) { if (!/HTTP 403/.test(e.message)) throw e; }
    });
    await add('Cost Center', C.ERPNEXT_COST_CENTER, () => frappe('GET', resourcePath('Cost Center', C.ERPNEXT_COST_CENTER)));
    // Akun harus ada, aktif, bukan grup, dan BUKAN Receivable/Payable: baris
    // JE ke akun Receivable/Payable wajib berisi Party (Customer/Supplier),
    // yang tidak dikirim gr-pos -> JE akan ditolak ERPNext.
    const checkAccount = async (acc) => {
      const r = await frappe('GET', resourcePath('Account', acc));
      const a = (r && r.data) || {};
      if (a.disabled) throw new Error('akun dinonaktifkan (disabled)');
      if (a.is_group) throw new Error('akun grup - pilih akun anak (bukan grup)');
      if (['Receivable', 'Payable'].includes(a.account_type)) {
        throw new Error(`Account Type = ${a.account_type}: baris JE wajib berisi Party - kosongkan Account Type akun ini di ERPNext`);
      }
    };
    const accs = [
      ['Akun Kas', C.ERPNEXT_ACCOUNT_KAS], ['Akun Selisih', C.ERPNEXT_ACCOUNT_SELISIH],
      ['Akun Penjualan', C.ERPNEXT_ACCOUNT_PENJUALAN], ['Akun Service Charge', C.ERPNEXT_ACCOUNT_SC],
      ['Akun PB1', C.ERPNEXT_ACCOUNT_PB1],
    ];
    if (C.ERPNEXT_ACCOUNT_QRIS) accs.push(['Akun QRIS', C.ERPNEXT_ACCOUNT_QRIS]);
    if (C.ERPNEXT_ACCOUNT_KARTU) accs.push(['Akun Kartu', C.ERPNEXT_ACCOUNT_KARTU]);
    // Akun beban kategori pengeluaran (migration 026), 1x per akun unik.
    try {
      const [cats] = await pool.query('SELECT erp_account, GROUP_CONCAT(label SEPARATOR ", ") AS labels FROM web_expense_category WHERE active = 1 GROUP BY erp_account');
      for (const c of cats) accs.push([`Akun pengeluaran (${c.labels})`, c.erp_account]);
    } catch (e) {
      checks.push({ what: 'Kategori pengeluaran', name: null, ok: false, error: 'migration 026 belum dijalankan' });
    }
    for (const [what, acc] of accs) await add(what, acc, () => checkAccount(acc));
    await add('Baca Journal Entry (field ' + C.ERPNEXT_REF_FIELD + ')', 'list', () => findJournalEntries('cek-koneksi'));
  }
  return { user, checks, ok: checks.every((c) => c.ok) };
}

function start(timers) {
  if (!C.ERPNEXT_SENDER_ENABLED) {
    console.log('[erpnext] sender STANDBY (ERPNEXT_SENDER_ENABLED != on).');
    return;
  }
  const missing = C.missingConfig();
  if (missing.length) console.warn(`[erpnext] sender ON tapi config belum lengkap: ${missing.join(', ')}`);
  const every = C.ERPNEXT_RETRY_INTERVAL_MS >= 60000
    ? `${Math.round(C.ERPNEXT_RETRY_INTERVAL_MS / 60000)} mnt`
    : `${Math.round(C.ERPNEXT_RETRY_INTERVAL_MS / 1000)} dtk`;
  console.log(`[erpnext] sender ENABLED -> ${C.ERPNEXT_URL} (retry tiap ${every})`);
  setTimeout(tick, 15000);
  timers.push(setInterval(tick, C.ERPNEXT_RETRY_INTERVAL_MS));
}

module.exports = {
  remarkFor,
  refFor,
  expenseRef,
  buildJournalEntry,
  buildExpenseJournalEntry,
  getExpense,
  sendExpenseNow,
  sendReport,
  sendNow,
  checkSetup,
  kick,
  tick,
  start,
  getLastRun: () => lastRun,
};
