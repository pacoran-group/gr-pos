-- =====================================================================
-- Migration 016 (9 September 2026): Tagihan model "++" (plus-plus).
--
-- Perubahan aturan (permintaan user):
--   - Harga menu (m_product.harga_jual) = DPP MURNI.
--   - Service Charge 10% DITAMBAH di atas DPP (bukan lagi inklusif).
--   - Pajak Restoran 10% DITAMBAH di atas (DPP + Service Charge).
--     -> label "Pajak Restoran" (PB1), BUKAN PPN.
--   - Item kategori ROKOK bebas Service Charge & Pajak Restoran
--     (rokok punya cukai/pajak sendiri di harga banderol).
--   Contoh 1 item Rp100.000 (non-rokok): DPP 100.000 + SC 10.000
--   + Pajak 11.000 = Grand Total 121.000.
--
-- Kompatibilitas: transaksi LAMA punya billing_mode='inclusive'
-- (default kolom) -> tetap dihitung dgn rumus SC-inklusif lama
-- (bill.js: computeBillInclusive). Transaksi BARU di-stamp
-- billing_mode='plusplus' + resto_tax_pct dari config saat buka kamar.
--
-- Aman dijalankan ulang (ADD COLUMN IF NOT EXISTS; UPDATE ber-guard).
-- =====================================================================

-- Penanda per-transaksi: rumus tagihan mana yang dipakai + snapshot tarif pajak.
ALTER TABLE web_tr_trans
  ADD COLUMN IF NOT EXISTS billing_mode  VARCHAR(12)   NOT NULL DEFAULT 'inclusive' AFTER service_charge_pct;
ALTER TABLE web_tr_trans
  ADD COLUMN IF NOT EXISTS resto_tax_pct DECIMAL(5,2)  NOT NULL DEFAULT 0           AFTER billing_mode;

-- Penanda per-baris item: bebas Service Charge & Pajak Restoran (kategori Rokok).
ALTER TABLE web_tr_trans_details
  ADD COLUMN IF NOT EXISTS sc_tax_exempt TINYINT(1) NOT NULL DEFAULT 0;

-- Backfill baris item lama: rokok = produk yg m_product.category mengandung 'ROKOK'.
UPDATE web_tr_trans_details d
  JOIN m_product p ON CAST(p.prod_id AS CHAR) = d.product_id
   SET d.sc_tax_exempt = 1
 WHERE d.sc_tax_exempt = 0
   AND UPPER(COALESCE(p.category, '')) LIKE '%ROKOK%';
