-- =====================================================================
-- Migration 014 (8 September 2026): Stock Opname dua-tahap (submit -> apply).
--
-- Revisi presentasi dari SPV Gudang: stokis unit (role 'gudang') CUMA
-- boleh (1) input barang masuk, (2) lihat riwayat mutasi (sudah ada sejak
-- migration 004), (3) submit hasil hitung fisik saat tutup toko. Stokis
-- TIDAK berhak lagi mengeksekusi penyesuaian stok sendiri (endpoint lama
-- POST /:productId/adjust sekarang dikunci admin/supervisor saja - lihat
-- inventory.routes.js). Yang berhak "menyesuaikan" = holding.
--
-- Karena sync pusat (central-reporting/) SATU ARAH (unit -> pusat lewat
-- web_sync_outbox, belum ada jalur balik pusat -> unit), keputusan
-- approval holding TIDAK bisa otomatis menulis balik ke DB unit ini.
-- Alurnya jadi 2 tahap manual-dijembatani:
--   1. Stokis submit hitung fisik -> baris PENDING di sini, qty_on_hand
--      TIDAK berubah dulu, dan (kalau SYNC_OUTBOX_ENABLED) langsung naik
--      ke pusat sbg aggregate 'stock_opname' supaya holding bisa review
--      dari dashboard pusat SEBELUM dieksekusi.
--   2. Holding review lalu (via telepon/chat, di luar sistem ini) minta
--      admin/supervisor UNIT menekan "Terapkan" - baru saat itu delta
--      benar2 ditulis ke web_product_stock + web_stock_movement (reason
--      'stock_opname', bukan 'adjustment' lama) lewat stock.service.js
--      applyOpnameItem, dan ikut naik ke pusat sbg 'stock_movement' biasa
--      (jalur yang sudah ada, tidak perlu diubah).
--
-- delta dihitung ULANG dari qty_on_hand SAAT APPLY (bukan dari snapshot
-- submit) - stok bisa bergerak (restock/penjualan) di antara submit dan
-- apply. Snapshot submit disimpan hanya utk histori/pembanding.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS). Hanya tabel web_.
-- =====================================================================

ALTER TABLE web_stock_movement
  MODIFY COLUMN reason ENUM('opening','adjustment','restock','sale',
                            'void_return','cancel_return',
                            'purchase_receipt','transfer_in','transfer_out',
                            'stock_opname') NOT NULL;

CREATE TABLE IF NOT EXISTS web_stock_opname (
  opname_id          CHAR(36) PRIMARY KEY,           -- UUID
  unit_id             VARCHAR(30) NOT NULL,
  warehouse_id        VARCHAR(30) NOT NULL,
  status              ENUM('pending','applied','rejected') NOT NULL DEFAULT 'pending',
  item_count          INT NOT NULL DEFAULT 0,
  note                VARCHAR(500) NULL,
  created_by_user_id  INT NOT NULL,                  -- stokis yang submit
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by_user_id  INT NULL,                      -- admin/supervisor yang eksekusi
  applied_at          DATETIME NULL,
  reject_note         VARCHAR(500) NULL,
  INDEX idx_status (status, created_at)
) ENGINE=InnoDB;

-- 1 baris = 1 produk yang dihitung dalam sesi opname ini.
--   qty_system_snapshot = qty_on_hand SAAT SUBMIT (histori/pembanding saja)
--   qty_physical         = hasil hitung fisik stokis
--   delta_snapshot        = qty_physical - qty_system_snapshot (dihitung saat submit)
--   applied_delta         = delta SEBENARNYA yang ditulis ke web_stock_movement
--                           saat apply (qty_physical - qty_on_hand SAAT APPLY);
--                           NULL selama status sesi masih 'pending'/'rejected'.
CREATE TABLE IF NOT EXISTS web_stock_opname_item (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  opname_id             CHAR(36) NOT NULL,
  product_id            VARCHAR(25) NOT NULL,
  qty_system_snapshot   INT NOT NULL,
  qty_physical          INT NOT NULL,
  delta_snapshot        INT NOT NULL,
  applied_delta         INT NULL,
  note                  VARCHAR(255) NULL,
  INDEX idx_opname (opname_id)
) ENGINE=InnoDB;
