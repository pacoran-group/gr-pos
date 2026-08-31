/**
 * Manajemen Produk (katalog F&B) - CRUD atas m_product.
 *
 * Sejak 29 Agu 2026 gr-pos MEMILIKI m_product (masterSync tidak lagi menimpanya
 * dari 154 - lihat masterSync.service.js). Halaman ini (public/products.html)
 * jadi satu-satunya cara mengelola menu: tambah item, ubah harga, aktif/nonaktif.
 *
 * Skema m_product (dari 154, dipertahankan apa adanya):
 *   prod_id int AI, prod_desc, qty_stok, harga_jual (double), tgl_masuk (date),
 *   satuan, harga_mdl (double), category (teks), jenis_stok, is_active (TEKS
 *   'TRUE'/'FALSE'!), disc, sc, ppn.
 * gr-pos memakai: prod_desc, category, harga_jual, harga_mdl, is_active.
 * Kolom lain (disc/sc/ppn/jenis_stok/qty_stok) tidak dipakai logika gr-pos -
 * di-INSERT dengan nilai default, di-UPDATE tidak disentuh.
 *
 * Semua endpoint: admin / supervisor.
 */
const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
router.use(requireAuth);

const MANAGE = ['admin', 'supervisor'];

// Normalisasi & validasi payload form. `partial` = untuk PUT (semua wajib
// tetap wajib di sini; kita selalu kirim form lengkap dari klien).
function parseBody(body) {
  const prod_desc = String(body.prod_desc || '').trim();
  const category = String(body.category || '').trim().toUpperCase();
  const harga_jual = Number(body.harga_jual);
  const harga_mdl = body.harga_mdl === '' || body.harga_mdl == null ? 0 : Number(body.harga_mdl);
  const satuan = String(body.satuan || '').trim().slice(0, 15);
  const is_active = body.is_active === false || String(body.is_active).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';

  if (!prod_desc) throw new AppError(400, 'Nama produk wajib diisi.');
  if (!category) throw new AppError(400, 'Kategori wajib diisi.');
  if (!Number.isFinite(harga_jual) || harga_jual < 0) throw new AppError(400, 'Harga jual harus angka >= 0.');
  if (!Number.isFinite(harga_mdl) || harga_mdl < 0) throw new AppError(400, 'Harga modal harus angka >= 0.');

  return { prod_desc, category, harga_jual, harga_mdl, satuan, is_active };
}

// GET /api/products[?q=&category=&status=all|active|inactive]
router.get('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || 'all').toLowerCase();

    const where = [];
    const params = [];
    if (q) { where.push('prod_desc LIKE CONCAT(?, ?, ?)'); params.push('%', q, '%'); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (status === 'active') where.push("is_active = 'TRUE'");
    else if (status === 'inactive') where.push("is_active <> 'TRUE'");

    const [rows] = await pool.query(
      `SELECT CAST(prod_id AS CHAR) AS product_id, prod_id, prod_desc, category,
              harga_jual, harga_mdl, satuan, is_active
         FROM m_product
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY category, prod_desc`,
      params
    );
    const [cats] = await pool.query(
      "SELECT DISTINCT category FROM m_product WHERE category <> '' ORDER BY category"
    );
    res.json({ products: rows, categories: cats.map((c) => c.category) });
  } catch (err) {
    next(err);
  }
});

// POST /api/products
router.post('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const p = parseBody(req.body || {});
    const [r] = await pool.query(
      `INSERT INTO m_product
         (prod_desc, category, harga_jual, harga_mdl, satuan, is_active,
          qty_stok, tgl_masuk, jenis_stok, disc, sc, ppn)
       VALUES (?, ?, ?, ?, ?, ?, 0, CURDATE(), '', 0, 0, 0)`,
      [p.prod_desc, p.category, p.harga_jual, p.harga_mdl, p.satuan, p.is_active]
    );
    res.status(201).json({ product_id: String(r.insertId), ...p });
  } catch (err) {
    next(err);
  }
});

// PUT /api/products/:id  (id = prod_id numerik)
router.put('/:id', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID produk tidak valid.');
    const p = parseBody(req.body || {});
    const [r] = await pool.query(
      `UPDATE m_product
          SET prod_desc = ?, category = ?, harga_jual = ?, harga_mdl = ?,
              satuan = ?, is_active = ?
        WHERE prod_id = ?`,
      [p.prod_desc, p.category, p.harga_jual, p.harga_mdl, p.satuan, p.is_active, id]
    );
    if (!r.affectedRows) throw new AppError(404, `Produk #${id} tidak ditemukan.`);
    res.json({ product_id: String(id), ...p });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
