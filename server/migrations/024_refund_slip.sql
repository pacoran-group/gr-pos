-- =====================================================================
-- Migration 024 (30 September 2026): Refund otomatis saat Void / Tukar
-- Item / Batal transaksi yang SUDAH DIBAYAR.
--
-- Latar belakang: model bayar-per-order (migration 017) membuat item sudah
-- lunas sebelum dikonsumsi. Void/batal item yang sudah dibayar dulu cuma
-- mengurangi tagihan - uang yang dikembalikan kasir ke tamu tidak tercatat,
-- jadi "kas seharusnya" di Tutup Kasir tetap menghitung uang itu dan
-- setoran kasir tampak MINUS sebesar refund.
--
-- Sekarang kelebihan bayar dicatat sebagai baris web_tr_trans_payments
-- kind='refund' dengan amount NEGATIF (ENUM 'refund' sudah ada sejak 017),
-- sehingga semua SUM(amount) (shift kasir, paid_total, auto-close EOD)
-- otomatis benar. Migration ini hanya menambah jenis cetakan 'slip_refund'
-- (bukti uang keluar dari laci, ditandatangani tamu).
--
-- Aman dijalankan ulang.
-- =====================================================================

ALTER TABLE web_print_log
  MODIFY COLUMN print_type
    ENUM('slip_gudang','billing_room','tiket_dapur','tiket_bar','tagihan_akhir','slip_retur',
         'tiket_dapur_batal','slip_fnb_hotel','struk_order','slip_refund') NOT NULL;
