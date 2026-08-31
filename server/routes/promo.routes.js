/**
 * Manajemen Promo produk - B1G1 & paket harga tetap. Lihat migration
 * 009_promo.sql & server/services/promo.service.js.
 *
 * Semua endpoint: admin / supervisor. Auto-apply-nya di trans.routes.js.
 *
 * LARANGAN OVERLAP: satu produk tidak boleh dipakai >1 promo AKTIF
 * (sebagai target B1G1 maupun komponen bundle). Dicek di sini saat
 * create / update / mengaktifkan.
 */
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const promoSvc = require('../services/promo.service');

const router = express.Router();
router.use(requireAuth);
const MANAGE = ['admin', 'supervisor'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normDays(v) {
  if (v == null || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const set = [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => n >= 1 && n <= 7))].sort();
  return set.length && set.length < 7 ? set.join(',') : null; // 7 hari == tanpa batas
}
function normDate(v) {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function normTime(v) {
  if (!v) return null;
  if (!TIME_RE.test(v)) throw new AppError(400, `Jam "${v}" harus format HH:MM (00:00-23:59).`);
  return v + ':00';
}

async function assertProductsExist(conn, ids) {
  if (!ids.length) return;
  const [rows] = await conn.query(
    `SELECT CAST(prod_id AS CHAR) AS id FROM m_product WHERE prod_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const found = new Set(rows.map((r) => String(r.id)));
  const missing = ids.filter((i) => !found.has(String(i)));
  if (missing.length) throw new AppError(400, `Produk tidak ditemukan: ${missing.join(', ')}.`);
}

// Kumpulkan product_id yang disentuh payload promo.
function touchedProducts(body) {
  if (body.type === 'b1g1') return body.product_id != null ? [String(body.product_id)] : [];
  return (body.components || []).map((c) => String(c.product_id));
}

async function assertNoOverlap(conn, body, excludeId, willBeActive) {
  if (!willBeActive) return; // promo nonaktif boleh berbagi produk
  const mine = touchedProducts(body);
  if (!mine.length) return;
  const locked = await promoSvc.productsLockedByActivePromos(conn, excludeId || 0);
  const clash = mine.filter((p) => locked.has(String(p)));
  if (clash.length) {
    const [names] = await conn.query(
      `SELECT prod_desc FROM m_product WHERE CAST(prod_id AS CHAR) IN (${clash.map(() => '?').join(',')})`,
      clash
    );
    const label = names.map((n) => n.prod_desc).join(', ') || clash.join(', ');
    throw new AppError(409, `Produk ${label} sudah dipakai promo aktif lain. Nonaktifkan promo itu dulu atau keluarkan produknya.`);
  }
}

function parseBody(body) {
  const name = String(body.name || '').trim();
  const type = String(body.type || '').trim();
  if (!name) throw new AppError(400, 'Nama promo wajib diisi.');
  if (!['b1g1', 'bundle'].includes(type)) throw new AppError(400, "Tipe promo harus 'b1g1' atau 'bundle'.");

  const common = {
    name,
    type,
    active: body.active === false || String(body.active) === 'false' || body.active === 0 ? 0 : 1,
    start_date: normDate(body.start_date),
    end_date: normDate(body.end_date),
    start_time: normTime(body.start_time),
    end_time: normTime(body.end_time),
    days_of_week: normDays(body.days_of_week),
    note: body.note ? String(body.note).slice(0, 255) : null,
  };

  if (type === 'b1g1') {
    const product_id = body.product_id != null ? String(body.product_id) : '';
    const buy_qty = Math.max(1, parseInt(body.buy_qty, 10) || 1);
    const free_qty = Math.max(1, parseInt(body.free_qty, 10) || 1);
    if (!product_id) throw new AppError(400, 'B1G1: produk wajib dipilih.');
    return { ...common, product_id, buy_qty, free_qty, bundle_price: null, components: [] };
  }

  // bundle
  const bundle_price = Number(body.bundle_price);
  if (!Number.isFinite(bundle_price) || bundle_price < 0) throw new AppError(400, 'Harga paket harus angka >= 0.');
  const components = (body.components || [])
    .map((c) => ({ product_id: String(c.product_id), qty: Math.max(1, parseInt(c.qty, 10) || 1) }))
    .filter((c) => c.product_id);
  if (components.length < 2) throw new AppError(400, 'Paket butuh minimal 2 komponen produk.');
  const dup = components.map((c) => c.product_id);
  if (new Set(dup).size !== dup.length) throw new AppError(400, 'Komponen paket tidak boleh produk yang sama dua kali.');
  return { ...common, product_id: null, buy_qty: 1, free_qty: 1, bundle_price, components };
}

// GET /api/promos
router.get('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const [promos] = await pool.query('SELECT * FROM web_promo ORDER BY active DESC, promo_id DESC');
    const [bItems] = await pool.query(
      `SELECT bi.promo_id, bi.product_id, bi.qty, p.prod_desc AS product_name, p.harga_jual AS price
         FROM web_promo_bundle_item bi
         LEFT JOIN m_product p ON CAST(p.prod_id AS CHAR) = bi.product_id`
    );
    // nama produk utk b1g1
    const b1g1Ids = promos.filter((p) => p.type === 'b1g1' && p.product_id).map((p) => p.product_id);
    let nameById = {};
    if (b1g1Ids.length) {
      const [rows] = await pool.query(
        `SELECT CAST(prod_id AS CHAR) AS id, prod_desc AS name, harga_jual AS price
           FROM m_product WHERE CAST(prod_id AS CHAR) IN (${b1g1Ids.map(() => '?').join(',')})`,
        b1g1Ids
      );
      nameById = Object.fromEntries(rows.map((r) => [String(r.id), r]));
    }
    const byPromo = {};
    for (const it of bItems) (byPromo[it.promo_id] = byPromo[it.promo_id] || []).push(it);
    res.json({
      promos: promos.map((p) => ({
        ...p,
        product_name: p.product_id ? (nameById[p.product_id]?.name || null) : null,
        product_price: p.product_id ? (nameById[p.product_id]?.price ?? null) : null,
        components: byPromo[p.promo_id] || [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/promos
router.post('/', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const b = parseBody(req.body || {});
    const result = await withTransaction(async (conn) => {
      await assertProductsExist(conn, touchedProducts(b).map(Number));
      await assertNoOverlap(conn, b, null, !!b.active);
      const [r] = await conn.query(
        `INSERT INTO web_promo
           (name, type, product_id, buy_qty, free_qty, bundle_price, active,
            start_date, end_date, start_time, end_time, days_of_week, note, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.name, b.type, b.product_id, b.buy_qty, b.free_qty, b.bundle_price, b.active,
         b.start_date, b.end_date, b.start_time, b.end_time, b.days_of_week, b.note, req.user.user_id]
      );
      const id = r.insertId;
      for (const c of b.components) {
        await conn.query('INSERT INTO web_promo_bundle_item (promo_id, product_id, qty) VALUES (?, ?, ?)', [id, c.product_id, c.qty]);
      }
      return { promo_id: id };
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/promos/:id
router.put('/:id', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'ID promo tidak valid.');
    const b = parseBody(req.body || {});
    await withTransaction(async (conn) => {
      const [ex] = await conn.query('SELECT promo_id FROM web_promo WHERE promo_id = ?', [id]);
      if (!ex.length) throw new AppError(404, `Promo #${id} tidak ada.`);
      await assertProductsExist(conn, touchedProducts(b).map(Number));
      await assertNoOverlap(conn, b, id, !!b.active);
      await conn.query(
        `UPDATE web_promo SET
           name = ?, type = ?, product_id = ?, buy_qty = ?, free_qty = ?, bundle_price = ?,
           active = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
           days_of_week = ?, note = ?
         WHERE promo_id = ?`,
        [b.name, b.type, b.product_id, b.buy_qty, b.free_qty, b.bundle_price, b.active,
         b.start_date, b.end_date, b.start_time, b.end_time, b.days_of_week, b.note, id]
      );
      await conn.query('DELETE FROM web_promo_bundle_item WHERE promo_id = ?', [id]);
      for (const c of b.components) {
        await conn.query('INSERT INTO web_promo_bundle_item (promo_id, product_id, qty) VALUES (?, ?, ?)', [id, c.product_id, c.qty]);
      }
    });
    res.json({ promo_id: id });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/promos/:id  (jejak web_promo_applied dibiarkan - snapshot laporan)
router.delete('/:id', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [r] = await pool.query('DELETE FROM web_promo WHERE promo_id = ?', [id]);
    if (!r.affectedRows) throw new AppError(404, `Promo #${id} tidak ada.`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
