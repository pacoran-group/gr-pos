/**
 * Modul Inventory / Stok - FASE 1 (sub-gudang unit ini).
 * Lihat migration 004_create_inventory.sql & server/services/stock.service.js.
 *
 * - GET  /api/inventory                     -> daftar stok semua produk aktif
 * - GET  /api/inventory/:productId/movements -> 50 mutasi terakhir 1 produk
 * - POST /api/inventory/:productId/restock  -> tambah stok (barang masuk manual)
 * - POST /api/inventory/:productId/adjust   -> set stok absolut (stok awal / hitung fisik)
 *
 * Baca (GET) boleh semua user login. Mutasi (POST) khusus admin/supervisor/gudang
 * - server requireRole yang menegakkan; halaman inventory.html hanya
 * menyembunyikan tombolnya utk role lain (UX).
 */
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { WAREHOUSE_ID } = require('../config/unit');
const stock = require('../services/stock.service');

const router = express.Router();
router.use(requireAuth);

const STOCK_EDIT_ROLES = ['admin', 'supervisor', 'gudang'];

// GET /api/inventory[?q=&low=1]
//
// LEFT JOIN supaya SEMUA produk aktif tampil walau belum punya baris stok
// (qty_on_hand = 0, min_stock = 5, low = 1). Nama/harga/kategori dari
// m_product yang disinkron (Opsi A - stok tidak disimpan di m_product).
//
// CATATAN: m_product.is_active bertipe varchar(15) berisi TEKS 'TRUE'/'FALSE'
// (bukan angka). Harus dibandingkan sebagai string `= 'TRUE'`, kalau tidak
// MySQL meng-cast 'TRUE' -> 0 dan query mengembalikan 0 baris tanpa error.
// Lihat catatan panjang di catalog.routes.js.
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const lowOnly = String(req.query.low || '') === '1';
    const [rows] = await pool.query(
      `SELECT CAST(p.prod_id AS CHAR) AS product_id, p.prod_desc AS product_name,
              p.category AS category, p.harga_jual AS price, p.harga_mdl AS cost, p.satuan AS unit,
              COALESCE(s.qty_on_hand, 0) AS qty_on_hand, COALESCE(s.min_stock, 5) AS min_stock,
              (COALESCE(s.qty_on_hand, 0) <= COALESCE(s.min_stock, 5)) AS low,
              (s.product_id IS NOT NULL) AS managed, s.updated_at AS stock_updated_at
         FROM m_product p
         LEFT JOIN web_product_stock s
           ON s.product_id = CAST(p.prod_id AS CHAR) AND s.warehouse_id = ?
        WHERE p.is_active = 'TRUE'
          AND (? = '' OR p.prod_desc LIKE CONCAT('%', ?, '%'))
        ORDER BY p.prod_desc`,
      [WAREHOUSE_ID, q, q]
    );
    // Normalisasi tinyint (0/1) -> boolean supaya frontend enak.
    const items = rows
      .map((r) => ({ ...r, low: Boolean(r.low), managed: Boolean(r.managed) }))
      .filter((r) => (lowOnly ? r.low : true));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/:productId/movements - 50 mutasi terakhir 1 produk.
router.get('/:productId/movements', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.delta, m.reason, m.qty_after, m.unit_cost, m.ref_trans_id, m.ref_detail_id,
              m.note, m.created_at, m.created_at_terminal, u.full_name AS created_by_name
         FROM web_stock_movement m
         LEFT JOIN web_users u ON u.user_id = m.created_by_user_id
        WHERE m.product_id = ? AND m.warehouse_id = ?
        ORDER BY m.id DESC
        LIMIT 50`,
      [String(req.params.productId), WAREHOUSE_ID]
    );
    res.json({ movements: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/:productId/restock  body: { qty, note }
// Tambah stok (barang masuk manual). reason 'restock'.
router.post('/:productId/restock', requireRole(...STOCK_EDIT_ROLES), async (req, res, next) => {
  try {
    const { qty, note } = req.body || {};
    const n = Number(qty);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AppError(400, 'qty restock harus bilangan bulat lebih dari 0.');
    }
    const result = await withTransaction((conn) =>
      stock.applyMovement(conn, {
        productId: req.params.productId,
        delta: n,
        reason: 'restock',
        note: (note || '').trim() || null,
        userId: req.user.user_id,
        terminalId: req.terminalId,
      })
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/:productId/adjust  body: { qty_on_hand, note }
// Set stok ke nilai absolut - dipakai utk input stok awal & koreksi hasil
// hitung fisik. reason 'opening' kalau produk belum punya baris stok, selain
// itu 'adjustment'.
router.post('/:productId/adjust', requireRole(...STOCK_EDIT_ROLES), async (req, res, next) => {
  try {
    const { qty_on_hand, note } = req.body || {};
    const target = Number(qty_on_hand);
    if (!Number.isInteger(target) || target < 0) {
      throw new AppError(400, 'qty_on_hand harus bilangan bulat 0 atau lebih.');
    }
    const result = await withTransaction((conn) =>
      stock.setAbsolute(conn, {
        productId: req.params.productId,
        target,
        note: (note || '').trim() || null,
        userId: req.user.user_id,
        terminalId: req.terminalId,
      })
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
