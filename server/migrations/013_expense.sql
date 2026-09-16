-- =====================================================================
-- Migration 013 (3 September 2026): Pengeluaran unit - form sederhana.
--
-- Menggantikan alur "scan QR -> form n8n" (n8n.pancorangroup.com) yang
-- tidak jalan. Sekarang kasir/finance input pengeluaran LANGSUNG di
-- gr-pos: 1 halaman, 1 form (tanggal, vendor, unit bisnis, total,
-- catatan, unit beban utk subsidi silang, link bukti kuitansi di GDrive).
--
-- Ini menangkap TOTAL pengeluaran level-header saja (untuk laporan utama
-- pemasukan vs pengeluaran). Rincian per-item (OCR kuitansi oleh AI)
-- adalah proses terpisah di sistem pusat - tidak dikerjakan di sini.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS). Hanya tabel web_.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_expense (
  expense_id         INT AUTO_INCREMENT PRIMARY KEY,
  expense_date       DATE NOT NULL,                       -- Tanggal Transaksi (di kuitansi)
  vendor_name        VARCHAR(150) NOT NULL,               -- Nama Vendor / toko
  paying_unit        VARCHAR(60)  NOT NULL,               -- Unit Bisnis yang membayar
  charged_unit       VARCHAR(60)  NOT NULL,               -- Unit yang dibebani (subsidi silang); = paying_unit kalau tidak diisi
  amount             DECIMAL(14,2) NOT NULL,              -- Total pengeluaran (Rp)
  note               VARCHAR(500) NULL,                   -- Catatan bebas
  receipt_url        VARCHAR(500) NULL,                   -- Link bukti kuitansi (Google Drive dll)
  created_by_user_id INT NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_date (expense_date),
  INDEX idx_charged (charged_unit, expense_date)
) ENGINE=InnoDB;
