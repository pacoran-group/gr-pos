-- =====================================================================
-- Migration 006 (28 Agustus 2026): Laporan "Tutup Hari" (End-of-Day).
--
-- Aksi MANUAL: admin/supervisor menekan tombol "Tutup Hari" di halaman
-- Reports, sistem menghitung angka keuangan hari usaha itu, menyimpan
-- snapshot di sini, lalu (opsional) mengirim email ke tim finance
-- (ringkasan HTML + lampiran CSV level-transaksi).
--
-- Model pendapatan gr-pos: pendapatan = F&B bersih + service charge.
-- TIDAK ada charge sewa kamar/waktu, TIDAK ada PPN terpisah. Total akhir
-- transaksi tidak disimpan di web_tr_trans -> laporan menghitung ulang
-- dari web_tr_trans + web_tr_trans_details (rumus = server/services/bill.js,
-- identik dengan tutup-kamar).
--
-- TIDAK termasuk: COGS/laba kotor, rekonsiliasi kas/shift (tidak ada
-- modul shift/laci kas di sistem ini).
--
-- Hari usaha: karaoke jalan lewat tengah malam. EOD_CUTOFF_HOUR (.env,
-- default 5) -> hari usaha D = [D 05:00, (D+1) 05:00) berdasarkan
-- web_tr_trans.end_time. Waktu server DIANGGAP WIB (UTC+7, tanpa DST) -
-- tidak ada timezone handling di codebase; range_start/range_end disimpan
-- sebagai DATETIME naive WIB.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS). Hanya tabel web_
-- baru, tanpa FOREIGN KEY ke web_tr_trans, tidak menyentuh server 154.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_daily_close (
  unit_id               VARCHAR(30)  NOT NULL,
  business_date         DATE         NOT NULL,
  version               INT          NOT NULL DEFAULT 1,   -- +1 tiap regenerate tanggal sama
  generated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_by_user_id  INT          NULL,                 -- web_users.user_id (tanpa FK)
  range_start           DATETIME     NOT NULL,             -- batas bawah jendela, naive WIB
  range_end             DATETIME     NOT NULL,             -- batas atas, eksklusif
  payload               JSON         NOT NULL,             -- seluruh angka laporan + transactions[]
  csv_row_count         INT          NOT NULL DEFAULT 0,   -- == summary.closed_count
  emailed_at            DATETIME     NULL,
  email_to              VARCHAR(500) NULL,
  email_error           VARCHAR(500) NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (unit_id, business_date),
  INDEX idx_business_date (business_date)
) ENGINE=InnoDB;
