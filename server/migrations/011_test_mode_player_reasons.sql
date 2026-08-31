-- ============================================================================
-- Migration 011: reason 'test_open' / 'test_close' di web_room_player_outbox.
-- Grand Royal POS - gr-pos. Tanggal: 31 Agustus 2026.
--
-- Mode Test kini = TES FISIK ROOM: staf (kasir/waiter) buka room untuk cek
-- lagu & mic, dan player di 154 IKUT dinyalakan. Perintah player-nya perlu
-- reason tersendiri supaya bisa dibedakan di audit / stale-guard:
--   test_open  = nyalakan player untuk sesi tes
--   test_close = matikan player (Selesai Tes / auto-expire testMode.service)
--
-- Aman dijalankan ulang: MODIFY COLUMN hanya menetapkan ulang definisi enum.
-- ============================================================================

ALTER TABLE web_room_player_outbox
  MODIFY reason ENUM(
    'buka_kamar','tutup_kamar','batal','manual','reconcile','test_open','test_close'
  ) NOT NULL;
