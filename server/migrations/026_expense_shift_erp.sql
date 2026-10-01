-- =====================================================================
-- Migration 026 (1 Oktober 2026): Pengeluaran tunai dari LACI KASIR
-- + kategori + kirim ke ERPNext (1 Journal Entry draft per pengeluaran).
--
-- Keputusan user:
--   - Semua pengeluaran unit dibayar TUNAI dari laci kasir; kasir sendiri
--     yang mencatat, otomatis memotong shift kasir yang sedang buka
--     (web_expense.shift_id).
--   - "Kas seharusnya" Tutup Kasir = modal + tunai masuk - pengeluaran shift
--     ini -> selisih kasir murni salah hitung, dan Kas di ERPNext TIDAK
--     terpotong dua kali (sekali lewat Selisih, sekali lewat JE pengeluaran).
--   - JE pengeluaran: Debit akun beban kategori / Kredit Kas Penjualan unit,
--     posting_date = hari usaha saat DICATAT (business_date) - tanggal kuitansi
--     (expense_date) hanya keterangan. Dikirim SETELAH shift-nya ditutup;
--     sejak itu pengeluaran terkunci (tak bisa diedit/dihapus).
--   - Bahan dapur/bar & gas = HPP (4220.000 - HPP Bahan Baku F&B - PG).
--
-- Pengeluaran lama (sebelum migration ini) tetap ada dengan shift_id NULL
-- & category NULL -> tidak dikirim ke ERP, tidak memengaruhi shift.
--
-- Aman dijalankan ulang.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_expense_category (
  code         VARCHAR(30)  NOT NULL PRIMARY KEY,
  label        VARCHAR(80)  NOT NULL,
  erp_account  VARCHAR(140) NOT NULL,          -- ID akun persis di ERPNext
  sort_order   INT          NOT NULL DEFAULT 0,
  active       TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- INSERT IGNORE: tidak menimpa pemetaan yang sudah diubah di DB.
INSERT IGNORE INTO web_expense_category (code, label, erp_account, sort_order) VALUES
  ('bahan_fnb',    'Bahan dapur & bar (es batu, buah, sayur, bumbu)', '4220.000 - HPP Bahan Baku F&B - PG', 10),
  ('gas',          'Gas / LPG dapur',                                  '4220.000 - HPP Bahan Baku F&B - PG', 20),
  ('perlengkapan', 'Perlengkapan & kebersihan (tisu, sabun, plastik)', '5130.010 - Biaya Perlengkapan Gudang - PG', 30),
  ('servis',       'Servis & perbaikan peralatan (sound, AC, TV)',     '5130.007 - Biaya Servis Peralatan Gudang - PG', 40),
  ('bangunan',     'Pemeliharaan bangunan',                            '5130.008 - Biaya Pemeliharaan Bgn Gudang - PG', 50),
  ('konsumsi',     'Konsumsi karyawan',                                '5120.006 - Biaya Konsumsi - PG', 60),
  ('upah_harian',  'Upah harian / kuli',                               '5120.002 - Biaya Gaji Karyawan Harian - PG', 70),
  ('parkir',       'Transport & parkir',                               '5110.003 - Biaya Parkir - PG', 80),
  ('bbm',          'BBM',                                              '5110.001 - Biaya BBM - PG', 90),
  ('atk',          'ATK & print',                                      '5130.005 - Biaya Alat Tulis Kantor - PG', 100),
  ('iuran',        'Iuran lingkungan / keamanan',                      '5130.011 - Iuran Bulanan - PG', 110),
  ('sumbangan',    'Sumbangan',                                        '5130.015 - Biaya Sumbangan - PG', 120),
  ('lain',         'Lain-lain',                                        '5130.012 - Biaya Serba Serbi - PG', 130);

ALTER TABLE web_expense
  ADD COLUMN IF NOT EXISTS category      VARCHAR(30)  NULL AFTER vendor_name,
  ADD COLUMN IF NOT EXISTS shift_id      INT          NULL AFTER category,
  ADD COLUMN IF NOT EXISTS business_date DATE         NULL AFTER shift_id,
  ADD COLUMN IF NOT EXISTS erp_status    VARCHAR(20)  NULL,
  ADD COLUMN IF NOT EXISTS erp_doc       VARCHAR(140) NULL,
  ADD COLUMN IF NOT EXISTS erp_error     VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS erp_attempts  INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS erp_synced_at DATETIME     NULL,
  ADD INDEX IF NOT EXISTS idx_shift (shift_id);
