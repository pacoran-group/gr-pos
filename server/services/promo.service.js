/**
 * Promo produk - B1G1 & paket harga tetap. Lihat migration 009_promo.sql.
 *
 * AUTO-APPLY: server mengevaluasi promo aktif yang sedang berlaku (tanggal +
 * jendela jam + hari) atas SELURUH keranjang efektif (web_tr_trans_details
 * yang sudah dikurangi void), lalu menyimpan totalnya di
 * web_tr_trans.promo_disc_fnb + rincian di web_promo_applied.
 *
 * bill.js mengurangkan promo_disc_fnb dari net_fnb. Item gratis TIDAK
 * mengurangi net_fnb lebih dari sekali (tidak ada overlap - ditegakkan di
 * promo.routes.js) dan TIDAK menaikkan threshold waktu karaoke.
 *
 * Waktu server dianggap WIB (konsisten dgn config/report.js).
 */
const { pool } = require('../config/db');

const pad = (n) => String(n).padStart(2, '0');
const rp = (n) => Math.round(Number(n) || 0);

/** "YYYY-MM-DD", "HH:MM", ISO weekday 1..7 (Senin=1) dari `now`. */
function nowParts(now = new Date()) {
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    hm: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    dow: ((now.getDay() + 6) % 7) + 1,
  };
}

function withinTimeWindow(startTime, endTime, hm) {
  if (!startTime && !endTime) return true; // sepanjang hari
  const st = String(startTime || '00:00').slice(0, 5);
  const et = String(endTime || '23:59').slice(0, 5);
  if (st <= et) return hm >= st && hm <= et;
  return hm >= st || hm <= et; // lewat tengah malam
}

function withinDays(daysCsv, dow) {
  if (!daysCsv) return true;
  return String(daysCsv).split(',').map((s) => s.trim()).includes(String(dow));
}

/**
 * @param {object} conn  koneksi/pool
 * @param {Array<{product_id:string, qty:number, price:number}>} cartLines
 *        keranjang efektif, sudah diagregasi per product_id
 * @param {Date} [now]
 * @returns {Promise<{promo_disc_fnb:number, applied:Array}>}
 */
async function evaluateActivePromos(conn, cartLines, now = new Date()) {
  const cart = (cartLines || []).filter((l) => Number(l.qty) > 0);
  if (!cart.length) return { promo_disc_fnb: 0, applied: [] };

  const qtyOf = {};
  const priceOf = {};
  let fnbGross = 0;
  for (const l of cart) {
    const k = String(l.product_id);
    qtyOf[k] = Number(l.qty);
    priceOf[k] = Number(l.price);
    fnbGross += Number(l.qty) * Number(l.price);
  }

  const { date, hm, dow } = nowParts(now);
  const [promos] = await conn.query(
    `SELECT * FROM web_promo
      WHERE active = 1
        AND (start_date IS NULL OR start_date <= ?)
        AND (end_date   IS NULL OR end_date   >= ?)`,
    [date, date]
  );

  const applied = [];
  let total = 0;

  for (const p of promos) {
    if (!withinTimeWindow(p.start_time, p.end_time, hm)) continue;
    if (!withinDays(p.days_of_week, dow)) continue;

    if (p.type === 'b1g1') {
      const pid = String(p.product_id);
      const have = qtyOf[pid] || 0;
      const groupSize = Number(p.buy_qty) + Number(p.free_qty);
      if (groupSize <= 0 || have < groupSize) continue;
      const groups = Math.floor(have / groupSize);
      const freeUnits = groups * Number(p.free_qty);
      const discount = rp(freeUnits * (priceOf[pid] || 0));
      if (discount <= 0) continue;
      applied.push({
        promo_id: p.promo_id,
        promo_name: p.name,
        promo_type: 'b1g1',
        discount_amount: discount,
        detail: {
          product_id: pid,
          free_units: freeUnits,
          unit_price: priceOf[pid] || 0,
          buy_qty: Number(p.buy_qty),
          free_qty: Number(p.free_qty),
        },
      });
      total += discount;
    } else if (p.type === 'bundle') {
      const [items] = await conn.query(
        'SELECT product_id, qty FROM web_promo_bundle_item WHERE promo_id = ?',
        [p.promo_id]
      );
      if (!items.length) continue;
      let numBundles = Infinity;
      let fullPrice = 0;
      let ok = true;
      for (const c of items) {
        const cid = String(c.product_id);
        const need = Number(c.qty);
        const have = qtyOf[cid] || 0;
        if (need <= 0 || have < need) { ok = false; break; }
        numBundles = Math.min(numBundles, Math.floor(have / need));
        fullPrice += (priceOf[cid] || 0) * need;
      }
      if (!ok || !Number.isFinite(numBundles) || numBundles < 1) continue;
      const perBundle = Math.max(0, fullPrice - Number(p.bundle_price));
      const discount = rp(perBundle * numBundles);
      if (discount <= 0) continue;
      applied.push({
        promo_id: p.promo_id,
        promo_name: p.name,
        promo_type: 'bundle',
        discount_amount: discount,
        detail: {
          num_bundles: numBundles,
          bundle_price: Number(p.bundle_price),
          full_price_per_bundle: rp(fullPrice),
          components: items.map((c) => ({ product_id: String(c.product_id), qty: Number(c.qty) })),
        },
      });
      total += discount;
    }
  }

  // Jaring pengaman: diskon tidak boleh melebihi F&B bruto.
  const promo_disc_fnb = Math.min(rp(total), rp(fnbGross));
  return { promo_disc_fnb, applied };
}

/**
 * Hitung ulang promo untuk sebuah transaksi dari keranjang efektifnya
 * (web_tr_trans_details, sudah dikurangi void), simpan promo_disc_fnb +
 * tulis ulang web_promo_applied. Dipanggil setelah tiap mutasi keranjang.
 */
async function recomputeForTrans(conn, transId) {
  const [lines] = await conn.query(
    `SELECT product_id, SUM(qty) AS qty, MAX(price) AS price
       FROM web_tr_trans_details WHERE trans_id = ?
      GROUP BY product_id`,
    [transId]
  );
  const cart = lines.map((l) => ({
    product_id: String(l.product_id),
    qty: Number(l.qty),
    price: Number(l.price),
  }));
  const res = await evaluateActivePromos(conn, cart);

  await conn.query('UPDATE web_tr_trans SET promo_disc_fnb = ? WHERE trans_id = ?', [
    res.promo_disc_fnb,
    transId,
  ]);
  await conn.query('DELETE FROM web_promo_applied WHERE trans_id = ?', [transId]);
  for (const a of res.applied) {
    await conn.query(
      `INSERT INTO web_promo_applied
         (trans_id, promo_id, promo_name, promo_type, discount_amount, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [transId, a.promo_id, a.promo_name, a.promo_type, a.discount_amount, JSON.stringify(a.detail || null)]
    );
  }
  return res;
}

/**
 * Set product_id yang sudah dipakai promo AKTIF lain (untuk cek larangan
 * overlap saat supervisor membuat/mengubah promo). `excludePromoId` = promo
 * yang sedang diedit (dikecualikan dari cek).
 */
async function productsLockedByActivePromos(conn = pool, excludePromoId = 0) {
  const [rows] = await conn.query(
    `SELECT product_id FROM web_promo
      WHERE active = 1 AND type = 'b1g1' AND product_id IS NOT NULL AND promo_id <> ?
     UNION
     SELECT bi.product_id
       FROM web_promo_bundle_item bi
       JOIN web_promo p ON p.promo_id = bi.promo_id
      WHERE p.active = 1 AND p.promo_id <> ?`,
    [excludePromoId, excludePromoId]
  );
  return new Set(rows.map((r) => String(r.product_id)));
}

module.exports = { evaluateActivePromos, recomputeForTrans, productsLockedByActivePromos };
