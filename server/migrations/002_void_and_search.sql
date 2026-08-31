-- =====================================================================
-- Migration 002 (27 Agustus 2026): Void / Tukar item dengan otorisasi
-- supervisor/admin.
--
-- Latar belakang: kasir kadang perlu membatalkan sebagian item pada sesi
-- kamar yang MASIH aktif (mis. tamu mengembalikan 2 dari 5 minuman dan
-- menukarnya dengan minuman lain yang lebih mahal - upsale). Aksi ini
-- HARUS diotorisasi supervisor/admin (kasir memasukkan username+password
-- SPV di popup, tanpa logout). Setiap void dicetak sebagai SLIP RETUR ke
-- gudang, dan (untuk item yang perlu dimasak) TIKET BATAL ke layar dapur.
--
-- Perubahan total FnB otomatis benar karena semua tempat menjumlahkan
-- web_tr_trans_details.subtotal - void cukup mengurangi qty/subtotal baris
-- detail (atau menghapus baris bila qty habis). Tabel di bawah adalah
-- jejak audit permanen (siapa minta, siapa setujui, kapan, alasan).
--
-- Aman dijalankan ulang: ALTER ... MODIFY ENUM hasilnya idempoten,
-- CREATE TABLE IF NOT EXISTS tidak menimpa.
-- =====================================================================

ALTER TABLE web_tr_trans_history
  MODIFY COLUMN action
    ENUM('buka_kamar','tambah_order','tambah_jam','tutup_kamar','batal','void_item') NOT NULL;

ALTER TABLE web_print_log
  MODIFY COLUMN print_type
    ENUM('slip_gudang','billing_room','tiket_dapur','tiket_bar','tagihan_akhir','slip_retur','tiket_dapur_batal') NOT NULL;

CREATE TABLE IF NOT EXISTS web_tr_trans_void (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  detail_id INT NULL,                       -- id baris web_tr_trans_details asal (NULL bila barisnya sudah dihapus krn qty habis)
  product_id VARCHAR(25) NOT NULL,
  product_name_snapshot VARCHAR(150) NOT NULL,
  void_qty INT NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  subtotal_voided DECIMAL(12,2) NOT NULL,   -- price * void_qty (nominal yang dikeluarkan dari tagihan)
  reason VARCHAR(255) NULL,
  requested_by_user_id INT NOT NULL,        -- kasir yang menjalankan
  approved_by_user_id INT NOT NULL,         -- supervisor/admin yang mengotorisasi
  approved_at_terminal VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id)
) ENGINE=InnoDB;
