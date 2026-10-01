-- =====================================================================
-- Migration 025 (30 September 2026): Status kirim Tutup Hari -> ERPNext.
--
-- Tiap Tutup Hari (web_daily_close) dikirim sebagai 1 Journal Entry DRAFT
-- ke ERPNext (lihat server/services/erpnextSync.service.js dan dokumen
-- INTEGRASI-ERPNEXT.md). Kolom di bawah mencatat hasilnya supaya:
--   - kiriman gagal (ERP/internet mati) dicoba ulang otomatis,
--   - halaman Reports bisa menampilkan status + tombol kirim ulang.
--
-- erp_status: NULL (sender mati / belum pernah), 'pending', 'sent',
--             'exists' (JE hari itu sudah ada di ERP), 'skipped' (tidak ada
--             transaksi), 'failed'.
--
-- Aman dijalankan ulang.
-- =====================================================================

ALTER TABLE web_daily_close
  ADD COLUMN IF NOT EXISTS erp_status    VARCHAR(20)  NULL,
  ADD COLUMN IF NOT EXISTS erp_doc       VARCHAR(140) NULL,
  ADD COLUMN IF NOT EXISTS erp_error     VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS erp_attempts  INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS erp_synced_at DATETIME     NULL;
