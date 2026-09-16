-- =====================================================================
-- Migration 019 (9 September 2026): Persetujuan Stock Opname oleh HOLDING
-- lewat FILE BERTANDA-TANGAN (impor), bukan tombol "Terapkan" di unit.
--
-- Alur baru:
--   1. Stokis unit submit hitung fisik  -> status 'pending' (spt sebelumnya,
--      tetap naik ke pusat lewat outbox 'stock_opname').
--   2. Holding review di pusat, isi "qty disetujui" PER ITEM (angka
--      otoritatif holding, bisa mengoreksi hitungan stokis), lalu
--      MENANDATANGANI blob JSON dgn PRIVATE KEY holding (halaman
--      opname-signer.html - offline, client-side, ECDSA P-256).
--   3. Blob dikirim ke unit lewat kanal apa pun (tempel di WA/email, file,
--      Google Drive) - kanal TIDAK perlu dipercaya karena blob
--      self-verifying + sekali pakai (nonce).
--   4. Unit impor blob -> server verifikasi tanda tangan thd
--      OPNAME_APPLY_PUBKEY di .env, cek opname_id/unit_id/nonce/status,
--      lalu tulis delta (dihitung ulang dari stok terkini vs qty_disetujui
--      holding) ke web_stock_movement (reason 'stock_opname'), tandai
--      'applied' dengan OTORITAS = holding.
--
-- Tombol "Terapkan"/"Tolak" lokal di unit dimatikan (flag OPNAME_LOCAL_APPLY,
-- default 'off') - lihat inventory.routes.js.
--
-- Aman dijalankan ulang.
-- =====================================================================

ALTER TABLE web_stock_opname
  ADD COLUMN IF NOT EXISTS approved_by_holding VARCHAR(120) NULL AFTER applied_by_user_id;
ALTER TABLE web_stock_opname
  ADD COLUMN IF NOT EXISTS approval_nonce      VARCHAR(64)  NULL;
ALTER TABLE web_stock_opname
  ADD COLUMN IF NOT EXISTS approval_at         DATETIME     NULL;   -- reviewed_at dari blob holding
ALTER TABLE web_stock_opname
  ADD COLUMN IF NOT EXISTS approval_blob       LONGTEXT     NULL;   -- blob mentah, utk audit

-- qty otoritatif dari holding (bisa != qty_physical stokis).
ALTER TABLE web_stock_opname_item
  ADD COLUMN IF NOT EXISTS approved_qty INT NULL;

-- Anti-replay: nonce blob yang sudah dipakai tidak boleh dipakai lagi.
CREATE TABLE IF NOT EXISTS web_opname_approval_used (
  nonce      VARCHAR(64) PRIMARY KEY,
  opname_id  CHAR(36)    NOT NULL,
  used_by_user_id INT    NULL,
  used_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
