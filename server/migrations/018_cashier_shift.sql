-- =====================================================================
-- Migration 018 (9 September 2026): Tutup Kasir / Shift (klerek).
--
-- Tujuan: 2 shift per hari, ingin tahu performa & rekonsiliasi kas TIAP
-- kasir. Kasir "Buka Kasir" (isi modal awal / kas laci) -> semua
-- pembayaran (web_tr_trans_payments) selama shift itu ditandai shift_id
-- -> "Tutup Kasir": sistem hitung penjualan per metode + kas seharusnya,
-- kasir input kas dihitung fisik -> selisih (lebih/kurang) + laporan.
--
-- EOD (Tutup Hari) TETAP jalan sebagai laporan harian final yang dikirim
-- email; laporan shift = on-screen + cetak thermal + tersimpan, dan EOD
-- dapat bagian "Per shift".
--
-- Aman dijalankan ulang.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_cashier_shift (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,                       -- kasir pemilik shift
  terminal_id VARCHAR(50) NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  opening_float DECIMAL(12,2) NOT NULL DEFAULT 0,   -- modal awal / kas laci
  counted_cash DECIMAL(12,2) NULL,                  -- kas fisik dihitung saat tutup
  expected_cash DECIMAL(12,2) NULL,                 -- kas seharusnya (snapshot sistem saat tutup)
  variance DECIMAL(12,2) NULL,                      -- counted_cash - expected_cash (+ lebih / - kurang)
  note VARCHAR(255) NULL,
  closed_by_user_id INT NULL,                       -- biasanya = user_id; SPV bisa paksa-tutup
  totals_snapshot LONGTEXT NULL,                    -- JSON ringkasan lengkap saat tutup
  INDEX idx_user_status (user_id, status),
  INDEX idx_opened (opened_at),
  INDEX idx_closed (closed_at)
) ENGINE=InnoDB;

-- Tiap baris pembayaran ditandai shift kasir yang sedang buka (NULL kalau
-- tak ada shift buka / fitur shift belum dipakai).
ALTER TABLE web_tr_trans_payments
  ADD COLUMN IF NOT EXISTS shift_id INT NULL AFTER trans_id;
ALTER TABLE web_tr_trans_payments
  ADD INDEX IF NOT EXISTS idx_shift (shift_id);
