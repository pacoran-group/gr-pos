-- =====================================================================
-- Migration 005 (28 Agustus 2026): Cache status room dari server LAMA (154)
-- + state fingerprint untuk sinkron master-data yang lebih hemat.
--
-- Latar belakang: tiap PC ruangan punya MySQL REPLIKA dari 154 (supaya
-- player.exe bisa telusur/putar lagu tanpa membebani 154). Saat peak, 154
-- berat menangani playback + transaksi + sinkron dapur sekaligus - itu
-- alasan gr-pos dibuat (memindahkan transaksi & order dapur keluar dari 154).
--
-- Dua perbaikan di migration ini:
--  1. web_legacy_room_state: cache lokal kolom m_room.is_active di 154,
--     di-refresh worker read-only tiap ~15 dtk (SATU query kecil, tanpa
--     DELETE/write ke 154). buka-kamar cek cache lokal ini dulu; query
--     langsung ke 154 hanya kalau cache basi/absen. Menggantikan kebutuhan
--     menyalin SELURUH tabel m_room tiap 5 menit hanya demi occupancy.
--  2. web_master_sync_state: simpan "sidik jari" tiap tabel master hasil
--     sinkron terakhir, supaya siklus "tidak ada perubahan" (kasus umum)
--     bisa dilewati tanpa transfer baris / DELETE+INSERT.
--
-- Aman dijalankan ulang. Hanya tabel web_ baru. Tidak menyentuh 154.
-- =====================================================================

-- Cache lokal m_room.is_active di 154. Di-refresh oleh
-- server/services/legacyRoomState.service.js.
CREATE TABLE IF NOT EXISTS web_legacy_room_state (
  room_id   INT NOT NULL PRIMARY KEY,
  is_active TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = room menyala menurut 154 (replika master)
  seen_at   DATETIME NOT NULL,               -- kapan terakhir kali baris ini di-refresh dari 154
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Sidik jari tabel master hasil sinkron terakhir (COUNT + hash isi).
-- Kalau sidik jari 154 sama dgn yang tersimpan di sini, tabel dilewati.
CREATE TABLE IF NOT EXISTS web_master_sync_state (
  table_name   VARCHAR(64) NOT NULL PRIMARY KEY,
  fingerprint  VARCHAR(80) NOT NULL,          -- "<row_count>:<bit_xor(crc32(...))>"
  row_count    INT NOT NULL DEFAULT 0,
  synced_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
