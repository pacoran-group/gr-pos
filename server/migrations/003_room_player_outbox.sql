-- =====================================================================
-- Migration 003 (27 Agustus 2026): Sinkronisasi buka/tutup kamar
-- gr-pos (Server02) -> aplikasi pemutar lagu di dalam room.
--
-- Latar belakang: player di dalam room POLLING tabel `m_room` di server
-- LAMA (10.0.0.154) dan menyala saat `m_room.is_active = '1'` utk room_id
-- itu. gr-pos jalan di Server02 dgn database `bintangnew` TERPISAH, jadi
-- buka/tutup kamar di gr-pos tidak menyentuh m_room yang dibaca player.
--
-- Solusi: transactional outbox. Saat buka-kamar/tutup-kamar/batal (non
-- Mode-Test), gr-pos menuliskan "niat" perintah player ke tabel ini DI
-- DALAM transaksi booking yang sama (atomik). Worker latar
-- (roomPlayer.service.js) lalu mengirim `UPDATE m_room SET is_active=?`
-- ke server 154 dgn retry. Kalau 154/jaringan mati, perintah antre dan
-- terkirim saat pulih.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS). Hanya membuat tabel
-- baru berprefix web_ di database Server02 - tidak menyentuh server 154.
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_room_player_outbox (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  desired_state ENUM('on','off') NOT NULL,
  reason ENUM('buka_kamar','tutup_kamar','batal','manual','reconcile') NOT NULL,
  trans_id VARCHAR(30) NULL,
  status ENUM('pending','sent','failed','superseded') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NULL,
  created_by_user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  INDEX idx_status_id (status, id),
  INDEX idx_room (room_id)
) ENGINE=InnoDB;
