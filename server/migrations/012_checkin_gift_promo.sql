-- ============================================================================
-- Migration 012: Promo "Hadiah Check-in" (tipe promo baru 'checkin_gift').
-- Grand Royal POS - gr-pos. Tanggal: 31 Agustus 2026.
--
-- Kebutuhan (September): dalam window promo (mis. 1-30 Sep) & sebelum jam
-- 18:00, kalau tamu menunjukkan kartu ID saat check-in, mereka dapat 1
-- produk gratis (mis. Tahu) - tanpa syarat beli apa pun.
--
-- Model: promo type 'checkin_gift' dievaluasi HANYA saat buka-kamar. Kalau
-- berlaku (tanggal + jam + hari) dan - bila requires_id_check=1 - kasir
-- mencentang "tamu menunjukkan kartu ID", item hadiah (product_id x free_qty)
-- disisipkan ke pesanan lalu di-nol-kan lewat web_tr_trans.promo_disc_fnb.
-- Item hadiah TETAP mengurangi stok & memicu tiket dapur/slip gudang, dan
-- TIDAK menaikkan threshold waktu karaoke (gross - promo_disc = net tetap).
--
-- Tidak kena aturan larangan-overlap (bukan diskon atas produk yang dibeli).
--
-- Aman dijalankan ulang: MODIFY enum menetapkan ulang definisi; ADD COLUMN
-- dijaga cek information_schema.
-- ============================================================================

ALTER TABLE web_promo
  MODIFY type ENUM('b1g1','bundle','checkin_gift') NOT NULL;

ALTER TABLE web_promo_applied
  MODIFY promo_type ENUM('b1g1','bundle','checkin_gift') NOT NULL;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_promo'
               AND COLUMN_NAME = 'requires_id_check');
SET @ddl := IF(@col = 0,
  'ALTER TABLE web_promo ADD COLUMN requires_id_check TINYINT(1) NOT NULL DEFAULT 0 AFTER free_qty',
  "SELECT 'web_promo.requires_id_check sudah ada' AS info");
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
