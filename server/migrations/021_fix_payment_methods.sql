-- =====================================================================
-- Migration 021 (15 September 2026): Perbaikan bug "QRIS & Kartu tidak
-- bisa dipakai" saat Buka Kamar.
--
-- Root cause: web_tr_trans.initial_payment_method didefinisikan sejak
-- migration 001 sbg ENUM('cash','debit','credit') - TIDAK PERNAH diupdate
-- saat frontend (orders.html tombol Buka Kamar) diganti ke opsi
-- cash/qris/card. sql_mode server ini STRICT_TRANS_TABLES, jadi INSERT
-- dengan initial_payment_method='qris' atau 'card' GAGAL dgn error
-- ("Data truncated for column..."), bukan cuma silently salah - kasir
-- tidak bisa buka kamar sama sekali kalau pilih QRIS/Kartu.
--
-- final_payment_method (kolom terpisah, dipakai saat tutup kamar) SUDAH
-- benar ENUM('cash','qris','card') sejak awal - makanya bug ini cuma
-- kena di pembukaan kamar, bukan penutupan.
--
-- Fix: lebarkan ENUM ke cash/qris/card, TETAP simpan debit/credit lama
-- (jangan dibuang - ada data historis: 20 baris 'debit', 9 baris 'credit'
-- per pengecekan 2026-09-15) supaya tidak ada baris lama yang datanya
-- rusak/ke-truncate saat ALTER.
--
-- Aman dijalankan ulang.
-- =====================================================================

ALTER TABLE web_tr_trans
  MODIFY COLUMN initial_payment_method
    ENUM('cash','qris','card','debit','credit') NOT NULL DEFAULT 'cash';
