-- =====================================================================
-- Migration 015 (9 September 2026): Waktu kamar FLAT + penyesuaian MANUAL
-- + spare 10 menit untuk bayar.
--
-- Perubahan aturan (permintaan user):
--   1. Waktu dasar kamar mode 'threshold' = CREDIT_HOURS_PER_THRESHOLD jam
--      (default 2 jam) FLAT - TIDAK lagi proporsional dgn nilai belanja.
--      Belanja Rp600rb di kamar ber-threshold Rp200rb tetap dapat 2 jam.
--      (Ambang minimal belanja tetap wajib tercapai untuk BUKA kamar.)
--   2. Penambahan / pengurangan waktu 100% MANUAL, granular jam+menit,
--      lewat tombol di layar Detail Kamar. Disimpan sebagai NET menit di
--      kolom baru web_tr_trans.extra_minutes (BOLEH NEGATIF).
--   3. Setiap buka kamar non-test dapat spare PAYMENT_SPARE_MIN menit
--      (default 10) - jeda untuk bayar di kasir & jalan ke ruangan sebelum
--      hitungan mundur "menggigit". Dihitung di allottedMs, tidak disimpan.
--
-- Aman dijalankan ulang (ADD COLUMN IF NOT EXISTS; UPDATE ber-guard).
-- Hanya menyentuh tabel web_.
-- =====================================================================

-- Net penyesuaian waktu manual, dalam MENIT, boleh negatif.
ALTER TABLE web_tr_trans
  ADD COLUMN IF NOT EXISTS extra_minutes INT NOT NULL DEFAULT 0 AFTER extra_hours_used;

-- Bawa nilai lama (jam bulat dari tombol "+1 jam") ke menit, sekali saja.
-- Guard `extra_minutes = 0` -> aman kalau migrasi diulang.
UPDATE web_tr_trans
   SET extra_minutes = ROUND(extra_hours_used * 60)
 WHERE extra_minutes = 0 AND extra_hours_used <> 0;

-- Jejak tiap aksi tambah/kurang waktu: delta menit (negatif = pengurangan).
-- Default 60 = semantik baris lama ("+1 jam").
ALTER TABLE web_tr_trans_extra_hours
  ADD COLUMN IF NOT EXISTS delta_minutes INT NOT NULL DEFAULT 60;
