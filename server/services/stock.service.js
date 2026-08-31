/**
 * Modul Inventory / Stok - FASE 1 (sub-gudang unit ini). Lihat
 * migration 004_create_inventory.sql & plan file.
 *
 * Semua fungsi menerima `conn` (koneksi mysql2 di dalam withTransaction)
 * sebagai argumen pertama supaya penulisan stok + ledger + outbox atomik
 * dengan aksi bisnisnya (buka kamar / tambah order / void / batal /
 * restock / adjust). Kalau transaksi pemanggil di-rollback, mutasi stok
 * ikut batal.
 *
 * Prinsip stok: qty_on_hand BOLEH negatif. Penjualan tidak pernah
 * diblokir - kalau stok kurang, kita hanya mengumpulkan "warning" untuk
 * ditampilkan ke kasir (keputusan: peringatkan tapi selalu izinkan).
 */
const crypto = require('crypto');
const { UNIT_ID, WAREHOUSE_ID, SYNC_OUTBOX_ENABLED } = require('../config/unit');

/**
 * Terapkan satu mutasi stok:
 *   1. upsert web_product_stock (akumulasi delta atomik di sisi DB)
 *   2. baca balik qty_on_hand -> qty_after
 *   3. tulis baris web_stock_movement
 *   4. (kalau SYNC_OUTBOX_ENABLED) tulis baris web_sync_outbox
 *
 * Tidak butuh SELECT ... FOR UPDATE: ON DUPLICATE KEY UPDATE sudah
 * meng-X-lock baris stok untuk sisa transaksi dan `+` dievaluasi server.
 *
 * @returns {Promise<{product_id:string, qty_after:number, event_uid:string}>}
 */
async function applyMovement(
  conn,
  {
    productId,
    delta,
    reason,
    unitCost = null,
    refTransId = null,
    refDetailId = null,
    refDocType = null,
    refDocId = null,
    note = null,
    userId = null,
    terminalId = null,
  }
) {
  const eventUid = crypto.randomUUID();
  const pid = String(productId);
  const d = Number(delta);

  await conn.query(
    `INSERT INTO web_product_stock (warehouse_id, product_id, unit_id, qty_on_hand)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       qty_on_hand = qty_on_hand + VALUES(qty_on_hand),
       updated_at  = CURRENT_TIMESTAMP`,
    [WAREHOUSE_ID, pid, UNIT_ID, d]
  );

  const [rows] = await conn.query(
    'SELECT qty_on_hand FROM web_product_stock WHERE warehouse_id = ? AND product_id = ?',
    [WAREHOUSE_ID, pid]
  );
  const qtyAfter = Number(rows[0].qty_on_hand);

  await conn.query(
    `INSERT INTO web_stock_movement
      (event_uid, unit_id, warehouse_id, product_id, delta, reason, qty_after, unit_cost,
       ref_trans_id, ref_detail_id, ref_doc_type, ref_doc_id, note, created_by_user_id, created_at_terminal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventUid, UNIT_ID, WAREHOUSE_ID, pid, d, reason, qtyAfter,
      unitCost == null ? null : Number(unitCost),
      refTransId, refDetailId, refDocType, refDocId,
      note, userId, terminalId,
    ]
  );

  if (SYNC_OUTBOX_ENABLED) {
    await conn.query(
      `INSERT INTO web_sync_outbox (event_uid, aggregate, aggregate_id, unit_id, payload)
       VALUES (?, 'stock_movement', ?, ?, ?)`,
      [
        eventUid, eventUid, UNIT_ID,
        JSON.stringify({
          event_uid: eventUid,
          unit_id: UNIT_ID,
          warehouse_id: WAREHOUSE_ID,
          product_id: pid,
          delta: d,
          reason,
          qty_after: qtyAfter,
          unit_cost: unitCost == null ? null : Number(unitCost),
          ref_trans_id: refTransId,
          ref_detail_id: refDetailId,
          ref_doc_type: refDocType,
          ref_doc_id: refDocId,
          note,
          created_by_user_id: userId,
          created_at_terminal: terminalId,
          created_at: new Date().toISOString(),
        }),
      ]
    );
  }

  return { product_id: pid, qty_after: qtyAfter, event_uid: eventUid };
}

/**
 * Kurangi stok untuk daftar item pesanan (reason 'sale'). `pricedItems`
 * adalah array hasil fetchItemsWithPrice di trans.routes.js
 * ({ product_id, product_name_snapshot, qty, cost, ... }).
 *
 * @returns {Promise<Array<{product_id:string, product_name:string, qty_after:number}>>}
 *   warning HANYA untuk item yang qty_after < 0 setelah dikurangi.
 */
async function decrementForItems(conn, pricedItems, { refTransId, userId = null, terminalId = null }) {
  const warnings = [];
  for (const it of pricedItems || []) {
    const res = await applyMovement(conn, {
      productId: it.product_id,
      delta: -Number(it.qty),
      reason: 'sale',
      unitCost: it.cost == null ? null : it.cost,
      refTransId,
      userId,
      terminalId,
    });
    if (res.qty_after < 0) {
      warnings.push({
        product_id: res.product_id,
        product_name: it.product_name_snapshot,
        qty_after: res.qty_after,
      });
    }
  }
  return warnings;
}

/**
 * Kembalikan stok untuk daftar item (void 1 item / batal seluruh transaksi).
 * `reason` = 'void_return' | 'cancel_return'.
 * items: [{ product_id, product_name_snapshot, qty, detail_id? }]
 */
async function returnForItems(conn, items, { refTransId, reason, userId = null, terminalId = null }) {
  const out = [];
  for (const it of items || []) {
    const res = await applyMovement(conn, {
      productId: it.product_id,
      delta: Number(it.qty),
      reason,
      refTransId,
      refDetailId: it.detail_id == null ? null : it.detail_id,
      userId,
      terminalId,
    });
    out.push({ product_id: res.product_id, qty_after: res.qty_after });
  }
  return out;
}

/**
 * Set stok ke nilai absolut (input stok awal / hitung fisik / koreksi).
 * Butuh lock baris karena harus baca nilai kini untuk hitung delta.
 * reason 'opening' kalau produk belum punya baris stok, selain itu
 * 'adjustment'. Tetap menulis mutasi walau delta = 0 (audit "sudah
 * dihitung, tidak berubah").
 */
async function setAbsolute(conn, { productId, target, note = null, userId = null, terminalId = null }) {
  const pid = String(productId);
  const [rows] = await conn.query(
    'SELECT qty_on_hand FROM web_product_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE',
    [WAREHOUSE_ID, pid]
  );
  const current = rows.length ? Number(rows[0].qty_on_hand) : 0;
  const reason = rows.length ? 'adjustment' : 'opening';
  const delta = Number(target) - current;
  return applyMovement(conn, { productId: pid, delta, reason, note, userId, terminalId });
}

module.exports = { applyMovement, decrementForItems, returnForItems, setAbsolute };
