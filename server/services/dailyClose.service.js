/**
 * Laporan "Tutup Hari" (End-of-Day) - lihat migration 006_daily_close.sql.
 *
 * Manual: admin/supervisor memilih tanggal usaha -> computeReport() menghitung
 * angka -> generateAndPersist() menyimpan snapshot ke web_daily_close +
 * web_sync_outbox -> route mengirim email (renderHtmlEmail + toCsv).
 *
 * Fungsi di sini tidak menyentuh req/res. computeReport bisa dipanggil untuk
 * pratinjau live tanpa menyimpan.
 *
 * Filter angka: status='closed' AND is_test=0 AND end_time dalam jendela
 * hari usaha (lihat businessDayRange / config/report.js).
 * Metode bayar ternormalisasi: cash->tunai, qris->qris, debit|credit|card->kartu,
 * null/lainnya->lainnya (enum initial_payment_method & final_payment_method
 * memang berbeda di skema - satu peta norm() menangani keduanya).
 */
const crypto = require('crypto');
const { pool, withTransaction } = require('../config/db');
const { EOD_CUTOFF_HOUR } = require('../config/report');
const { UNIT_ID, UNIT_NAME, SYNC_OUTBOX_ENABLED } = require('../config/unit');
const { computeBill } = require('./bill');

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Jendela hari usaha untuk 'YYYY-MM-DD'.
 * D = [D EOD_CUTOFF_HOUR:00:00, (D+1) EOD_CUTOFF_HOUR:00:00). Naive WIB.
 */
function businessDayRange(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const start = new Date(y, m - 1, d, EOD_CUTOFF_HOUR, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, EOD_CUTOFF_HOUR, 0, 0, 0);
  return {
    start,
    end,
    start_str: fmtLocal(start),
    end_str: fmtLocal(end),
    business_date: dateStr,
  };
}

/** Tanggal usaha default: kalau sekarang < jam cutoff, berarti masih hari usaha kemarin. */
function defaultBusinessDate(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < EOD_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normMethod(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'cash') return 'tunai';
  if (s === 'qris') return 'qris';
  if (s === 'debit' || s === 'credit' || s === 'card') return 'kartu';
  return 'lainnya';
}

function emptyMethodSplit() {
  return { tunai: 0, qris: 0, kartu: 0, lainnya: 0 };
}

/**
 * Hitung laporan hari usaha. Tidak menyimpan apa pun.
 * @param {string} businessDateStr 'YYYY-MM-DD'
 * @param {object} [conn] koneksi/pool (default pool)
 */
async function computeReport(businessDateStr, conn = pool) {
  const range = businessDayRange(businessDateStr);
  const winParams = [range.start_str, range.end_str];

  // --- per-transaksi (closed, non-test, end_time dalam jendela) ---
  const [txRows] = await conn.query(
    `SELECT t.trans_id, t.room_id, t.room_type_snapshot, t.cust_name, t.person,
            t.waiter_id, t.member_id, t.member_disc_fnb, t.member_disc_room, t.promo_disc_fnb,
            t.service_charge_pct, t.initial_paid_amount, t.initial_payment_method,
            t.final_payment_method, t.extra_hours_used,
            t.opened_by_user_id, t.closed_by_user_id, t.start_time, t.end_time,
            ou.full_name AS opened_by_name, cu.full_name AS closed_by_name,
            COALESCE(r.room_name, CONCAT('Room ', t.room_id)) AS room_name,
            COALESCE(SUM(d.subtotal), 0) AS fnb_gross
       FROM web_tr_trans t
       LEFT JOIN web_tr_trans_details d ON d.trans_id = t.trans_id
       LEFT JOIN web_users ou ON ou.user_id = t.opened_by_user_id
       LEFT JOIN web_users cu ON cu.user_id = t.closed_by_user_id
       LEFT JOIN m_room   r  ON r.room_id  = t.room_id
      WHERE t.status = 'closed' AND t.is_test = 0
        AND t.end_time >= ? AND t.end_time < ?
      GROUP BY t.trans_id
      ORDER BY t.end_time`,
    winParams
  );

  // --- top produk ---
  const [topRows] = await conn.query(
    `SELECT d.product_id,
            MAX(d.product_name_snapshot) AS name,
            SUM(d.qty)       AS qty,
            SUM(d.subtotal)  AS value
       FROM web_tr_trans_details d
       JOIN web_tr_trans t ON t.trans_id = d.trans_id
      WHERE t.status = 'closed' AND t.is_test = 0
        AND t.end_time >= ? AND t.end_time < ?
      GROUP BY d.product_id
      ORDER BY qty DESC, value DESC
      LIMIT 20`,
    winParams
  );

  // --- void (terikat ke transaksi closed dalam jendela via t.end_time) ---
  const [voidRows] = await conn.query(
    `SELECT COUNT(*) AS c, COALESCE(SUM(v.subtotal_voided), 0) AS total
       FROM web_tr_trans_void v
       JOIN web_tr_trans t ON t.trans_id = v.trans_id
      WHERE t.status = 'closed' AND t.is_test = 0
        AND t.end_time >= ? AND t.end_time < ?`,
    winParams
  );

  // --- cancelled (tidak punya end_time; batal mem-bump updated_at) ---
  const [cancelRows] = await conn.query(
    `SELECT COUNT(*) AS c
       FROM web_tr_trans
      WHERE status = 'cancelled' AND is_test = 0
        AND updated_at >= ? AND updated_at < ?`,
    winParams
  );

  // --- kamar masih aktif (peringatan, tanpa jendela) ---
  const [activeRows] = await conn.query(
    `SELECT COUNT(*) AS c, MIN(start_time) AS oldest_start
       FROM web_tr_trans
      WHERE status = 'active' AND is_test = 0`
  );

  // --- agregasi di JS ---
  const transactions = [];
  const byCashier = new Map();
  const byRoomType = new Map();
  const paymentMix = emptyMethodSplit();
  const paymentMixCount = emptyMethodSplit();
  let dataQualityUnknownSettlement = 0;

  const sum = {
    fnb_gross: 0,
    disc_total: 0,
    promo_disc_total: 0,
    net_fnb: 0,
    service_charge_total: 0,
    net_revenue: 0,
    initial_paid_total: 0,
    sisa_bayar_total: 0,
  };

  for (const row of txRows) {
    const bill = computeBill(row, [{ subtotal: row.fnb_gross }]);
    const collected = bill.initial_paid_amount + bill.sisa_bayar;
    const tx = {
      trans_id: row.trans_id,
      room_id: row.room_id,
      room_name: row.room_name,
      room_type_snapshot: row.room_type_snapshot,
      cust_name: row.cust_name,
      person: row.person,
      waiter_id: row.waiter_id,
      member_id: row.member_id,
      opened_by_name: row.opened_by_name || (row.opened_by_user_id ? `User #${row.opened_by_user_id}` : ''),
      closed_by_user_id: row.closed_by_user_id,
      closed_by_name: row.closed_by_name || (row.closed_by_user_id ? `User #${row.closed_by_user_id}` : ''),
      start_time: fmtDT(row.start_time),
      end_time: fmtDT(row.end_time),
      extra_hours_used: row.extra_hours_used,
      initial_payment_method: row.initial_payment_method || null,
      final_payment_method: row.final_payment_method || null,
      ...bill,
      collected,
    };
    transactions.push(tx);

    sum.fnb_gross += bill.fnb_gross;
    sum.disc_total += bill.disc_total;
    sum.promo_disc_total += bill.promo_disc_fnb;
    sum.net_fnb += bill.net_fnb;
    sum.service_charge_total += bill.service_charge;
    sum.net_revenue += bill.grand_total;
    sum.initial_paid_total += bill.initial_paid_amount;
    sum.sisa_bayar_total += bill.sisa_bayar;

    // payment mix: deposit -> initial_payment_method ; pelunasan -> final_payment_method
    const depBucket = normMethod(row.initial_payment_method);
    const setBucket = normMethod(row.final_payment_method);
    paymentMix[depBucket] += bill.initial_paid_amount;
    paymentMix[setBucket] += bill.sisa_bayar;
    if (bill.initial_paid_amount > 0) paymentMixCount[depBucket] += 1;
    if (bill.sisa_bayar > 0) paymentMixCount[setBucket] += 1;
    if (bill.sisa_bayar > 0 && setBucket === 'lainnya') dataQualityUnknownSettlement += 1;

    // by cashier
    const ck = String(row.closed_by_user_id ?? 'null');
    if (!byCashier.has(ck)) {
      byCashier.set(ck, {
        cashier: tx.closed_by_name || 'Tidak diketahui',
        count: 0, fnb_gross: 0, disc_total: 0, service_charge: 0, grand_total: 0, collected: 0,
        methods: emptyMethodSplit(),
      });
    }
    accumGroup(byCashier.get(ck), bill, collected, depBucket, setBucket);

    // by room type
    const rk = row.room_type_snapshot || '(tanpa tipe)';
    if (!byRoomType.has(rk)) {
      byRoomType.set(rk, {
        room_type: rk,
        count: 0, fnb_gross: 0, disc_total: 0, service_charge: 0, grand_total: 0, collected: 0,
        methods: emptyMethodSplit(),
      });
    }
    accumGroup(byRoomType.get(rk), bill, collected, depBucket, setBucket);
  }

  const collected_total = sum.initial_paid_total + sum.sisa_bayar_total;
  const summary = {
    closed_count: txRows.length,
    fnb_gross: sum.fnb_gross,
    disc_total: sum.disc_total,
    promo_disc_total: sum.promo_disc_total,
    net_fnb: sum.net_fnb,
    service_charge_total: sum.service_charge_total,
    net_revenue: sum.net_revenue,
    initial_paid_total: sum.initial_paid_total,
    sisa_bayar_total: sum.sisa_bayar_total,
    collected_total,
    collected_vs_grand_gap: collected_total - sum.net_revenue,
    avg_per_txn: txRows.length ? Math.round(sum.net_revenue / txRows.length) : 0,
  };

  const payment_mix = ['tunai', 'qris', 'kartu', 'lainnya'].map((m) => ({
    method: m,
    amount: paymentMix[m],
    txn_count: paymentMixCount[m],
  }));

  return {
    unit: { unit_id: UNIT_ID, unit_name: UNIT_NAME },
    business_date: businessDateStr,
    eod_cutoff_hour: EOD_CUTOFF_HOUR,
    range_start: range.start_str,
    range_end: range.end_str,
    generated_at: fmtLocal(new Date()),
    summary,
    transactions,
    payment_mix,
    payment_mix_total: collected_total,
    by_cashier: [...byCashier.values()].sort((a, b) => b.grand_total - a.grand_total),
    by_room_type: [...byRoomType.values()].sort((a, b) => b.grand_total - a.grand_total),
    top_products: topRows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      qty: Number(r.qty),
      value: Number(r.value),
    })),
    voids: { count: Number(voidRows[0].c), total: Number(voidRows[0].total) },
    cancelled_count: Number(cancelRows[0].c),
    active_open_count: Number(activeRows[0].c),
    active_open_oldest_start: activeRows[0].oldest_start ? fmtDT(activeRows[0].oldest_start) : null,
    data_quality: dataQualityUnknownSettlement
      ? { unknown_settlement_method_txns: dataQualityUnknownSettlement }
      : null,
  };
}

function accumGroup(g, bill, collected, depBucket, setBucket) {
  g.count += 1;
  g.fnb_gross += bill.fnb_gross;
  g.disc_total += bill.disc_total;
  g.service_charge += bill.service_charge;
  g.grand_total += bill.grand_total;
  g.collected += collected;
  g.methods[depBucket] += bill.initial_paid_amount;
  g.methods[setBucket] += bill.sisa_bayar;
}

/** mysql2 mengembalikan DATETIME sbg Date (timezone lokal). Format ke string stabil. */
function fmtDT(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : fmtLocal(d);
}

/**
 * Hitung + simpan snapshot ke web_daily_close (upsert, version++) +
 * web_sync_outbox (event daily_close, kalau SYNC_OUTBOX_ENABLED).
 * @returns {Promise<{row: object, report: object}>}
 */
async function generateAndPersist(businessDateStr, userId) {
  return withTransaction(async (conn) => {
    const report = await computeReport(businessDateStr, conn);

    await conn.query(
      `INSERT INTO web_daily_close
         (unit_id, business_date, version, generated_at, generated_by_user_id,
          range_start, range_end, payload, csv_row_count)
       VALUES (?, ?, 1, NOW(), ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         version = version + 1,
         generated_at = NOW(),
         generated_by_user_id = VALUES(generated_by_user_id),
         range_start = VALUES(range_start),
         range_end = VALUES(range_end),
         payload = VALUES(payload),
         csv_row_count = VALUES(csv_row_count),
         email_error = NULL`,
      [
        UNIT_ID, businessDateStr, userId ?? null,
        report.range_start, report.range_end,
        JSON.stringify(report), report.summary.closed_count,
      ]
    );

    if (SYNC_OUTBOX_ENABLED) {
      const eventUid = crypto.randomUUID();
      await conn.query(
        `INSERT INTO web_sync_outbox (event_uid, aggregate, aggregate_id, unit_id, payload)
         VALUES (?, 'daily_close', ?, ?, ?)`,
        [eventUid, `${UNIT_ID}:${businessDateStr}`, UNIT_ID, JSON.stringify({ event_uid: eventUid, ...report })]
      );
    }

    const [[row]] = await conn.query(
      'SELECT * FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
      [UNIT_ID, businessDateStr]
    );
    return { row, report };
  });
}

// --- CSV (RFC4180) ---
const CSV_COLUMNS = [
  'business_date', 'trans_id', 'room_name', 'room_id', 'room_type_snapshot',
  'cust_name', 'person', 'opened_by_name', 'closed_by_name', 'start_time', 'end_time',
  'extra_hours_used', 'fnb_gross', 'member_disc_fnb', 'member_disc_room', 'promo_disc_fnb', 'disc_total',
  'net_fnb', 'service_charge_pct', 'service_charge', 'grand_total', 'initial_paid_amount',
  'initial_payment_method', 'sisa_bayar', 'final_payment_method', 'member_id', 'waiter_id',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsv(report) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const tx of report.transactions || []) {
    const rec = { business_date: report.business_date, ...tx };
    lines.push(CSV_COLUMNS.map((c) => csvCell(rec[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function csvFilename(businessDate) {
  return `tutup-hari_${UNIT_ID}_${businessDate}.csv`;
}

// --- Email ---
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function subjectFor(report) {
  return `[GR POS] Tutup Hari ${report.unit.unit_name} — ${report.business_date} — ${rp(report.summary.net_revenue)}`;
}

function tbl(headers, rows) {
  const th = headers
    .map((h) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px">${esc(h)}</th>`)
    .join('');
  const trs = rows
    .map(
      (r) =>
        '<tr>' +
        r
          .map(
            (c, i) =>
              `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px${i === 0 ? '' : ';text-align:right'}">${c}</td>`
          )
          .join('') +
        '</tr>'
    )
    .join('');
  return `<table style="border-collapse:collapse;width:100%;margin:6px 0 18px">${`<thead><tr>${th}</tr></thead>`}<tbody>${trs}</tbody></table>`;
}

function renderHtmlEmail(report) {
  const s = report.summary;
  const warnRed = (v) => (v ? 'color:#c0392b;font-weight:bold' : 'color:#333');

  const summaryTable = tbl(
    ['Ringkasan', 'Nilai'],
    [
      ['Transaksi selesai', s.closed_count.toLocaleString('id-ID')],
      ['F&amp;B bruto', rp(s.fnb_gross)],
      ['Diskon promo', '-' + rp(s.promo_disc_total || 0)],
      ['Diskon total', '-' + rp(s.disc_total)],
      ['F&amp;B bersih', rp(s.net_fnb)],
      ['Service charge', rp(s.service_charge_total)],
      ['<b>Pendapatan (grand total)</b>', '<b>' + rp(s.net_revenue) + '</b>'],
      ['Deposit diterima', rp(s.initial_paid_total)],
      ['Pelunasan diterima', rp(s.sisa_bayar_total)],
      ['Total terkumpul', rp(s.collected_total)],
      [
        'Selisih terkumpul vs pendapatan',
        `<span style="${warnRed(s.collected_vs_grand_gap)}">${rp(s.collected_vs_grand_gap)}</span>`,
      ],
      ['Rata-rata per transaksi', rp(s.avg_per_txn)],
    ]
  );

  const payTable = tbl(
    ['Metode', 'Jumlah', 'Nilai'],
    report.payment_mix.map((p) => [esc(p.method), p.txn_count.toLocaleString('id-ID'), rp(p.amount)])
  );

  const cashierTable = tbl(
    ['Kasir', 'Transaksi', 'Pendapatan', 'Tunai', 'QRIS', 'Kartu', 'Lainnya'],
    report.by_cashier.map((c) => [
      esc(c.cashier),
      c.count.toLocaleString('id-ID'),
      rp(c.grand_total),
      rp(c.methods.tunai),
      rp(c.methods.qris),
      rp(c.methods.kartu),
      rp(c.methods.lainnya),
    ])
  );

  const roomTypeTable = tbl(
    ['Tipe kamar', 'Transaksi', 'F&amp;B bruto', 'Service charge', 'Pendapatan'],
    report.by_room_type.map((r) => [
      esc(r.room_type),
      r.count.toLocaleString('id-ID'),
      rp(r.fnb_gross),
      rp(r.service_charge),
      rp(r.grand_total),
    ])
  );

  const topTable = tbl(
    ['Produk', 'Qty', 'Nilai'],
    report.top_products.map((p) => [esc(p.name), p.qty.toLocaleString('id-ID'), rp(p.value)])
  );

  const dq = report.data_quality
    ? `<p style="color:#c0392b;font-size:12px">Catatan data: ${report.data_quality.unknown_settlement_method_txns} transaksi punya pelunasan tapi metode bayar akhir tidak tercatat (masuk "lainnya").</p>`
    : '';

  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#333;max-width:820px;margin:0 auto">
    <h2 style="margin:0 0 4px">Tutup Hari — ${esc(report.unit.unit_name)}</h2>
    <p style="margin:0 0 2px;font-size:13px"><b>Tanggal usaha:</b> ${esc(report.business_date)}
       (${esc(report.range_start)} s/d ${esc(report.range_end)} WIB)</p>
    <p style="margin:0 0 18px;font-size:12px;color:#777">Dibuat ${esc(report.generated_at)} · unit ${esc(report.unit.unit_id)}</p>

    <h3 style="margin:0 0 2px;font-size:14px">Ringkasan</h3>
    ${summaryTable}
    <h3 style="margin:0 0 2px;font-size:14px">Rincian penerimaan per metode</h3>
    ${payTable}
    <h3 style="margin:0 0 2px;font-size:14px">Per kasir</h3>
    ${cashierTable}
    <h3 style="margin:0 0 2px;font-size:14px">Per tipe kamar</h3>
    ${roomTypeTable}
    <h3 style="margin:0 0 2px;font-size:14px">Produk terlaris</h3>
    ${topTable}

    <p style="font-size:12px">
      Void: ${report.voids.count.toLocaleString('id-ID')} item · ${rp(report.voids.total)}<br/>
      Transaksi dibatalkan: ${report.cancelled_count.toLocaleString('id-ID')}<br/>
      <span style="${warnRed(report.active_open_count)}">Kamar masih aktif saat laporan dibuat: ${report.active_open_count.toLocaleString('id-ID')}${
        report.active_open_oldest_start ? ` (terlama sejak ${esc(report.active_open_oldest_start)})` : ''
      }</span>
    </p>
    ${dq}
    <p style="font-size:11px;color:#999">Rincian per transaksi ada di lampiran CSV. Pendapatan = F&amp;B bersih + service charge (tidak ada charge sewa kamar / PPN terpisah di sistem ini).</p>
  </body></html>`;
}

module.exports = {
  businessDayRange,
  defaultBusinessDate,
  computeReport,
  generateAndPersist,
  toCsv,
  csvFilename,
  subjectFor,
  renderHtmlEmail,
};
