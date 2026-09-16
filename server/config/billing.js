/**
 * Config model tagihan. Lihat migration 016 & 017.
 *
 * BILLING_MODE:
 *   'inclusive' (default) - harga yang DITAMPILKAN & DITAGIH sudah final.
 *       - RESTO_TAX_PCT = 0  -> harga hanya termasuk Service Charge (perilaku
 *                              3 Sep 2026).
 *       - RESTO_TAX_PCT > 0  -> harga termasuk Service Charge x% + Pajak
 *                              Restoran (PB1) y% (perilaku 9 Sep 2026:
 *                              bayar-per-order, checkout = rekap tanpa bayar).
 *       m_product.harga_jual TETAP = DPP; aplikasi meng-gross-up.
 *   'plusplus'  - harga menu = DPP; SC & Pajak DITAMBAH di struk. (tidak
 *                 dipakai lagi, disimpan utk kompat data lama.)
 *
 * SC% dibaca dari tabel tax_service (kolom tax_service). RESTO_TAX_PCT dari
 * env. Item kategori ROKOK bebas SC & Pajak Restoran.
 */
const BILLING_MODE = ['plusplus', 'inclusive'].includes(String(process.env.BILLING_MODE || '').toLowerCase())
  ? String(process.env.BILLING_MODE).toLowerCase()
  : 'inclusive';

const RESTO_TAX_PCT = Number(process.env.RESTO_TAX_PCT || 0);

const ROKOK_CATEGORY_RE = /rokok/i;

/** true kalau kategori produk ini bebas Service Charge & Pajak Restoran. */
function isScTaxExempt(categoryText) {
  return ROKOK_CATEGORY_RE.test(String(categoryText || ''));
}

/** true kalau harga yang ditagih sudah termasuk SC + Pajak Restoran (dan
 *  karena itu m_product.harga_jual (DPP) perlu di-gross-up saat dijual). */
function priceIncludesTax() {
  return BILLING_MODE === 'inclusive' && RESTO_TAX_PCT > 0;
}

/**
 * Harga jual INKLUSIF dari DPP.
 *   non-rokok : round(dpp * (1 + sc/100) * (1 + tax/100))
 *   rokok     : dpp (tanpa perubahan)
 * @param {number} dpp - m_product.harga_jual
 * @param {boolean} exempt - kategori rokok
 * @param {number} scPct
 * @param {number} taxPct
 */
function grossUpPrice(dpp, exempt, scPct, taxPct) {
  const d = Number(dpp) || 0;
  if (exempt) return Math.round(d);
  return Math.round(d * (1 + (Number(scPct) || 0) / 100) * (1 + (Number(taxPct) || 0) / 100));
}

/**
 * Kupas balik total INKLUSIF (porsi taxable saja) -> { dpp, service_charge, resto_tax }.
 * inclusive = dpp * (1+sc) * (1+tax). tax = inclusive * tax/(100+tax).
 */
function carveInclusive(taxableInclusive, scPct, taxPct) {
  const inc = Math.max(0, Number(taxableInclusive) || 0);
  const tax = taxPct > 0 ? Math.round((inc * taxPct) / (100 + taxPct)) : 0;
  const dppPlusSc = inc - tax;
  const dpp = Math.round((dppPlusSc * 100) / (100 + (Number(scPct) || 0)));
  const service_charge = dppPlusSc - dpp;
  return { dpp, service_charge, resto_tax: tax };
}

module.exports = {
  BILLING_MODE,
  RESTO_TAX_PCT,
  ROKOK_CATEGORY_RE,
  isScTaxExempt,
  priceIncludesTax,
  grossUpPrice,
  carveInclusive,
};
