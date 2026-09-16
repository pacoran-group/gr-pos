/* eslint-disable no-console */
/**
 * seedDemoSales.js - ISI DATA DUMMY untuk PRESENTASI ke manajemen.
 *
 * Membuat ~10 hari usaha transaksi karaoke "closed" yang realistis di
 * database DEMO (bintangnew_demo) + mutasi stok yang menyertainya, supaya
 * halaman Reports (Tutup Hari), modul Inventory, dan dashboard insight
 * punya isi yang cukup untuk diperlihatkan (performa per hari/jam,
 * produk fast/slow moving, sisa stok untuk planning kirim).
 *
 * SIFAT:
 *  - IDEMPOTEN. Semua baris seed dikenali dari trans_id berawalan 'SEED-'
 *    dan movement stok bernote 'seed-demo...'. Dijalankan ulang = hapus
 *    yang lama, buat lagi. PRNG di-seed tetap -> angka sama tiap run.
 *  - HANYA menyentuh: web_tr_trans, web_tr_trans_details,
 *    web_tr_trans_extra_hours, web_stock_movement, web_product_stock.
 *    Tidak menyentuh tabel legacy (m_ dan tr_ lama) selain MEMBACA m_room,
 *    m_promo, tax_service; dan tidak menyentuh server 154.
 *  - Transaksi asli non-seed (trans_id 'TRX-...') dibiarkan apa adanya.
 *
 * PAKAI:
 *   node server/utils/seedDemoSales.js            # 10 hari s/d kemarin
 *   node server/utils/seedDemoSales.js --days=14  # ganti jumlah hari
 *   node server/utils/seedDemoSales.js --wipe     # hapus data seed, tidak isi lagi
 *
 * Jendela hari usaha mengikuti EOD_CUTOFF_HOUR (default 5): hari D =
 * [D 05:00, (D+1) 05:00). Semua end_time seed ditaruh di dalam jendelanya.
 */

require('dotenv').config({ override: true });
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// ---------------------------------------------------------------------------
// Argumen
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const argDays = Number((args.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 10;
const WIPE_ONLY = args.includes('--wipe');
const CUTOFF_HOUR = Number(process.env.EOD_CUTOFF_HOUR || 5);

// ---------------------------------------------------------------------------
// PRNG deterministik (mulberry32) - supaya demo bisa direproduksi
// ---------------------------------------------------------------------------
let _s = 0x9e3779b9 ^ 20260903;
function rnd() {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)); // int inklusif
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function weighted(pairs) {
  // pairs: [[value, weight], ...]
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------------------
// Katalog produk kurasi (prod_id & harga NYATA dari m_product demo).
// w = bobot popularitas -> menentukan "fast / slow moving".
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: 35,  name: 'ES TEH',                price: 15000,  cost: 11000,  w: 11 },
  { id: 63,  name: 'AQUA',                  price: 18000,  cost: 15000,  w: 9  },
  { id: 41,  name: 'BIR BINTANG',           price: 60000,  cost: 55000,  w: 9  },
  { id: 234, name: 'FRENCH FRIES BESAR',    price: 18000,  cost: 14000,  w: 8  },
  { id: 111, name: 'SAMPOERNA MILD',        price: 42000,  cost: 38000,  w: 7  },
  { id: 62,  name: 'SPRITE',                price: 17000,  cost: 15000,  w: 7  },
  { id: 3,   name: 'BURGER',                price: 20000,  cost: 16000,  w: 6  },
  { id: 43,  name: 'TAHU PENYET',           price: 20000,  cost: 16000,  w: 6  },
  { id: 64,  name: 'FANTA',                 price: 15000,  cost: 15000,  w: 6  },
  { id: 141, name: 'COCA COLA',             price: 16500,  cost: 15000,  w: 6  },
  { id: 203, name: 'POPMIE KARI AYAM',      price: 10000,  cost: 8000,   w: 6  },
  { id: 5,   name: 'KENTUCKY SAYAP',        price: 25000,  cost: 20000,  w: 5  },
  { id: 160, name: 'LEMON TEA',             price: 20000,  cost: 18000,  w: 5  },
  { id: 179, name: 'KACANG ROSTA',          price: 15000,  cost: 11000,  w: 5  },
  { id: 42,  name: 'GUINESS / BIR HITAM',   price: 55000,  cost: 50000,  w: 5  },
  { id: 33,  name: 'JUS ALPUKAT',           price: 25000,  cost: 22000,  w: 4  },
  { id: 46,  name: 'SODA GEMBIRA',          price: 25000,  cost: 23000,  w: 4  },
  { id: 15,  name: 'TAHU PETIS',            price: 15000,  cost: 12000,  w: 4  },
  { id: 211, name: 'KERUPUK',               price: 10000,  cost: 7000,   w: 4  },
  { id: 66,  name: 'BEARBRAND',             price: 16500,  cost: 15000,  w: 4  },
  { id: 44,  name: 'KRATINGDENG',           price: 25000,  cost: 25000,  w: 3  },
  { id: 147, name: 'LELE GORENG / BAKAR',   price: 25000,  cost: 20000,  w: 3  },
  { id: 274, name: 'LA MENTOL',             price: 43000,  cost: 33000,  w: 3  },
  { id: 136, name: 'SILVER QUEEN',          price: 30000,  cost: 26000,  w: 3  },
  { id: 132, name: 'KACANG',                price: 30000,  cost: 24000,  w: 2  },
  { id: 197, name: 'SOJU',                  price: 125000, cost: 125000, w: 2  },
  { id: 231, name: 'API HIJAU',             price: 132000, cost: 120000, w: 1  },
  { id: 24,  name: 'ANGGUR MERAH',          price: 150000, cost: 132000, w: 1  },
  { id: 76,  name: 'KAWA KAWA BLACKCURENT', price: 145000, cost: 110000, w: 1  },
];
const CATALOG_PAIRS = CATALOG.map((p) => [p, p.w]);

// "Pool pengisi": item murah bervolume tinggi yang realistis dipesan
// berkali-kali (ronde minuman/rokok/snack) untuk mencapai threshold kamar.
// Konsumsi jadi terkonsentrasi di item yang memang distoki banyak.
const FILLER_IDS = [35, 63, 62, 64, 141, 66, 44, 179, 211, 203, 41, 111];
const FILLER_PAIRS = CATALOG.filter((p) => FILLER_IDS.includes(p.id)).map((p) => [p, p.w]);

// stok awal & ambang - item populer sengaja dibuat "pas-pasan" supaya
// laporan gudang menunjukkan barang yang perlu segera dikirim ulang.
function openingFor(p) {
  if (p.w >= 8) return ri(100, 140);  // di-restock 2x di tengah periode
  if (p.w >= 6) return ri(162, 205);  // TIDAK di-restock -> jadi item "reorder now"
  if (p.w >= 3) return ri(110, 170);
  return ri(45, 80);
}
function minStockFor(p) {
  if (p.w >= 8) return 35;
  if (p.w >= 6) return 25;
  if (p.w >= 4) return 15;
  return 8;
}

// ---------------------------------------------------------------------------
// Distribusi waktu (bikin heatmap jam x hari punya bentuk)
// jam 24 -> 00:00 hari berikutnya, 25 -> 01:00, 26 -> 02:00
// ---------------------------------------------------------------------------
const HOUR_WEIGHTS = [
  [14, 2], [15, 3], [16, 4], [17, 6], [18, 9], [19, 12],
  [20, 16], [21, 18], [22, 15], [23, 10], [24, 6], [25, 3],
];
// volume dasar per hari-dalam-minggu (0=Minggu ... 6=Sabtu)
const DOW_BASE = [12, 9, 9, 10, 12, 19, 23];

const CASHIERS = [[2, 4], [3, 3], [12, 3], [1, 1]]; // user_id -> bobot
const CUST_NAMES = [
  'BP. ANDI', 'IBU RATNA', 'BP. HERU', 'MR. TANAKA', 'BP. SURYA rombongan',
  'IBU LINDA', 'BP. GHANI', 'KOMUNITAS MOTOR', 'BP. WAWAN', 'IBU SISKA',
];
const TERMINALS = ['KASIR-01', 'KASIR-02'];

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const round1000 = (n) => Math.max(0, Math.round(n / 1000) * 1000);

// ---------------------------------------------------------------------------
async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bintangnew_demo',
    multipleStatements: true,
    dateStrings: true,
  });
  console.log(`DB: ${process.env.DB_NAME || 'bintangnew_demo'} @ ${process.env.DB_HOST || 'localhost'}`);

  // --- bersihkan data seed lama -------------------------------------------
  const [delMov] = await conn.query(
    "DELETE FROM web_stock_movement WHERE ref_trans_id LIKE 'SEED-%' OR note LIKE 'seed-demo%'"
  );
  const [delTx] = await conn.query("DELETE FROM web_tr_trans WHERE trans_id LIKE 'SEED-%'");
  console.log(`Hapus data seed lama: ${delTx.affectedRows} transaksi, ${delMov.affectedRows} movement.`);
  if (WIPE_ONLY) {
    console.log('--wipe: selesai (tidak mengisi ulang).');
    await conn.end();
    return;
  }

  // --- master: kamar & threshold ----------------------------------------
  const [promoRows] = await conn.query('SELECT room_type, harga_sewa, harga_sewa1 FROM m_promo');
  const promo = {};
  for (const r of promoRows) promo[r.room_type] = { siang: Number(r.harga_sewa), malam: Number(r.harga_sewa1) };

  const [roomRows] = await conn.query(
    `SELECT room_id, room_name, room_type FROM m_room
      WHERE status = 1 AND room_type IN (${promoRows.map(() => '?').join(',')})`,
    promoRows.map((r) => r.room_type)
  );
  if (!roomRows.length) throw new Error('Tidak ada kamar valid di m_room (status=1, room_type ada di m_promo).');

  const [[tax]] = await conn.query('SELECT tax_service FROM tax_service LIMIT 1');
  const SC_PCT = Number(tax ? tax.tax_service : 5) || 5;
  console.log(`Kamar dipakai: ${roomRows.length} · service charge: ${SC_PCT}% (inklusif) · cutoff EOD: ${CUTOFF_HOUR}:00`);

  // --- tanggal usaha: argDays hari terakhir s/d KEMARIN -----------------
  const today = new Date();
  const bizDates = [];
  for (let k = argDays; k >= 1; k--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - k);
    bizDates.push(d);
  }

  // --- stok awal (opening) --------------------------------------------------
  const WAREHOUSE_ID = process.env.WAREHOUSE_ID || `WH-${process.env.UNIT_ID || 'KRK-PANCORAN'}`;
  const UNIT_ID = process.env.UNIT_ID || 'KRK-PANCORAN';
  const onHand = new Map();
  const movements = []; // {event_uid, product_id, delta, reason, qty_after, unit_cost, ref_trans_id, note, created_at, user_id}
  const openingAt = fmt(new Date(bizDates[0].getFullYear(), bizDates[0].getMonth(), bizDates[0].getDate(), 8, 0, 0));
  for (const p of CATALOG) {
    const q = openingFor(p);
    onHand.set(p.id, q);
    movements.push({
      event_uid: crypto.randomUUID(), product_id: p.id, delta: q, reason: 'opening',
      qty_after: q, unit_cost: p.cost, ref_trans_id: null,
      note: 'seed-demo opening', created_at: openingAt, user_id: 1,
    });
  }

  // --- generate transaksi per hari ---------------------------------------
  const txValues = [];
  const detValues = [];
  const extraValues = [];
  const perDay = [];
  let txGrand = 0;

  for (let di = 0; di < bizDates.length; di++) {
    const bd = bizDates[di];
    const dow = bd.getDay();
    const vol = Math.max(4, Math.round(DOW_BASE[dow] * (0.8 + rnd() * 0.4)));
    let dayRevenue = 0;

    for (let i = 0; i < vol; i++) {
      const trans_id = `SEED-${ymd(bd)}-${pad(i + 1)}`;
      const hour = weighted(HOUR_WEIGHTS);
      const start = new Date(bd.getFullYear(), bd.getMonth(), bd.getDate(), 0, 0, 0);
      start.setHours(hour, ri(0, 59), ri(0, 59), 0);

      const room = pick(roomRows);
      const rtype = room.room_type;
      const win = start.getHours() >= 7 && start.getHours() < 17 ? 'siang' : 'malam';
      const threshold = (promo[rtype] && promo[rtype][win]) || 200000;
      const isComp = (rtype === 'VIP S' || rtype === 'VIP U') && rnd() < 0.12;
      const rateMode = isComp ? 'comp' : 'threshold';

      // --- item F&B ---
      const nLines = ri(2, 7);
      const chosen = new Map();
      for (let l = 0; l < nLines; l++) {
        const p = weighted(CATALOG_PAIRS);
        const qty = weighted([[1, 5], [2, 6], [3, 3], [4, 1]]);
        chosen.set(p.id, { p, qty: (chosen.get(p.id)?.qty || 0) + qty });
      }
      let fnbGross = [...chosen.values()].reduce((s, c) => s + c.p.price * c.qty, 0);

      // mode threshold: pastikan belanja realistis (>= threshold, kadang kelipatan).
      // Pengisi diambil dari FILLER_PAIRS (minuman/snack murah) + cap absolut.
      if (!isComp) {
        let target = threshold * weighted([[1.0, 6], [1.25, 4], [1.6, 2], [2.0, 1]]);
        target = Math.min(target, threshold + 350000);
        let guard = 0;
        while (fnbGross < target && guard++ < 60) {
          const p = weighted(FILLER_PAIRS);
          const add = weighted([[1, 6], [2, 3], [3, 1]]);
          chosen.set(p.id, { p, qty: (chosen.get(p.id)?.qty || 0) + add });
          fnbGross += p.price * add;
        }
      }

      // --- diskon ---
      let memberId = null;
      let memberDiscFnb = 0;
      let promoDiscFnb = 0;
      if (rnd() < 0.15) {
        memberId = 'M' + ri(10000, 99999);
        memberDiscFnb = round1000(fnbGross * pick([0.05, 0.08, 0.1]));
      }
      if (rnd() < 0.1) promoDiscFnb = pick([20000, 25000, 50000]);
      if (memberDiscFnb + promoDiscFnb > fnbGross * 0.5) { memberDiscFnb = 0; promoDiscFnb = 0; memberId = null; }

      const netFnb = fnbGross - memberDiscFnb - promoDiscFnb;
      const grandTotal = netFnb; // SC inklusif -> tidak ditambah
      dayRevenue += grandTotal;
      txGrand += grandTotal;

      // --- durasi / end_time ---
      // Model FLAT (migration 015): paket 2 jam begitu threshold tercapai,
      // +10 mnt spare bayar, + penyesuaian manual acak (menit).
      const extraMinutes = rnd() < 0.25 ? pick([-30, -15, 15, 30, 45, 60, 90]) : 0;
      const extraHours = 0; // kolom lama, tidak dipakai lagi
      let allottedH;
      let compHours = null;
      if (isComp) {
        compHours = pick([6, 8, 10, 12]);
        allottedH = compHours + 10 / 60 + extraMinutes / 60;
      } else {
        allottedH = 2 + 10 / 60 + extraMinutes / 60;
      }
      allottedH = Math.max(0.5, Math.min(allottedH, 13));
      const end = new Date(start.getTime() + Math.round(allottedH * 60) * 60000);
      // jaga end_time tetap di dalam jendela hari usaha [bd 05:00, bd+1 05:00)
      const winEnd = new Date(bd.getFullYear(), bd.getMonth(), bd.getDate() + 1, CUTOFF_HOUR, 0, 0);
      winEnd.setMinutes(winEnd.getMinutes() - 20);
      if (end > winEnd) end.setTime(winEnd.getTime());
      if (end <= start) end.setTime(start.getTime() + 45 * 60000);

      // --- pembayaran ---
      const initMethod = weighted([['cash', 7], ['debit', 2], ['credit', 1]]);
      const finalMethod = weighted([['cash', 5], ['qris', 3], ['card', 2]]);
      let deposit;
      if (isComp) {
        deposit = weighted([[0, 3], [round1000(threshold * 0.5), 1]]);
      } else {
        const base = Math.min(threshold, grandTotal);
        deposit = rnd() < 0.7 ? round1000(base) : grandTotal; // 70% bayar sebagian dulu
      }
      deposit = Math.min(deposit, grandTotal); // jaga: tidak overpay -> gap collected 0

      const openedBy = weighted(CASHIERS);
      const closedBy = rnd() < 0.8 ? openedBy : weighted(CASHIERS);
      const custName = rnd() < 0.25 ? pick(CUST_NAMES) : 'MR. GUEST';
      const person = ri(2, 12);
      const term = pick(TERMINALS);

      txValues.push([
        trans_id, room.room_id, rtype, custName, person,
        null, memberId, 0, memberDiscFnb, promoDiscFnb,
        deposit, initMethod, win, threshold, extraHours, extraMinutes,
        'closed', 0, rateMode, compHours,
        SC_PCT, openedBy, term, closedBy, term, finalMethod,
        fmt(start), fmt(end), fmt(start), fmt(end),
      ]);

      // detail item + mutasi stok 'sale' (created_at = end_time)
      for (const { p, qty } of chosen.values()) {
        detValues.push([trans_id, String(p.id), p.name, qty, p.price, p.price * qty, openedBy, term, fmt(start)]);
        const after = (onHand.get(p.id) ?? 0) - qty;
        onHand.set(p.id, after);
        movements.push({
          event_uid: crypto.randomUUID(), product_id: p.id, delta: -qty, reason: 'sale',
          qty_after: after, unit_cost: p.cost, ref_trans_id: trans_id,
          note: 'seed-demo sale', created_at: fmt(end), user_id: closedBy,
        });
      }
      if (extraMinutes) {
        extraValues.push([trans_id, extraMinutes, openedBy, term, fmt(start)]);
      }
    }

    perDay.push({ date: fmt(bd).slice(0, 10), dow, count: vol, revenue: dayRevenue });
    // restock tengah periode untuk item cepat habis (biar bukan minus dalam)
    if (di === 3 || di === 7) {
      const at = fmt(new Date(bizDates[di].getFullYear(), bizDates[di].getMonth(), bizDates[di].getDate(), 10, 0, 0));
      for (const p of CATALOG.filter((x) => x.w >= 8)) {
        const add = ri(60, 85);
        const after = (onHand.get(p.id) ?? 0) + add;
        onHand.set(p.id, after);
        movements.push({
          event_uid: crypto.randomUUID(), product_id: p.id, delta: add, reason: 'restock',
          qty_after: after, unit_cost: p.cost, ref_trans_id: null,
          note: 'seed-demo restock', created_at: at, user_id: 1,
        });
      }
    }
  }

  // --- tulis ke DB ------------------------------------------------------
  const TX_COLS = `trans_id, room_id, room_type_snapshot, cust_name, person,
    waiter_id, member_id, member_disc_room, member_disc_fnb, promo_disc_fnb,
    initial_paid_amount, initial_payment_method, threshold_window, threshold_amount, extra_hours_used, extra_minutes,
    status, is_test, rate_mode, comp_hours,
    service_charge_pct, opened_by_user_id, opened_at_terminal, closed_by_user_id, closed_at_terminal, final_payment_method,
    start_time, end_time, created_at, updated_at`;

  await batchInsert(conn, `INSERT INTO web_tr_trans (${TX_COLS}) VALUES ?`, txValues, 200);
  await batchInsert(
    conn,
    `INSERT INTO web_tr_trans_details
       (trans_id, product_id, product_name_snapshot, qty, price, subtotal, added_by_user_id, added_at_terminal, created_at)
     VALUES ?`,
    detValues, 500
  );
  // Tandai baris rokok bebas SC & Pajak Restoran (sama seperti migration 016).
  await conn.query(
    `UPDATE web_tr_trans_details d
       JOIN m_product p ON CAST(p.prod_id AS CHAR) = d.product_id
        SET d.sc_tax_exempt = 1
      WHERE d.sc_tax_exempt = 0 AND UPPER(COALESCE(p.category, '')) LIKE '%ROKOK%'
        AND d.trans_id LIKE 'SEED-%'`
  );
  if (extraValues.length) {
    await batchInsert(
      conn,
      `INSERT INTO web_tr_trans_extra_hours (trans_id, delta_minutes, approved_by_user_id, approved_at_terminal, created_at) VALUES ?`,
      extraValues, 500
    );
  }

  const movValues = movements.map((m) => [
    m.event_uid, UNIT_ID, WAREHOUSE_ID, String(m.product_id), m.delta, m.reason,
    m.qty_after, m.unit_cost, m.ref_trans_id, null, null, null, m.note, m.user_id, 'SEED', m.created_at,
  ]);
  await batchInsert(
    conn,
    `INSERT INTO web_stock_movement
       (event_uid, unit_id, warehouse_id, product_id, delta, reason, qty_after, unit_cost,
        ref_trans_id, ref_detail_id, ref_doc_type, ref_doc_id, note, created_by_user_id, created_at_terminal, created_at)
     VALUES ?`,
    movValues, 500
  );

  // stok on-hand final (upsert) - langsung set nilai akhir
  for (const p of CATALOG) {
    await conn.query(
      `INSERT INTO web_product_stock (warehouse_id, product_id, unit_id, qty_on_hand, min_stock)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand), min_stock = VALUES(min_stock), updated_at = CURRENT_TIMESTAMP`,
      [WAREHOUSE_ID, String(p.id), UNIT_ID, onHand.get(p.id), minStockFor(p)]
    );
  }

  // --- ringkasan ke layar ---------------------------------------------
  const totalTx = txValues.length;
  console.log('\n=== RINGKASAN SEED ===');
  console.log(`Transaksi     : ${totalTx}  (${bizDates.length} hari usaha, ${perDay[0].date} s/d ${perDay[perDay.length - 1].date})`);
  console.log(`Baris item    : ${detValues.length}`);
  console.log(`Movement stok : ${movValues.length}`);
  console.log(`Pendapatan Σ  : Rp ${txGrand.toLocaleString('id-ID')}  (rata2/hari Rp ${Math.round(txGrand / bizDates.length).toLocaleString('id-ID')})`);
  console.log('\nPer hari:');
  const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  for (const d of perDay) {
    console.log(`  ${d.date} ${DOW[d.dow]}  ${String(d.count).padStart(3)} trx   Rp ${d.revenue.toLocaleString('id-ID')}`);
  }

  // top & bottom mover
  const sold = new Map();
  for (const m of movements) {
    if (m.reason !== 'sale') continue;
    sold.set(m.product_id, (sold.get(m.product_id) || 0) + -m.delta);
  }
  const ranked = CATALOG.map((p) => ({
    name: p.name, qty: sold.get(p.id) || 0, left: onHand.get(p.id), min: minStockFor(p),
  })).sort((a, b) => b.qty - a.qty);
  console.log('\nTop 6 fast moving:');
  ranked.slice(0, 6).forEach((r) => console.log(`  ${r.name.padEnd(24)} terjual ${String(r.qty).padStart(4)}  sisa ${r.left}`));
  console.log('\nPerlu perhatian (sisa <= min_stock):');
  ranked.filter((r) => r.left <= r.min).forEach((r) => console.log(`  ${r.name.padEnd(24)} sisa ${String(r.left).padStart(4)}  (min ${r.min})`));

  console.log('\nSelesai. Buka Reports / Inventory di http://localhost:4000 untuk melihat.');
  await conn.end();
}

async function batchInsert(conn, sql, rows, chunk) {
  for (let i = 0; i < rows.length; i += chunk) {
    await conn.query(sql, [rows.slice(i, i + chunk)]);
  }
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
