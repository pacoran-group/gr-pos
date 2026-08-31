const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/catalog/products - dipakai utk dropdown pemilihan item FnB
//
// CATATAN (27 Agustus 2026): query ini sebelumnya pakai nama kolom generik
// (product_id, product_name, price, category_id, active) yang TERNYATA tidak
// sama dengan skema asli tabel m_product produksi (dikonfirmasi lewat export
// Navicat: prod_id, prod_desc, harga_jual, category [teks nama kategori,
// bukan id numerik], is_active). Query lama gagal total (unknown column),
// itu sebabnya katalog menu kosong di halaman Orders/Room Detail. Kolom
// prod_id di-CAST ke CHAR supaya product_id konsisten bertipe string di
// seluruh app (cocok dengan web_tr_trans_details.product_id &
// web_product_routing.product_id yang VARCHAR(25) - lihat
// desain-teknis-room-billing.md bagian 4), dan supaya perbandingan
// product_id di frontend (yang selalu berupa string dari data-id di DOM)
// tidak gagal karena mismatch tipe number vs string.
//
// CATATAN (27 Agustus 2026, lanjutan): m_product.is_active TERNYATA
// bertipe varchar(15) berisi TEKS 'TRUE'/'FALSE' (bukan angka/tinyint).
// Filter lama `is_active = 1` di MySQL/MariaDB meng-cast 'TRUE' -> 0
// sehingga `0 = 1` selalu false => query mengembalikan 0 baris dan
// katalog menu tampil kosong TANPA error (HTTP 200, products: []).
// Harus dibandingkan sebagai string: `is_active = 'TRUE'`.
router.get('/products', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT CAST(prod_id AS CHAR) AS product_id, prod_desc AS product_name,
              harga_jual AS price, category AS category_id
       FROM m_product WHERE is_active = 'TRUE' ORDER BY prod_desc`
    );
    res.json({ products: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/catalog/categories - dipakai utk tab filter kategori di halaman order
//
// CATATAN (27 Agustus 2026): m_product.category menyimpan TEKS nama kategori
// langsung (mis. "MAKANAN"), bukan id numerik yang merujuk ke m_category.id -
// jadi category_id/category_name di sini dibuat dari teks itu sendiri (bukan
// join ke m_category), supaya konsisten dgn category_id yang dikirim di
// /products di atas. Diambil DISTINCT dari produk yang aktif saja, supaya
// tab kategori yang tidak dipakai produk manapun (mis. kategori "I" yang
// anomali - lihat desain-teknis-room-billing.md) tidak ikut muncul.
// is_active = 'TRUE' (teks), lihat catatan di /products di atas.
router.get('/categories', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT category AS category_id, category AS category_name
       FROM m_product WHERE is_active = 'TRUE' AND category IS NOT NULL ORDER BY category`
    );
    res.json({ categories: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/catalog/members - dipakai utk pemilihan member saat Buka Kamar
//
// CATATAN (27 Agustus 2026): skema asli m_member (export dari bintangnew):
//   id_member, ktp, nama_member, alamat, telp, disc_room, disc_fnb, tgl_expired
// - TIDAK ada kolom member_id / member_name / disc_*_pct / active. Query lama
// memakai nama generik itu -> unknown column -> endpoint 500. Alias dipakai
// supaya bentuk respons (member_id / member_name / disc_room_pct /
// disc_fnb_pct) tetap sama seperti yang diharapkan frontend. "Aktif" =
// belum lewat tanggal expired.
router.get('/members', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_member AS member_id, nama_member AS member_name,
              disc_room AS disc_room_pct, disc_fnb AS disc_fnb_pct
       FROM m_member WHERE tgl_expired >= CURDATE() ORDER BY nama_member`
    );
    res.json({ members: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
