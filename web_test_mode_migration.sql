-- ============================================================================
-- Migration: Mode Test (buka kamar tanpa billing, tanpa menyentuh m_room.status)
-- Grand Royal POS - gr-pos
-- Tanggal: 27 Agustus 2026
--
-- Latar belakang: selama masa transisi, sebagian kamar karaoke masih benar-
-- benar terisi tamu lewat SISTEM LAMA (komputer server lama). m_room.status
-- adalah kolom yang dibaca BERSAMA oleh sistem lama & sistem baru ini. Supaya
-- admin/supervisor bisa mencoba-coba fitur Buka Kamar/Tambah Order/Tutup
-- Kamar di sistem baru TANPA risiko menimpa status kamar sungguhan, transaksi
-- yang ditandai is_test=1 sengaja TIDAK PERNAH mengubah m_room.status, tidak
-- memvalidasi threshold/pembayaran, dan tidak memicu cetak struk apa pun.
-- Lihat server/routes/trans.routes.js (TEST_MODE_ROLES) & project doc
-- desain-teknis-room-billing.md untuk detail implementasi.
--
-- CATATAN: kalau perintah ALTER di bawah gagal dengan error "Duplicate
-- column name 'is_test'" (kode error 1060), itu berarti migration ini SUDAH
-- pernah dijalankan sebelumnya - aman diabaikan, tidak perlu dijalankan ulang.
-- ============================================================================

ALTER TABLE web_tr_trans
  ADD COLUMN is_test TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
