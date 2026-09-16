-- =====================================================================
-- Migration 009 (29 Agu 2026): Promo produk - B1G1 & paket harga tetap.
--
-- Dibuat/dijadwalkan oleh supervisor (halaman /promo.html). Server meng-
-- AUTO-APPLY promo yang aktif & sedang berlaku (tanggal + jendela jam +
-- hari) saat buka-kamar / tambah-order / void, atas SELURUH keranjang.
--
-- Aturan (keputusan user 29 Agu 2026):
--  - B1G1: hanya produk SAMA PERSIS. Tiap kelipatan (buy_qty+free_qty)
--    unit, `free_qty` unit gratis. Diskon = free_units * harga_satuan.
--  - Bundle: kalau SEMUA komponen ada di keranjang (qty >= yang diminta),
--    subtotal gabungan komponen (sejumlah bundle lengkap) diganti
--    `bundle_price`. Diskon = (harga penuh - bundle_price) * jml_bundle.
--  - TIDAK BOLEH OVERLAP: satu produk tidak boleh dipakai >1 promo aktif
--    (ditegakkan di server/routes/promo.routes.js).
--  - Item gratis TETAP mengurangi stok (unit nyata keluar gudang) dan
--    TIDAK dihitung untuk threshold waktu karaoke (gratis != belanja).
--
-- Diskon promo diakumulasi ke web_tr_trans.promo_disc_fnb; bill.js
-- mengurangkannya dari net_fnb (sejalur dengan member_disc_*, yang kini 0).
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS + ALTER idempoten via
-- cek kolom). Hanya tabel web_ baru + 1 kolom di web_tr_trans (tabel milik
-- aplikasi baru). Tidak menyentuh server 154.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_promo (
  promo_id           INT AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(120) NOT NULL,
  type               ENUM('b1g1','bundle') NOT NULL,
  -- B1G1
  product_id         VARCHAR(25) NULL,               -- CAST(m_product.prod_id AS CHAR)
  buy_qty            INT NOT NULL DEFAULT 1,
  free_qty           INT NOT NULL DEFAULT 1,
  -- Bundle
  bundle_price       DECIMAL(12,2) NULL,
  -- Berlaku kapan
  active             TINYINT(1) NOT NULL DEFAULT 1,
  start_date         DATE NULL,                       -- NULL = tanpa batas awal
  end_date           DATE NULL,                       -- NULL = tanpa batas akhir
  start_time         TIME NULL,                       -- NULL+NULL = sepanjang hari
  end_time           TIME NULL,                       -- start>end = lewat tengah malam
  days_of_week       VARCHAR(20) NULL,                -- CSV 1..7 (ISO, Sen=1). NULL = semua hari
  note               VARCHAR(255) NULL,
  created_by_user_id INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (active),
  INDEX idx_type (type),
  INDEX idx_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS web_promo_bundle_item (
  promo_id    INT NOT NULL,
  product_id  VARCHAR(25) NOT NULL,
  qty         INT NOT NULL DEFAULT 1,
  PRIMARY KEY (promo_id, product_id),
  INDEX idx_promo (promo_id),
  CONSTRAINT fk_wpbi_promo FOREIGN KEY (promo_id) REFERENCES web_promo(promo_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Jejak promo yang KENA di sebuah transaksi (snapshot utk laporan & audit).
-- Ditulis ulang (DELETE+INSERT per trans_id) tiap kali keranjang berubah.
CREATE TABLE IF NOT EXISTS web_promo_applied (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  trans_id        VARCHAR(30) NOT NULL,
  promo_id        INT NOT NULL,
  promo_name      VARCHAR(120) NOT NULL,
  promo_type      ENUM('b1g1','bundle') NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL,
  detail          JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id),
  INDEX idx_promo (promo_id)
) ENGINE=InnoDB;

-- Kolom diskon promo di header transaksi. Idempoten: hanya ADD kalau belum ada.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_tr_trans'
               AND COLUMN_NAME = 'promo_disc_fnb');
SET @ddl := IF(@col = 0,
  'ALTER TABLE web_tr_trans ADD COLUMN promo_disc_fnb DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER member_disc_fnb',
  'SELECT ''web_tr_trans.promo_disc_fnb sudah ada'' AS info');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
