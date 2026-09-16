-- ============================================================================
-- Migration 010: Comp Room (VIP / VVIP) - buka kamar TANPA minimum F&B.
-- Grand Royal POS - gr-pos. Tanggal: 31 Agustus 2026.
--
-- Latar belakang: tamu VVIP tidak pernah menentukan durasi & tidak beli F&B
-- di depan (belanja besar menyusul); tamu VIP mau pakai room tanpa F&B tapi
-- dengan batas waktu yang ditentukan kasir. Keduanya = mode 'comp':
--   - gate threshold F&B DILEWATI (di buka-kamar & tambah-jam)
--   - alokasi waktu DARI comp_hours (bukan proporsional belanja F&B)
--   - sesi TETAP NYATA: player 154 dinyalakan, struk tercetak, stok bergerak,
--     tagihan akhir menagih apa pun yang benar-benar dikonsumsi.
-- Berbeda dari Mode Test (is_test) yang "bukan tamu sungguhan".
--
-- Otorisasi: hanya boleh dibuka dengan password admin/supervisor - kolom
-- comp_approved_by_user_id merekam user yang mengotorisasi.
--
-- threshold_amount TETAP di-snapshot dengan nilai asli (bukan 0) supaya
-- laporan Tutup Hari bisa menampilkan "nilai komplimen" yang ditanggung.
--
-- Idempoten: tiap kolom hanya ADD kalau belum ada (aman dijalankan ulang).
-- ============================================================================

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_tr_trans'
               AND COLUMN_NAME = 'rate_mode');
SET @ddl := IF(@col = 0,
  "ALTER TABLE web_tr_trans ADD COLUMN rate_mode ENUM('threshold','comp') NOT NULL DEFAULT 'threshold' AFTER is_test",
  "SELECT 'web_tr_trans.rate_mode sudah ada' AS info");
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_tr_trans'
               AND COLUMN_NAME = 'comp_hours');
SET @ddl := IF(@col = 0,
  'ALTER TABLE web_tr_trans ADD COLUMN comp_hours DECIMAL(4,1) NULL AFTER rate_mode',
  "SELECT 'web_tr_trans.comp_hours sudah ada' AS info");
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_tr_trans'
               AND COLUMN_NAME = 'comp_reason');
SET @ddl := IF(@col = 0,
  'ALTER TABLE web_tr_trans ADD COLUMN comp_reason VARCHAR(150) NULL AFTER comp_hours',
  "SELECT 'web_tr_trans.comp_reason sudah ada' AS info");
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_tr_trans'
               AND COLUMN_NAME = 'comp_approved_by_user_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE web_tr_trans ADD COLUMN comp_approved_by_user_id INT NULL AFTER comp_reason',
  "SELECT 'web_tr_trans.comp_approved_by_user_id sudah ada' AS info");
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
