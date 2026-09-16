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
const crypto = require('crypto');
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { UNIT_ID, WAREHOUSE_ID, UNIT_NAME, SYNC_OUTBOX_ENABLED } = require('../config/unit');
const { OPNAME_LOCAL_APPLY, OPNAME_REPORT_RECIPIENTS, opnameMailConfigured } = require('../config/opname');
const opnameApproval = require('../services/opnameApproval.service');
const stock = require('../services/stock.service');
const mailer = require('../services/mailer.service');

const router = express.Router();
router.use(requireAuth);

const STOCK_EDIT_ROLES = ['admin', 'head_karaoke', 'head_unit', 'supervisor', 'gudang'];
// "Sesuaikan" bebas (set stok ke angka apa pun tanpa lewat opname) - sejak
// migration 014 ini dikunci admin/supervisor saja (revisi SPV Gudang:
// stokis unit cuma submit hasil opname, TIDAK berhak eksekusi penyesuaian
// sendiri - lihat catatan panjang di 014_stock_opname.sql).
const STOCK_ADJUST_ROLES = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];
const OPNAME_SUBMIT_ROLES = ['admin', 'head_karaoke', 'head_unit', 'supervisor', 'gudang'];
const OPNAME_APPLY_ROLES = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];
// Laporan "Rencana Kirim" & "Barang Terjual" berisi omzet/nilai rekomendasi
// order - stokis ('gudang') cuma boleh input barang masuk, lihat riwayat
// mutasi, dan submit stock opname (lihat 014_stock_opname.sql), tidak
// berhak lihat laporan penjualan/reorder.
const SALES_REPORT_ROLES = ['admin', 'head_karaoke', 'head_unit', 'supervisor'];

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

// GET /api/inventory/report?days=14&lead=3&cover=10
//
// Laporan "Rencana Kirim" gaya minimarket: kecepatan jual per produk dari
// ledger penjualan (web_stock_movement reason='sale') dalam N hari terakhir,
// sisa stok, perkiraan hari stok habis, dan SARAN jumlah kirim berikutnya.
//   avg/hari   = terjual ÷ days
//   cover      = sisa ÷ avg/hari  (berapa hari lagi stok bertahan)
//   saran      = ceil(avg/hari × (lead + cover_target) − sisa), 0 kalau cukup
// Klasifikasi fast/medium/slow berbasis peringkat qty terjual (relatif).
router.get('/report', requireRole(...SALES_REPORT_ROLES), async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const lead = Math.min(30, Math.max(0, Number(req.query.lead) || 3));
    const cover = Math.min(60, Math.max(1, Number(req.query.cover) || 10));

    const pad = (n) => String(n).padStart(2, '0');
    const since = new Date(Date.now() - days * 86400000);
    const sinceStr =
      `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())} ` +
      `${pad(since.getHours())}:${pad(since.getMinutes())}:${pad(since.getSeconds())}`;

    const [rows] = await pool.query(
      `SELECT CAST(p.prod_id AS CHAR) AS product_id, p.prod_desc AS product_name,
              p.category AS category, p.harga_jual AS price, p.harga_mdl AS cost, p.satuan AS unit,
              COALESCE(s.qty_on_hand, 0) AS qty_on_hand, COALESCE(s.min_stock, 5) AS min_stock,
              (s.product_id IS NOT NULL) AS managed,
              COALESCE(sold.sold_qty, 0) AS sold_qty
         FROM m_product p
         LEFT JOIN web_product_stock s
           ON s.product_id = CAST(p.prod_id AS CHAR) AND s.warehouse_id = ?
         LEFT JOIN (
           SELECT product_id, SUM(-delta) AS sold_qty
             FROM web_stock_movement
            WHERE warehouse_id = ? AND reason = 'sale' AND created_at >= ?
            GROUP BY product_id
         ) sold ON sold.product_id = CAST(p.prod_id AS CHAR)
        WHERE p.is_active = 'TRUE'
          AND (s.product_id IS NOT NULL OR sold.sold_qty > 0)`,
      [WAREHOUSE_ID, WAREHOUSE_ID, sinceStr]
    );

    // peringkat untuk kelas pergerakan (fast/medium/slow/mati)
    const withSales = rows.filter((r) => Number(r.sold_qty) > 0)
      .sort((a, b) => Number(b.sold_qty) - Number(a.sold_qty));
    const fastCut = Math.ceil(withSales.length * 0.2);
    const medCut = Math.ceil(withSales.length * 0.5);
    const classOf = new Map();
    withSales.forEach((r, i) => {
      classOf.set(r.product_id, i < fastCut ? 'fast' : i < medCut ? 'medium' : 'slow');
    });

    const STATUS_RANK = { habis: 0, kritis: 1, menipis: 2, aman: 3, overstock: 4, mati: 5 };
    const out = rows.map((r) => {
      const onHand = Number(r.qty_on_hand);
      const sold = Number(r.sold_qty);
      const min = Number(r.min_stock);
      const perDay = sold / days;
      const cls = classOf.get(r.product_id) || 'mati';
      const coverDays = onHand <= 0 ? 0 : (perDay > 0 ? onHand / perDay : null);
      const suggested = perDay > 0
        ? Math.max(0, Math.ceil(perDay * (lead + cover) - onHand))
        : 0;

      let status;
      if (onHand <= 0) status = sold > 0 ? 'habis' : 'mati';
      else if (perDay > 0 && coverDays !== null && coverDays < lead) status = 'kritis';
      else if (onHand <= min || (perDay > 0 && coverDays !== null && coverDays < cover)) status = 'menipis';
      else if (perDay > 0 && coverDays !== null && coverDays > cover * 3) status = 'overstock';
      else if (sold === 0) status = 'mati';
      else status = 'aman';

      return {
        product_id: r.product_id,
        product_name: r.product_name,
        category: r.category || '-',
        unit: r.unit || '',
        price: Number(r.price) || 0,
        cost: Number(r.cost) || 0,
        managed: Boolean(r.managed),
        qty_on_hand: onHand,
        min_stock: min,
        sold_qty: sold,
        avg_per_day: Math.round(perDay * 100) / 100,
        cover_days: coverDays === null ? null : Math.round(coverDays * 10) / 10,
        suggested_order: suggested,
        suggested_value: suggested * (Number(r.cost) || 0),
        movement_class: cls,
        status,
      };
    }).sort((a, b) =>
      (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (b.sold_qty - a.sold_qty)
    );

    const summary = {
      total_products: out.length,
      need_order: out.filter((r) => r.suggested_order > 0).length,
      out_of_stock: out.filter((r) => r.status === 'habis').length,
      critical: out.filter((r) => r.status === 'kritis').length,
      dead_stock: out.filter((r) => r.status === 'mati').length,
      suggested_value_total: out.reduce((s, r) => s + r.suggested_value, 0),
    };

    res.json({
      window_days: days,
      lead_days: lead,
      cover_target_days: cover,
      since: sinceStr,
      generated_at: new Date().toISOString(),
      summary,
      rows: out,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/sales-detail?from=YYYY-MM-DD&to=YYYY-MM-DD&category=&sort=&dir=
//
// Laporan "Barang Terjual" per periode BEBAS (bukan rolling N-hari seperti
// /report) - dipakai buat siapin/cocokkan Stock Opname parsial per kategori
// (mis. "sebelum hitung fisik minuman, lihat dulu apa saja yang terjual
// minggu ini"). qty_on_hand yang ikut ditampilkan adalah stok SISTEM saat
// ini (bukan snapshot periode) - itu yang nanti jadi qty_system_snapshot
// kalau opname disubmit sekarang.
router.get('/sales-detail', requireRole(...SALES_REPORT_ROLES), async (req, res, next) => {
  try {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const parseDateOnly = (str) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const defaultFrom = new Date(today.getTime() - 6 * 86400000); // 7 hari termasuk hari ini

    const fromDate = parseDateOnly(req.query.from) || defaultFrom;
    const toDateInput = parseDateOnly(req.query.to) || today;
    if (fromDate > toDateInput) throw new AppError(400, "Tanggal 'from' tidak boleh setelah 'to'.");
    const toExclusive = new Date(toDateInput.getTime() + 86400000); // sampai akhir hari 'to'

    const category = (req.query.category || '').trim();
    const sortKey = ['sold_qty', 'name', 'category', 'qty_on_hand'].includes(req.query.sort)
      ? req.query.sort : 'sold_qty';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

    const [rows] = await pool.query(
      `SELECT CAST(p.prod_id AS CHAR) AS product_id, p.prod_desc AS product_name,
              p.category AS category, p.harga_jual AS price, p.satuan AS unit,
              COALESCE(s.qty_on_hand, 0) AS qty_on_hand,
              COALESCE(sold.sold_qty, 0) AS sold_qty,
              COALESCE(sold.tx_count, 0) AS tx_count
         FROM m_product p
         LEFT JOIN web_product_stock s
           ON s.product_id = CAST(p.prod_id AS CHAR) AND s.warehouse_id = ?
         LEFT JOIN (
           SELECT product_id, SUM(-delta) AS sold_qty, COUNT(*) AS tx_count
             FROM web_stock_movement
            WHERE warehouse_id = ? AND reason = 'sale' AND created_at >= ? AND created_at < ?
            GROUP BY product_id
         ) sold ON sold.product_id = CAST(p.prod_id AS CHAR)
        WHERE p.is_active = 'TRUE'
          AND (? = '' OR p.category = ?)`,
      [WAREHOUSE_ID, WAREHOUSE_ID, fmt(fromDate), fmt(toExclusive), category, category]
    );

    const [catRows] = await pool.query(
      `SELECT DISTINCT category FROM m_product
        WHERE is_active = 'TRUE' AND category IS NOT NULL AND category <> ''
        ORDER BY category`
    );

    const out = rows.map((r) => ({
      product_id: r.product_id,
      product_name: r.product_name,
      category: r.category || '-',
      unit: r.unit || '',
      price: Number(r.price) || 0,
      qty_on_hand: Number(r.qty_on_hand),
      sold_qty: Number(r.sold_qty),
      tx_count: Number(r.tx_count),
      revenue_est: Number(r.sold_qty) * (Number(r.price) || 0),
    }));

    const SORT_FIELD = { sold_qty: 'sold_qty', name: 'product_name', category: 'category', qty_on_hand: 'qty_on_hand' };
    const field = SORT_FIELD[sortKey];
    out.sort((a, b) => {
      let cmp;
      if (typeof a[field] === 'string') cmp = a[field].localeCompare(b[field]);
      else cmp = a[field] - b[field];
      if (cmp === 0) cmp = b.sold_qty - a.sold_qty; // tie-break: terlaris duluan
      return dir === 'asc' ? cmp : -cmp;
    });

    const summary = {
      total_products: out.length,
      total_sold_qty: out.reduce((s, r) => s + r.sold_qty, 0),
      total_revenue_est: out.reduce((s, r) => s + r.revenue_est, 0),
      products_with_sales: out.filter((r) => r.sold_qty > 0).length,
      products_no_sales: out.filter((r) => r.sold_qty === 0).length,
    };

    res.json({
      from: fmt(fromDate).slice(0, 10),
      to: fmt(toDateInput).slice(0, 10),
      category: category || null,
      sort: sortKey,
      dir,
      categories: catRows.map((r) => r.category),
      generated_at: new Date().toISOString(),
      summary,
      rows: out,
    });
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
// Set stok ke nilai absolut LANGSUNG, di luar alur opname - dipakai utk
// input stok awal & koreksi darurat. reason 'opening' kalau produk belum
// punya baris stok, selain itu 'adjustment'. Khusus admin/supervisor sejak
// migration 014 - stokis ('gudang') pakai alur opname (POST /opname) yang
// hasilnya baru dieksekusi lewat POST /opname/:id/apply.
router.post('/:productId/adjust', requireRole(...STOCK_ADJUST_ROLES), async (req, res, next) => {
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

// =====================================================================
// Stock Opname dua-tahap. Lihat catatan panjang di
// migrations/014_stock_opname.sql: stokis SUBMIT hitung fisik (tidak
// mengubah stok), admin/supervisor unit yang APPLY setelah holding
// review (di luar sistem ini, lewat dashboard pusat kalau sudah aktif -
// lihat central-reporting/) memberi lampu hijau.
// =====================================================================

// -------------------------------------------------------------------
// Email laporan Stock Opname (2026-09-14: menggantikan approval holding -
// lihat catatan panjang di config/opname.js). Dikirim otomatis setiap kali
// stokis submit; gagal kirim TIDAK membatalkan opname yang sudah
// diterapkan - hanya dicatat di email_error (pola sama dgn hotelFnb.routes.js
// emailReport).
// -------------------------------------------------------------------
function escHtmlSrv(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function opnameEmailHtml({ opnameId, note, createdByName, items }) {
  const negatives = items.filter((r) => r.qty_after < 0);
  const rows = items.map((r) => `
    <tr style="${r.qty_after < 0 ? 'background:#ffe5e5' : ''}">
      <td>${escHtmlSrv(r.product_name)}</td>
      <td>${escHtmlSrv(r.category || '-')}</td>
      <td style="text-align:right">${r.qty_system_snapshot}</td>
      <td style="text-align:right">${r.qty_physical}</td>
      <td style="text-align:right;font-weight:bold">${r.delta > 0 ? '+' : ''}${r.delta}</td>
      <td style="text-align:right">${r.qty_after}</td>
    </tr>`).join('');
  return `
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#222">
      <h2 style="margin:0 0 4px">Laporan Stock Opname - ${escHtmlSrv(UNIT_NAME)}</h2>
      <p style="margin:0 0 10px;color:#555">
        Sesi <code>${opnameId}</code> &middot; disubmit oleh <b>${escHtmlSrv(createdByName || '-')}</b> &middot;
        ${new Date().toLocaleString('id-ID')}${note ? ' &middot; Catatan: ' + escHtmlSrv(note) : ''}
      </p>
      <p style="margin:0 0 10px">${items.length} produk dihitung dan LANGSUNG diterapkan ke stok${negatives.length ? `, <b style="color:#c0392b">${negatives.length} produk stoknya MINUS</b> setelah opname` : ''}.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12.5px">
        <thead>
          <tr style="background:#f0f0f0;text-align:left">
            <th>Produk</th><th>Kategori</th><th style="text-align:right">Sistem</th>
            <th style="text-align:right">Fisik</th><th style="text-align:right">Selisih</th><th style="text-align:right">Stok Akhir</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function opnameEmailCsv(items) {
  const cols = ['produk', 'kategori', 'stok_sistem', 'stok_fisik', 'selisih', 'stok_akhir'];
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [cols.map(cell).join(',')];
  for (const r of items) {
    lines.push([r.product_name, r.category || '', r.qty_system_snapshot, r.qty_physical, r.delta, r.qty_after].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function sendOpnameReportEmail({ opnameId, note, createdByName, items }) {
  if (!opnameMailConfigured()) {
    return { emailed: false, email_to: null, email_error: 'SMTP / OPNAME_REPORT_RECIPIENTS belum dikonfigurasi di .env.' };
  }
  const negatives = items.filter((r) => r.qty_after < 0).length;
  const subject = `Laporan Stock Opname - ${UNIT_NAME} - ${new Date().toLocaleDateString('id-ID')}` +
    (negatives ? ` (${negatives} produk MINUS)` : '');
  await mailer.sendMail({
    subject,
    html: opnameEmailHtml({ opnameId, note, createdByName, items }),
    csv: opnameEmailCsv(items),
    csvFilename: `stock-opname_${opnameId.slice(0, 8)}.csv`,
    to: OPNAME_REPORT_RECIPIENTS,
  });
  return { emailed: true, email_to: OPNAME_REPORT_RECIPIENTS.join(', '), email_error: null };
}

// GET /api/inventory/opname?status=pending|applied|rejected
// Baca boleh siapa saja yang login (requireAuth di atas), sama seperti
// endpoint GET inventory lain - halaman yang menyaring tombol per role.
router.get('/opname', async (req, res, next) => {
  try {
    const status = ['pending', 'applied', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const [headers] = await pool.query(
      `SELECT o.opname_id, o.status, o.item_count, o.note, o.created_at, o.applied_at, o.reject_note,
              o.emailed_at, o.email_error,
              cu.full_name AS created_by_name, au.full_name AS applied_by_name
         FROM web_stock_opname o
         LEFT JOIN web_users cu ON cu.user_id = o.created_by_user_id
         LEFT JOIN web_users au ON au.user_id = o.applied_by_user_id
        WHERE (? IS NULL OR o.status = ?)
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [status, status]
    );
    res.json({ sessions: headers });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/opname/:id - detail 1 sesi + item + stok TERKINI tiap
// produk (bukan snapshot submit) supaya admin lihat kalau stok sudah
// bergerak sejak stokis submit, sebelum menekan "Terapkan".
router.get('/opname/:id', async (req, res, next) => {
  try {
    const [[header]] = await pool.query(
      `SELECT o.opname_id, o.status, o.item_count, o.note, o.created_at, o.applied_at, o.reject_note,
              o.emailed_at, o.email_to, o.email_error,
              cu.full_name AS created_by_name, au.full_name AS applied_by_name
         FROM web_stock_opname o
         LEFT JOIN web_users cu ON cu.user_id = o.created_by_user_id
         LEFT JOIN web_users au ON au.user_id = o.applied_by_user_id
        WHERE o.opname_id = ?`,
      [req.params.id]
    );
    if (!header) throw new AppError(404, 'Sesi opname tidak ditemukan.');

    const [items] = await pool.query(
      `SELECT i.product_id, p.prod_desc AS product_name, i.qty_system_snapshot, i.qty_physical,
              i.delta_snapshot, i.applied_delta, i.note,
              COALESCE(s.qty_on_hand, 0) AS qty_current
         FROM web_stock_opname_item i
         LEFT JOIN m_product p ON CAST(p.prod_id AS CHAR) = i.product_id
         LEFT JOIN web_product_stock s ON s.product_id = i.product_id AND s.warehouse_id = ?
        WHERE i.opname_id = ?
        ORDER BY i.id`,
      [WAREHOUSE_ID, req.params.id]
    );
    res.json({ ...header, items });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/opname/:id/signer-json
// JSON siap-tempel ke halaman signer HOLDING. Berisi identitas sesi + tiap
// item dengan angka sistem & hitungan stokis. Holding lah yang mengisi
// "approved_qty" per item di halaman signer lalu menandatangani.
router.get('/opname/:id/signer-json', async (req, res, next) => {
  try {
    const [[header]] = await pool.query(
      `SELECT o.opname_id, o.status, o.item_count, o.note, o.created_at,
              cu.full_name AS created_by_name
         FROM web_stock_opname o
         LEFT JOIN web_users cu ON cu.user_id = o.created_by_user_id
        WHERE o.opname_id = ?`,
      [req.params.id]
    );
    if (!header) throw new AppError(404, 'Sesi opname tidak ditemukan.');
    const [items] = await pool.query(
      `SELECT i.product_id, p.prod_desc AS product_name, i.qty_system_snapshot,
              i.qty_physical, i.delta_snapshot, i.note,
              COALESCE(s.qty_on_hand, 0) AS qty_current
         FROM web_stock_opname_item i
         LEFT JOIN m_product p ON CAST(p.prod_id AS CHAR) = i.product_id
         LEFT JOIN web_product_stock s ON s.product_id = i.product_id AND s.warehouse_id = ?
        WHERE i.opname_id = ?
        ORDER BY i.id`,
      [WAREHOUSE_ID, req.params.id]
    );
    res.json({
      kind: 'gr_pos_opname_for_signing',
      opname_id: header.opname_id,
      unit_id: UNIT_ID,
      warehouse_id: WAREHOUSE_ID,
      status: header.status,
      submitted_by: header.created_by_name,
      submitted_at: header.created_at,
      note: header.note,
      items: items.map((i) => ({
        product_id: i.product_id,
        product_name: i.product_name,
        qty_system: Number(i.qty_system_snapshot),
        qty_physical_stokis: Number(i.qty_physical),
        qty_current: Number(i.qty_current),
        stokis_note: i.note || null,
        approved_qty: Number(i.qty_physical), // default = hitungan stokis; holding boleh ubah
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/opname  body: { note, items: [{ product_id, qty_physical, note }] }
//
// 2026-09-14: submit stokis LANGSUNG diterapkan ke stok (approval holding
// dihapus - keputusan konsolidasi user dgn bagian gudang, lihat catatan
// panjang di config/opname.js). Delta per produk dihitung ULANG dari
// qty_on_hand SAAT INI oleh stock.applyOpnameItem (row locking FOR UPDATE
// di sana) - bukan snapshot yang dibaca sebelum transaction dibuka, jadi
// tetap aman kalau ada penjualan nyelip di antaranya.
// Sesudah commit: kirim email laporan ke OPNAME_REPORT_RECIPIENTS (default
// warehouse@pancorangroup.com). Gagal kirim TIDAK membatalkan stok yang
// sudah berubah - dicatat di email_error, opname tetap 'applied'.
router.post('/opname', requireRole(...OPNAME_SUBMIT_ROLES), async (req, res, next) => {
  try {
    const { note, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      throw new AppError(400, 'Minimal 1 produk harus dihitung.');
    }
    for (const it of items) {
      if (!it || !it.product_id || !Number.isInteger(Number(it.qty_physical)) || Number(it.qty_physical) < 0) {
        throw new AppError(400, 'Setiap baris butuh product_id dan qty_physical (bilangan bulat >= 0).');
      }
    }

    const opnameId = crypto.randomUUID();
    const productIds = items.map((it) => String(it.product_id));
    const [nameRows] = await pool.query(
      `SELECT CAST(prod_id AS CHAR) AS product_id, prod_desc AS product_name, category
         FROM m_product WHERE prod_id IN (?)`,
      [productIds]
    );
    const infoByProduct = new Map(nameRows.map((r) => [r.product_id, { name: r.product_name, category: r.category }]));

    const applied = await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO web_stock_opname (opname_id, unit_id, warehouse_id, status, item_count, note, created_by_user_id, applied_by_user_id, applied_at)
         VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [opnameId, UNIT_ID, WAREHOUSE_ID, items.length, (note || '').trim() || null, req.user.user_id, req.user.user_id]
      );

      const out = [];
      for (const it of items) {
        const pid = String(it.product_id);
        const itemNote = (it.note || '').trim() || null;
        const physical = Number(it.qty_physical);
        const result = await stock.applyOpnameItem(conn, {
          productId: pid,
          qtyPhysical: physical,
          opnameId,
          note: itemNote,
          userId: req.user.user_id,
          terminalId: req.terminalId,
        });
        const qtySystemSnapshot = result.qty_after - result.delta; // stok sebelum diterapkan
        await conn.query(
          `INSERT INTO web_stock_opname_item
             (opname_id, product_id, qty_system_snapshot, qty_physical, delta_snapshot, applied_delta, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [opnameId, pid, qtySystemSnapshot, physical, result.delta, result.delta, itemNote]
        );
        const info = infoByProduct.get(pid) || {};
        out.push({
          product_id: pid,
          product_name: info.name || pid,
          category: info.category || null,
          qty_system_snapshot: qtySystemSnapshot,
          qty_physical: physical,
          delta: result.delta,
          qty_after: result.qty_after,
        });
      }

      if (SYNC_OUTBOX_ENABLED) {
        await conn.query(
          `INSERT INTO web_sync_outbox (event_uid, aggregate, aggregate_id, unit_id, payload)
           VALUES (?, 'stock_opname', ?, ?, ?)`,
          [
            crypto.randomUUID(),
            opnameId,
            UNIT_ID,
            JSON.stringify({
              opname_id: opnameId,
              unit_id: UNIT_ID,
              warehouse_id: WAREHOUSE_ID,
              status: 'applied',
              note: (note || '').trim() || null,
              created_by_user_id: req.user.user_id,
              applied_by_user_id: req.user.user_id,
              created_at: new Date().toISOString(),
              items: out,
            }),
          ]
        );
      }
      return out;
    });

    let emailResult;
    try {
      emailResult = await sendOpnameReportEmail({ opnameId, note, createdByName: req.user.full_name, items: applied });
    } catch (e) {
      emailResult = { emailed: false, email_to: null, email_error: String(e.message).slice(0, 500) };
    }
    await pool.query(
      `UPDATE web_stock_opname SET emailed_at = ?, email_to = ?, email_error = ? WHERE opname_id = ?`,
      [emailResult.emailed ? new Date() : null, emailResult.email_to, emailResult.email_error, opnameId]
    );

    res.status(201).json({
      opname_id: opnameId,
      status: 'applied',
      item_count: applied.length,
      items: applied,
      emailed: emailResult.emailed,
      email_error: emailResult.email_error,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/opname/:id/apply
// Eksekusi sesi PENDING: tulis delta SEBENARNYA (dihitung ulang dari stok
// saat ini, lihat stock.service.applyOpnameItem) ke web_product_stock +
// web_stock_movement (reason 'stock_opname'), yang otomatis ikut naik ke
// pusat lewat jalur outbox 'stock_movement' yang sudah ada. Khusus
// admin/supervisor - lihat catatan wewenang di 014_stock_opname.sql.
router.post('/opname/:id/apply', requireRole(...OPNAME_APPLY_ROLES), async (req, res, next) => {
  try {
    if (!OPNAME_LOCAL_APPLY) {
      throw new AppError(403, 'Terapkan opname secara lokal DIMATIKAN. Opname hanya bisa diterapkan lewat impor file persetujuan holding (POST /opname/:id/import-approval).');
    }
    const opnameId = req.params.id;

    // Header dikunci FOR UPDATE di DALAM transaction yang sama dgn eksekusi
    // item: kalau 2 admin menekan "Terapkan" bersamaan, request kedua
    // menunggu request pertama commit lalu lihat status sudah 'applied' ->
    // 409, bukan ikut menerapkan dobel (lihat pola sama di stock.service
    // setAbsolute).
    const applied = await withTransaction(async (conn) => {
      const [[header]] = await conn.query('SELECT status FROM web_stock_opname WHERE opname_id = ? FOR UPDATE', [
        opnameId,
      ]);
      if (!header) throw new AppError(404, 'Sesi opname tidak ditemukan.');
      if (header.status !== 'pending') throw new AppError(409, `Sesi ini sudah berstatus '${header.status}'.`);

      const [items] = await conn.query(
        'SELECT product_id, qty_physical, note FROM web_stock_opname_item WHERE opname_id = ?',
        [opnameId]
      );

      const out = [];
      for (const it of items) {
        const result = await stock.applyOpnameItem(conn, {
          productId: it.product_id,
          qtyPhysical: it.qty_physical,
          opnameId,
          note: it.note,
          userId: req.user.user_id,
          terminalId: req.terminalId,
        });
        await conn.query('UPDATE web_stock_opname_item SET applied_delta = ? WHERE opname_id = ? AND product_id = ?', [
          result.delta,
          opnameId,
          it.product_id,
        ]);
        out.push(result);
      }
      await conn.query(
        'UPDATE web_stock_opname SET status = ?, applied_by_user_id = ?, applied_at = CURRENT_TIMESTAMP WHERE opname_id = ?',
        ['applied', req.user.user_id, opnameId]
      );
      return out;
    });

    res.json({ opname_id: opnameId, status: 'applied', items: applied });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/opname/:id/reject  body: { note }
// Batalkan sesi PENDING tanpa menyentuh stok (mis. hasil hitung dianggap
// salah / mau diulang). Khusus admin/supervisor.
router.post('/opname/:id/reject', requireRole(...OPNAME_APPLY_ROLES), async (req, res, next) => {
  try {
    if (!OPNAME_LOCAL_APPLY) {
      throw new AppError(403, 'Tolak opname secara lokal DIMATIKAN. Keputusan (approve/reject) datang dari file persetujuan holding.');
    }
    const opnameId = req.params.id;
    const { note } = req.body || {};

    await withTransaction(async (conn) => {
      const [[header]] = await conn.query('SELECT status FROM web_stock_opname WHERE opname_id = ? FOR UPDATE', [
        opnameId,
      ]);
      if (!header) throw new AppError(404, 'Sesi opname tidak ditemukan.');
      if (header.status !== 'pending') throw new AppError(409, `Sesi ini sudah berstatus '${header.status}'.`);

      await conn.query(
        `UPDATE web_stock_opname SET status = 'rejected', applied_by_user_id = ?, applied_at = CURRENT_TIMESTAMP, reject_note = ?
         WHERE opname_id = ?`,
        [req.user.user_id, (note || '').trim() || null, opnameId]
      );
    });
    res.json({ opname_id: opnameId, status: 'rejected' });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/opname/:id/import-approval   body: { blob }
// Impor FILE PERSETUJUAN HOLDING (blob bertanda tangan ECDSA P-256).
// OTORITAS = tanda tangan holding, BUKAN role user yang mengunggah - jadi
// stokis/admin/supervisor unit boleh mengunggah (mereka tak bisa memalsukan).
// - Verifikasi tanda tangan thd OPNAME_APPLY_PUBKEY.
// - Cek opname_id / unit_id / status 'pending' / nonce belum dipakai.
// - decision 'approved' -> tulis delta (qty_disetujui holding vs stok terkini)
//   ke web_stock_movement (reason 'stock_opname'); 'rejected' -> tandai rejected.
router.post('/opname/:id/import-approval', requireRole(...OPNAME_SUBMIT_ROLES), async (req, res, next) => {
  try {
    const result = await opnameApproval.applyApprovalBlob({
      opnameId: req.params.id,
      blob: req.body && req.body.blob,
      actorUserId: req.user.user_id,
      terminalId: req.terminalId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
