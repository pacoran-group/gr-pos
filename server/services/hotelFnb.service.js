/**
 * Modul "F&B Hotel" - lihat migration 007_fnb_hotel.sql.
 *
 * Order F&B untuk tamu hotel diinput oleh kasir karaoke (katalog m_product
 * yang sama) + nomor kamar hotel (teks). Disimpan di web_fnb_hotel_order /
 * _details - TERPISAH dari web_tr_trans supaya omzet karaoke tidak
 * tercampur. Tiket dapur memakai rail cetak yang ada (web_print_log,
 * destination='dapur_screen') dengan room_name = "HOTEL - Kamar X".
 *
 * Service charge INKLUSIF (harga menu = harga final): komponen dihitung
 * mundur, sc = round(total * pct / (100 + pct)). Front desk hotel posting
 * `total_amount` apa adanya ke folio kamar.
 *
 * Rekap harian (web_fnb_hotel_close) & email mencermin modul Tutup Hari.
 */
const crypto = require('crypto');
const { pool, withTransaction } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { queuePrint } = require('./printQueue.service');
const { businessDayRange, defaultBusinessDate } = require('./dailyClose.service');
const { EOD_CUTOFF_HOUR } = require('../config/report');
const { UNIT_ID, SYNC_OUTBOX_ENABLED } = require('../config/unit');
const {
  HOTEL_UNIT_ID, HOTEL_NAME, HOTEL_FNB_SC_PCT,
} = require('../config/hotel');

const pad = (n) => String(n).padStart(2, '0');

function generateOrderId(date = new Date()) {
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `HFB-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** mysql2 DATETIME/DATE -> string lokal stabil (hindari geser UTC di JSON). */
function fmtDT(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- idempotensi (pakai tabel web_idempotency_key yang sudah ada) ---
const IDEMPOTENCY_ENDPOINT = 'hotel_fnb_order';
async function getIdempotent(conn, requestKey) {
  if (!requestKey) return null;
  const [rows] = await conn.query(
    'SELECT response_snapshot FROM web_idempotency_key WHERE endpoint = ? AND request_key = ? FOR UPDATE',
    [IDEMPOTENCY_ENDPOINT, requestKey]
  );
  if (!rows.length) return null;
  const s = rows[0].response_snapshot;
  return typeof s === 'string' ? JSON.parse(s) : s;
}
async function saveIdempotent(conn, requestKey, refId, response) {
  if (!requestKey) return;
  await conn.query(
    'INSERT INTO web_idempotency_key (endpoint, request_key, trans_id, response_snapshot) VALUES (?, ?, ?, ?)',
    [IDEMPOTENCY_ENDPOINT, requestKey, refId || null, JSON.stringify(response)]
  );
}

/** Harga item dari m_product (all-in). Validasi produk aktif + qty > 0. */
async function priceItems(conn, items) {
  if (!items || !items.length) throw new AppError(400, 'Tidak ada item.');
  const ids = items.map((i) => String(i.product_id));
  const [rows] = await conn.query(
    `SELECT CAST(prod_id AS CHAR) AS product_id, prod_desc AS product_name, harga_jual AS price
       FROM m_product
      WHERE prod_id IN (${ids.map(() => '?').join(',')}) AND is_active = 'TRUE'`,
    ids
  );
  const byId = Object.fromEntries(rows.map((r) => [r.product_id, r]));
  return items.map((i) => {
    const p = byId[String(i.product_id)];
    if (!p) throw new AppError(400, `Produk ${i.product_id} tidak ditemukan / tidak aktif.`);
    const qty = Number(i.qty) || 0;
    if (qty <= 0) throw new AppError(400, `Qty produk ${i.product_id} harus lebih dari 0.`);
    const price = Number(p.price);
    return {
      product_id: p.product_id,
      product_name_snapshot: p.product_name,
      qty,
      price,
      subtotal: price * qty,
    };
  });
}

function scBreakdown(total) {
  const pct = HOTEL_FNB_SC_PCT;
  const sc = Math.round((total * pct) / (100 + pct));
  return { sc_pct: pct, sc_component: sc, base_amount: total - sc };
}

/** Ambil print job local_qz yang baru di-queue utk order ini (utk dicetak di kasir). */
async function fetchLocalPrintJobs(conn, orderId) {
  const [rows] = await conn.query(
    `SELECT id, print_type, printer_target, payload_snapshot
       FROM web_print_log
      WHERE trans_id = ? AND destination = 'local_qz' AND status = 'pending'
      ORDER BY id`,
    [orderId]
  );
  return rows.map((r) => ({
    print_log_id: r.id,
    print_type: r.print_type,
    printer_target: r.printer_target,
    payload: typeof r.payload_snapshot === 'string' ? JSON.parse(r.payload_snapshot) : r.payload_snapshot,
  }));
}

/**
 * Buat order F&B hotel. Dipanggil di dalam withTransaction.
 * @returns {{order_id, total_amount, sc_pct, sc_component, base_amount, items, print_jobs}}
 */
async function createOrder(conn, { hotelRoomNo, custName, items, note, userId, userName, terminalId }) {
  const roomNo = String(hotelRoomNo || '').trim();
  if (!roomNo) throw new AppError(400, 'Nomor kamar hotel wajib diisi.');

  const priced = await priceItems(conn, items);
  const total = priced.reduce((s, it) => s + it.subtotal, 0);
  const { sc_pct, sc_component, base_amount } = scBreakdown(total);
  const orderId = generateOrderId();
  const nowIso = new Date().toISOString();

  await conn.query(
    `INSERT INTO web_fnb_hotel_order
       (order_id, unit_id, hotel_unit_id, hotel_room_no, cust_name, charge_mode,
        total_amount, sc_pct, sc_component, base_amount, status, note,
        created_by_user_id, created_at_terminal)
     VALUES (?, ?, ?, ?, ?, 'folio', ?, ?, ?, ?, 'sent', ?, ?, ?)`,
    [
      orderId, UNIT_ID, HOTEL_UNIT_ID, roomNo, (custName || '').trim() || null,
      total, sc_pct, sc_component, base_amount, (note || '').trim() || null,
      userId, terminalId,
    ]
  );
  for (const it of priced) {
    await conn.query(
      `INSERT INTO web_fnb_hotel_order_details
         (order_id, product_id, product_name_snapshot, qty, price, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, it.product_id, it.product_name_snapshot, it.qty, it.price, it.subtotal]
    );
  }

  const roomLabel = `HOTEL - Kamar ${roomNo}`;

  // Tiket dapur (SEMUA item - dapur menyiapkan seluruh nampan hotel).
  await queuePrint(conn, {
    transId: orderId,
    printType: 'tiket_dapur',
    printerTarget: 'thermal',
    destination: 'dapur_screen',
    payload: {
      trans_id: orderId,
      room_id: 0,
      room_name: roomLabel,
      items: priced.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
    },
  });

  // Slip arsip di printer thermal kasir.
  await queuePrint(conn, {
    transId: orderId,
    printType: 'slip_fnb_hotel',
    printerTarget: 'thermal',
    destination: 'local_qz',
    payload: {
      order_id: orderId,
      hotel_room_no: roomNo,
      cust_name: (custName || '').trim() || null,
      items: priced,
      total_amount: total,
      sc_pct,
      sc_component,
      created_by: userName || null,
      created_at: nowIso,
    },
  });

  const print_jobs = await fetchLocalPrintJobs(conn, orderId);
  return {
    order_id: orderId,
    total_amount: total,
    sc_pct,
    sc_component,
    base_amount,
    items: priced,
    print_jobs,
  };
}

/** Batalkan order (status 'sent' -> 'cancelled'), cetak tiket batal ke dapur. */
async function cancelOrder(conn, orderId, { userId, reason }) {
  const rsn = String(reason || '').trim();
  if (!rsn) throw new AppError(400, 'Alasan pembatalan wajib diisi.');

  const [rows] = await conn.query(
    'SELECT * FROM web_fnb_hotel_order WHERE order_id = ? FOR UPDATE',
    [orderId]
  );
  if (!rows.length) throw new AppError(404, 'Order F&B hotel tidak ditemukan.');
  const order = rows[0];
  if (order.status !== 'sent') throw new AppError(409, `Order sudah ${order.status}, tidak bisa dibatalkan.`);

  await conn.query(
    `UPDATE web_fnb_hotel_order
        SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_reason = ?, cancelled_at = NOW()
      WHERE order_id = ?`,
    [userId, rsn, orderId]
  );

  const [dets] = await conn.query(
    'SELECT product_name_snapshot, qty FROM web_fnb_hotel_order_details WHERE order_id = ?',
    [orderId]
  );
  await queuePrint(conn, {
    transId: orderId,
    printType: 'tiket_dapur_batal',
    printerTarget: 'thermal',
    destination: 'dapur_screen',
    payload: {
      trans_id: orderId,
      room_id: 0,
      room_name: `HOTEL - Kamar ${order.hotel_room_no}`,
      items: dets.map((d) => ({ product_name: d.product_name_snapshot, qty: d.qty })),
    },
  });

  return { ok: true };
}

// =====================================================================
// Rekap harian
// =====================================================================

async function computeReport(businessDateStr, conn = pool) {
  const range = businessDayRange(businessDateStr);
  const win = [range.start_str, range.end_str];

  const [orders] = await conn.query(
    `SELECT o.order_id, o.hotel_room_no, o.cust_name, o.charge_mode, o.status,
            o.total_amount, o.sc_pct, o.sc_component, o.base_amount,
            o.created_at, o.created_by_user_id, cu.full_name AS created_by_name,
            o.cancelled_at, o.cancelled_reason, o.cancelled_by_user_id, xu.full_name AS cancelled_by_name
       FROM web_fnb_hotel_order o
       LEFT JOIN web_users cu ON cu.user_id = o.created_by_user_id
       LEFT JOIN web_users xu ON xu.user_id = o.cancelled_by_user_id
      WHERE o.created_at >= ? AND o.created_at < ?
      ORDER BY o.created_at`,
    win
  );

  const orderIds = orders.map((o) => o.order_id);
  let detailsByOrder = {};
  if (orderIds.length) {
    const [dets] = await conn.query(
      `SELECT order_id, product_name_snapshot AS name, qty, price, subtotal
         FROM web_fnb_hotel_order_details
        WHERE order_id IN (${orderIds.map(() => '?').join(',')})
        ORDER BY id`,
      orderIds
    );
    for (const d of dets) {
      (detailsByOrder[d.order_id] = detailsByOrder[d.order_id] || []).push({
        name: d.name, qty: d.qty, price: Number(d.price), subtotal: Number(d.subtotal),
      });
    }
  }

  const byRoomMap = new Map();
  const cancelled = { count: 0, total: 0, orders: [] };
  let orderCount = 0;
  let totalAmount = 0;
  let scTotal = 0;
  let baseTotal = 0;

  for (const o of orders) {
    const shaped = {
      order_id: o.order_id,
      created_at: fmtDT(o.created_at),
      created_by_name: o.created_by_name || (o.created_by_user_id ? `User #${o.created_by_user_id}` : ''),
      cust_name: o.cust_name,
      charge_mode: o.charge_mode,
      total_amount: Number(o.total_amount),
      sc_pct: Number(o.sc_pct),
      sc_component: Number(o.sc_component),
      base_amount: Number(o.base_amount),
      items: detailsByOrder[o.order_id] || [],
    };

    if (o.status === 'cancelled') {
      cancelled.count += 1;
      cancelled.total += Number(o.total_amount);
      cancelled.orders.push({
        order_id: o.order_id,
        hotel_room_no: o.hotel_room_no,
        total_amount: Number(o.total_amount),
        cancelled_reason: o.cancelled_reason,
        cancelled_by_name: o.cancelled_by_name || (o.cancelled_by_user_id ? `User #${o.cancelled_by_user_id}` : ''),
        cancelled_at: fmtDT(o.cancelled_at),
      });
      continue;
    }

    orderCount += 1;
    totalAmount += shaped.total_amount;
    scTotal += shaped.sc_component;
    baseTotal += shaped.base_amount;

    const key = o.hotel_room_no;
    if (!byRoomMap.has(key)) {
      byRoomMap.set(key, {
        hotel_room_no: key, order_count: 0, total_amount: 0, sc_component: 0, base_amount: 0, orders: [],
      });
    }
    const g = byRoomMap.get(key);
    g.order_count += 1;
    g.total_amount += shaped.total_amount;
    g.sc_component += shaped.sc_component;
    g.base_amount += shaped.base_amount;
    g.orders.push(shaped);
  }

  const by_room = [...byRoomMap.values()].sort((a, b) => b.total_amount - a.total_amount);

  return {
    hotel: { hotel_unit_id: HOTEL_UNIT_ID, hotel_name: HOTEL_NAME },
    unit_id: UNIT_ID,
    business_date: businessDateStr,
    eod_cutoff_hour: EOD_CUTOFF_HOUR,
    sc_pct: HOTEL_FNB_SC_PCT,
    range_start: range.start_str,
    range_end: range.end_str,
    generated_at: fmtDT(new Date()),
    summary: {
      order_count: orderCount,
      room_count: by_room.length,
      total_amount: totalAmount,
      sc_component_total: scTotal,
      base_amount_total: baseTotal,
    },
    by_room,
    cancelled,
  };
}

async function generateAndPersist(businessDateStr, userId) {
  return withTransaction(async (conn) => {
    const report = await computeReport(businessDateStr, conn);
    await conn.query(
      `INSERT INTO web_fnb_hotel_close
         (unit_id, business_date, version, generated_at, generated_by_user_id,
          range_start, range_end, payload, order_count, total_amount)
       VALUES (?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         version = version + 1, generated_at = NOW(),
         generated_by_user_id = VALUES(generated_by_user_id),
         range_start = VALUES(range_start), range_end = VALUES(range_end),
         payload = VALUES(payload), order_count = VALUES(order_count),
         total_amount = VALUES(total_amount), email_error = NULL`,
      [
        HOTEL_UNIT_ID, businessDateStr, userId ?? null,
        report.range_start, report.range_end, JSON.stringify(report),
        report.summary.order_count, report.summary.total_amount,
      ]
    );

    if (SYNC_OUTBOX_ENABLED) {
      const eventUid = crypto.randomUUID();
      await conn.query(
        `INSERT INTO web_sync_outbox (event_uid, aggregate, aggregate_id, unit_id, payload)
         VALUES (?, 'hotel_fnb_close', ?, ?, ?)`,
        [eventUid, `${HOTEL_UNIT_ID}:${businessDateStr}`, HOTEL_UNIT_ID, JSON.stringify({ event_uid: eventUid, ...report })]
      );
    }

    const [[row]] = await conn.query(
      'SELECT * FROM web_fnb_hotel_close WHERE unit_id = ? AND business_date = ?',
      [HOTEL_UNIT_ID, businessDateStr]
    );
    return { row, report };
  });
}

// --- CSV (RFC4180): 1 baris per baris-item ---
const CSV_COLUMNS = [
  'business_date', 'order_id', 'hotel_room_no', 'cust_name', 'created_at', 'created_by_name',
  'charge_mode', 'status', 'product_name', 'qty', 'price', 'subtotal',
  'order_total_amount', 'order_sc_component', 'order_base_amount',
];
function csvCell(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
function toCsv(report) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  const push = (o, status, it) => {
    const rec = {
      business_date: report.business_date,
      order_id: o.order_id,
      hotel_room_no: o.hotel_room_no,
      cust_name: o.cust_name,
      created_at: o.created_at,
      created_by_name: o.created_by_name,
      charge_mode: o.charge_mode,
      status,
      product_name: it ? it.name : '',
      qty: it ? it.qty : '',
      price: it ? it.price : '',
      subtotal: it ? it.subtotal : '',
      order_total_amount: o.total_amount,
      order_sc_component: o.sc_component,
      order_base_amount: o.base_amount,
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(rec[c])).join(','));
  };
  for (const room of report.by_room || []) {
    for (const o of room.orders) {
      const oo = { ...o, hotel_room_no: room.hotel_room_no };
      if (o.items.length) for (const it of o.items) push(oo, 'sent', it);
      else push(oo, 'sent', null);
    }
  }
  for (const c of (report.cancelled && report.cancelled.orders) || []) {
    push({ ...c, created_at: '', created_by_name: '', charge_mode: '', sc_component: '', base_amount: '' }, 'cancelled', null);
  }
  return lines.join('\r\n') + '\r\n';
}
function csvFilename(bd) {
  return `fnb-hotel_${HOTEL_UNIT_ID}_${bd}.csv`;
}

// --- Email ---
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function subjectFor(report) {
  return `[GR POS] F&B Hotel ${report.hotel.hotel_name} — ${report.business_date} — ${rp(report.summary.total_amount)}`;
}

function tbl(headers, rows) {
  const th = headers
    .map((h) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px">${esc(h)}</th>`)
    .join('');
  const trs = rows
    .map((r) => '<tr>' + r
      .map((c, i) => `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px${i === 0 ? '' : ';text-align:right'}">${c}</td>`)
      .join('') + '</tr>')
    .join('');
  return `<table style="border-collapse:collapse;width:100%;margin:6px 0 18px"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function renderHtmlEmail(report) {
  const s = report.summary;
  const roomRows = report.by_room.map((r) => [
    esc(r.hotel_room_no),
    Number(r.order_count).toLocaleString('id-ID'),
    '<b>' + rp(r.total_amount) + '</b>',
  ]);
  roomRows.push(['<b>TOTAL</b>', Number(s.order_count).toLocaleString('id-ID'), '<b>' + rp(s.total_amount) + '</b>']);

  const detailRows = [];
  for (const r of report.by_room) {
    for (const o of r.orders) {
      detailRows.push([
        `Kamar ${esc(r.hotel_room_no)} · ${esc(o.created_at)} · ${esc(o.created_by_name)}`,
        esc(o.items.map((it) => `${it.qty}x ${it.name}`).join(', ')),
        rp(o.total_amount),
      ]);
    }
  }

  const cancelledBlock = report.cancelled.count
    ? `<p style="color:#c0392b;font-size:12px">Dibatalkan hari ini (tidak termasuk total): ${report.cancelled.count} order · ${rp(report.cancelled.total)}<br/>` +
      report.cancelled.orders.map((c) => `&nbsp;&nbsp;Kamar ${esc(c.hotel_room_no)} — ${rp(c.total_amount)} — ${esc(c.cancelled_reason || '')} (${esc(c.cancelled_by_name)})`).join('<br/>') +
      `</p>`
    : '';

  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#333;max-width:760px;margin:0 auto">
    <h2 style="margin:0 0 4px">F&amp;B Hotel — ${esc(report.hotel.hotel_name)}</h2>
    <p style="margin:0 0 2px;font-size:13px"><b>Tanggal usaha:</b> ${esc(report.business_date)}
       (${esc(report.range_start)} s/d ${esc(report.range_end)} WIB)</p>
    <p style="margin:0 0 16px;font-size:12px;color:#777">Dibuat ${esc(report.generated_at)}</p>

    <h3 style="margin:0 0 2px;font-size:14px">Total per kamar — posting ke folio</h3>
    ${tbl(['Kamar', 'Jml order', 'Total ke folio'], roomRows)}
    <p style="font-size:12px">Dari total di atas, komponen service charge ${report.sc_pct}% (inklusif) =
       <b>${rp(s.sc_component_total)}</b> · dasar = <b>${rp(s.base_amount_total)}</b>.
       Front desk memposting <b>Total ke folio</b> apa adanya; SC sudah termasuk di dalamnya.</p>
    ${cancelledBlock}

    <h3 style="margin:14px 0 2px;font-size:14px">Rincian order</h3>
    ${detailRows.length ? tbl(['Order', 'Item', 'Total'], detailRows) : '<p class="muted">Tidak ada order.</p>'}
    <p style="font-size:11px;color:#999">Rincian per baris-item ada di lampiran CSV.</p>
  </body></html>`;
}

module.exports = {
  generateOrderId,
  priceItems,
  createOrder,
  cancelOrder,
  getIdempotent,
  saveIdempotent,
  businessDayRange,
  defaultBusinessDate,
  computeReport,
  generateAndPersist,
  toCsv,
  csvFilename,
  subjectFor,
  renderHtmlEmail,
};
