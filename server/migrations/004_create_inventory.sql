-- =====================================================================
-- Migration 004 (28 Agustus 2026): Modul Inventory / Stok - sub-gudang unit.
--
-- Bagian dari arah besar "POS grup Pancoran": tiap unit (karaoke/hotel/
-- wahana) punya DB POS LOKAL sendiri supaya POS tidak berhenti saat
-- internet ke pusat mati. Data stok & transaksi naik ke sistem PUSAT
-- lewat outbox asinkron (web_sync_outbox), bukan query langsung.
--
-- Migration ini = FASE 1: stok sub-gudang unit ini + ledger mutasi +
-- outbox. Worker pengirim outbox & modul pembelian/transfer pusat
-- menyusul di fase berikutnya (skema di sini sengaja sudah "multi-unit
-- ready" supaya fase pusat bersifat ADITIF, bukan tulis ulang).
--
-- Stok TIDAK disimpan di m_product: server/services/masterSync.service.js
-- meng-DELETE + INSERT ulang m_product dari server 154 tiap 5 menit, jadi
-- kolom apa pun di sana akan hilang. Stok hidup di tabel web_ ini,
-- di-key product_id = CAST(m_product.prod_id AS CHAR) (VARCHAR(25), sama
-- seperti web_tr_trans_details.product_id / web_product_routing.product_id).
-- Tidak ada FOREIGN KEY ke m_product karena tabel itu di-truncate berkala.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS + ALTER idempoten).
-- web_users di-ALTER: itu tabel milik APLIKASI BARU (bukan legacy m_*/tr_*),
-- jadi aman - konsisten dgn aturan "migration web_ tidak menyentuh tabel lama".
-- Tidak menyentuh server 154.
-- =====================================================================

-- Role baru: gudang (staf gudang - boleh kelola stok; TIDAK boleh kasir,
-- otorisasi void, atau Mode Test). Menambah nilai ENUM bersifat idempoten.
ALTER TABLE web_users
  MODIFY COLUMN role ENUM('admin','supervisor','kasir','dapur','waiter','gudang') NOT NULL;

-- Stok on-hand per (sub-gudang, produk). Lokal: warehouse_id konstan (1
-- sub-gudang per unit), tapi tetap di PK supaya skema identik dgn DB
-- konsolidasi pusat (banyak gudang). unit_id didenormalisasi utk filter.
CREATE TABLE IF NOT EXISTS web_product_stock (
  warehouse_id VARCHAR(30) NOT NULL,
  product_id   VARCHAR(25) NOT NULL,
  unit_id      VARCHAR(30) NOT NULL,
  qty_on_hand  INT NOT NULL DEFAULT 0,          -- BOLEH negatif (keputusan: peringatkan tapi selalu izinkan)
  min_stock    INT NOT NULL DEFAULT 5,          -- ambang "stok menipis"
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (warehouse_id, product_id),
  INDEX idx_unit (unit_id)
) ENGINE=InnoDB;

-- Ledger append-only tiap perubahan stok. Sumber kebenaran audit stok
-- (web_tr_trans_history TIDAK diperluas). qty_after = snapshot titik-waktu.
CREATE TABLE IF NOT EXISTS web_stock_movement (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_uid           CHAR(36) NOT NULL,           -- UUID; id stabil utk idempotensi sync lintas sistem
  unit_id             VARCHAR(30) NOT NULL,
  warehouse_id        VARCHAR(30) NOT NULL,
  product_id          VARCHAR(25) NOT NULL,
  delta               INT NOT NULL,                -- bertanda: + masuk, - keluar
  reason              ENUM('opening','adjustment','restock','sale',
                           'void_return','cancel_return',
                           'purchase_receipt','transfer_in','transfer_out') NOT NULL,
  qty_after           INT NOT NULL,                -- snapshot qty_on_hand SETELAH mutasi ini
  unit_cost           DECIMAL(12,2) NULL,          -- snapshot m_product.harga_mdl saat 'sale' (utk COGS)
  ref_trans_id        VARCHAR(30) NULL,            -- web_tr_trans.trans_id sumber (sale/void_return/cancel_return)
  ref_detail_id       INT NULL,                    -- web_tr_trans_details.id terkait (opsional)
  ref_doc_type        VARCHAR(30) NULL,            -- fase pusat: 'transfer' | 'purchase_order'
  ref_doc_id          VARCHAR(40) NULL,
  note                VARCHAR(255) NULL,           -- catatan admin/gudang utk restock/adjustment
  created_by_user_id  INT NULL,                    -- web_users.user_id
  created_at_terminal VARCHAR(50) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event_uid (event_uid),
  INDEX idx_product (warehouse_id, product_id, id),
  INDEX idx_ref_trans (ref_trans_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Transactional outbox: event yang harus naik ke sistem PUSAT. Ditulis
-- dalam 1 DB-transaction bersama business write. Worker pengirim = fase
-- berikutnya; sampai itu ada, baris menumpuk di sini tanpa risiko hilang
-- (idempoten per event_uid saat kelak dikirim). Set SYNC_OUTBOX_ENABLED=off
-- di .env kalau ingin menunda penulisan sama sekali.
CREATE TABLE IF NOT EXISTS web_sync_outbox (
  event_uid    CHAR(36) PRIMARY KEY,
  aggregate    VARCHAR(30) NOT NULL,               -- 'stock_movement' | 'trans_closed' | 'daily_close'
  aggregate_id VARCHAR(64) NOT NULL,
  unit_id      VARCHAR(30) NOT NULL,
  payload      JSON NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at      DATETIME NULL,
  INDEX idx_unsent (sent_at, created_at)
) ENGINE=InnoDB;
