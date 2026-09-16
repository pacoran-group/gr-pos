-- =====================================================================
-- Migration 017 (9 September 2026): Bayar-per-order + harga INKLUSIF penuh.
--
-- Perubahan operasi (permintaan user):
--   - Harga yang ditampilkan & ditagih = INKLUSIF: sudah termasuk
--     Service Charge 10% + Pajak Restoran (PB1) 10%. (Rokok: tetap harga
--     apa adanya - bebas SC & pajak.) m_product.harga_jual TIDAK diubah
--     (tetap DPP); aplikasi yang gross-up saat menampilkan/menagih.
--   - SETIAP order dibayar PENUH saat itu juga (buka kamar + tiap tambah
--     item). Dapur/gudang hanya menerima tiket utk item order tsb.
--   - Struk "close room" = REKAP saja, TIDAK ada transaksi pembayaran
--     (semua sudah lunas). Kalau ada kekurangan (kasir lupa menagih 1
--     ronde), kekurangan itu bisa ditagih di checkout sebagai jaring
--     pengaman.
--
--   Dipakai saat BILLING_MODE=inclusive DAN RESTO_TAX_PCT>0 (lihat
--   server/config/billing.js). BILLING_MODE=plusplus tetap ada tapi tidak
--   dipakai lagi.
--
-- Aman dijalankan ulang.
-- =====================================================================

-- Riwayat pembayaran per transaksi (bisa banyak baris: buka + tiap tambah).
CREATE TABLE IF NOT EXISTS web_tr_trans_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  kind ENUM('buka', 'tambah', 'settle', 'refund') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,               -- nominal inklusif yang dibayar
  method VARCHAR(12) NOT NULL DEFAULT 'cash',   -- cash | qris | card
  paid_by_user_id INT NOT NULL,
  paid_at_terminal VARCHAR(50) NOT NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id)
) ENGINE=InnoDB;

-- Tandai baris item mana yang dibayar di ronde mana (utk struk per-order &
-- audit). NULL = order pembukaan.
ALTER TABLE web_tr_trans_details
  ADD COLUMN IF NOT EXISTS payment_id INT NULL AFTER sc_tax_exempt;

ALTER TABLE web_tr_trans_history
  MODIFY COLUMN action
    ENUM('buka_kamar','tambah_order','tambah_jam','tutup_kamar','batal','void_item','bayar_order') NOT NULL;

ALTER TABLE web_print_log
  MODIFY COLUMN print_type
    ENUM('slip_gudang','billing_room','tiket_dapur','tiket_bar','tagihan_akhir','slip_retur','tiket_dapur_batal','slip_fnb_hotel','struk_order') NOT NULL;
