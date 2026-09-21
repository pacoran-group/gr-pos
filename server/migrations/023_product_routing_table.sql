-- =====================================================================
-- Migration 023 (21 Sep 2026): Buat tabel `web_product_routing` lewat
-- jalur migration resmi.
--
-- LATAR BELAKANG: tabel ini (routing dapur/gudang PER PRODUK, menggantikan
-- `web_category_routing` di migration 001 - lihat catatan di
-- `server/routes/trans.routes.js` fetchItemsWithPrice()) sebelumnya HANYA
-- ada sebagai file lepas `web_product_routing.sql` di root folder proyek
-- (bukan di `server/migrations/`), berisi CREATE TABLE + ~265 baris data
-- produk Grand Royal (dari checklist_routing_produk.xlsx). Karena file itu
-- ada DI LUAR folder migrations, dia TIDAK PERNAH ikut kejalankan oleh
-- instruksi instalasi standar (`for f in server/migrations/0*.sql`) -
-- unit lain yang ikut README apa adanya tidak pernah dapat tabel ini sama
-- sekali (kitchen routing diam-diam selalu fallback ke needs_cooking=1,
-- lihat COALESCE di trans.routes.js - aman tapi bisa salah kirim tiket ke
-- dapur untuk item yang harusnya langsung dari gudang/bar).
--
-- Migration ini HANYA membuat strukturnya (aman & generik untuk semua
-- unit). Data 265 produk Grand Royal TETAP di `web_product_routing.sql`
-- (root folder) - itu murni data spesifik Grand Royal, unit lain isi
-- sendiri lewat UI atau INSERT manual sesuai produk mereka - lihat
-- README bagian 4.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS).
-- =====================================================================

CREATE TABLE IF NOT EXISTS web_product_routing (
  product_id VARCHAR(25) PRIMARY KEY,
  needs_cooking TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
