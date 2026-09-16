-- =====================================================================
-- Migration 020 (14 September 2026): Stock Opname - approval holding
-- DIHAPUS atas keputusan konsolidasi user dengan bagian gudang.
--
-- Submit stokis sekarang LANGSUNG diterapkan ke stok (lihat
-- inventory.routes.js POST /opname) - tidak ada lagi status 'pending'
-- menunggu admin/supervisor/holding. Yang gudang/holding butuh cuma:
--   1. Laporan email tiap sesi opname (kolom emailed_at/email_error/
--      email_to di bawah, dikirim ke OPNAME_REPORT_RECIPIENTS di .env,
--      default warehouse@pancorangroup.com - lihat config/opname.js).
--   2. Histori sesi opname + daftar produk yang stoknya minus - sudah
--      ada di inventory.html (tab Stok & Input, checkbox "Hanya stok
--      menipis/minus" + tab Stock Opname untuk histori).
--
-- Infrastruktur approval bertanda-tangan holding (migration 019: kolom
-- approved_by_holding/approval_nonce/approval_at/approval_blob,
-- OPNAME_APPLY_PUBKEY, OPNAME_LOCAL_APPLY, OPNAME_POLL_*) SENGAJA TIDAK
-- diubah/dihapus - dibiarkan idle sebagai jalur manual/rollback kalau
-- kebijakan ini berubah lagi, bukan berarti masih dipakai.
--
-- Aman dijalankan ulang. Hanya tabel web_.
-- =====================================================================

ALTER TABLE web_stock_opname
  ADD COLUMN IF NOT EXISTS emailed_at   DATETIME NULL     AFTER applied_at,
  ADD COLUMN IF NOT EXISTS email_to     VARCHAR(500) NULL AFTER emailed_at,
  ADD COLUMN IF NOT EXISTS email_error  VARCHAR(500) NULL AFTER email_to;
