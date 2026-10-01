/**
 * Config integrasi ERPNext (lihat INTEGRASI-ERPNEXT.md & migration 025).
 * Style sama dgn config/unit.js - const flat dari process.env.
 *
 * ERPNEXT_SENDER_ENABLED : 'on' -> tiap Tutup Hari dikirim sbg Journal Entry
 *   DRAFT. Default off. Walau off, pratinjau payload & cek koneksi di
 *   /api/erpnext tetap bisa dipakai (read-only).
 * ERPNEXT_ACCOUNT_QRIS / _KARTU : akun piutang QRIS / EDC. Kosong ->
 *   penerimaan itu ikut didebit ke ERPNEXT_ACCOUNT_KAS.
 * ERPNEXT_REF_FIELD : fieldname custom field Unique anti-dobel di Journal
 *   Entry (default custom_gr_pos_ref).
 */
const ERPNEXT_URL = String(process.env.ERPNEXT_URL || '').replace(/\/+$/, '');
const ERPNEXT_API_KEY = process.env.ERPNEXT_API_KEY || '';
const ERPNEXT_API_SECRET = process.env.ERPNEXT_API_SECRET || '';
const ERPNEXT_COMPANY = process.env.ERPNEXT_COMPANY || '';
const ERPNEXT_COST_CENTER = process.env.ERPNEXT_COST_CENTER || '';
const ERPNEXT_ACCOUNT_KAS = process.env.ERPNEXT_ACCOUNT_KAS || '';
const ERPNEXT_ACCOUNT_QRIS = process.env.ERPNEXT_ACCOUNT_QRIS || '';
const ERPNEXT_ACCOUNT_KARTU = process.env.ERPNEXT_ACCOUNT_KARTU || '';
const ERPNEXT_ACCOUNT_SELISIH = process.env.ERPNEXT_ACCOUNT_SELISIH || '';
const ERPNEXT_ACCOUNT_PENJUALAN = process.env.ERPNEXT_ACCOUNT_PENJUALAN || '';
const ERPNEXT_ACCOUNT_SC = process.env.ERPNEXT_ACCOUNT_SC || '';
const ERPNEXT_ACCOUNT_PB1 = process.env.ERPNEXT_ACCOUNT_PB1 || '';
// Custom field Unique di Journal Entry utk anti-dobel (INTEGRASI-ERPNEXT.md).
const ERPNEXT_REF_FIELD = process.env.ERPNEXT_REF_FIELD || 'custom_gr_pos_ref';
const ERPNEXT_SENDER_ENABLED = String(process.env.ERPNEXT_SENDER_ENABLED || 'off').toLowerCase() === 'on';
const ERPNEXT_RETRY_INTERVAL_MS = Number(process.env.ERPNEXT_RETRY_INTERVAL_MS) || 5 * 60 * 1000;
const ERPNEXT_TIMEOUT_MS = Number(process.env.ERPNEXT_TIMEOUT_MS) || 20000;

/** Field wajib yang belum diisi (utk pesan error yang jelas). */
function missingConfig() {
  const req = {
    ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET, ERPNEXT_COMPANY, ERPNEXT_COST_CENTER,
    ERPNEXT_ACCOUNT_KAS, ERPNEXT_ACCOUNT_SELISIH, ERPNEXT_ACCOUNT_PENJUALAN, ERPNEXT_ACCOUNT_SC, ERPNEXT_ACCOUNT_PB1,
  };
  return Object.entries(req).filter(([, v]) => !v).map(([k]) => k);
}

module.exports = {
  ERPNEXT_URL,
  ERPNEXT_API_KEY,
  ERPNEXT_API_SECRET,
  ERPNEXT_COMPANY,
  ERPNEXT_COST_CENTER,
  ERPNEXT_ACCOUNT_KAS,
  ERPNEXT_ACCOUNT_QRIS,
  ERPNEXT_ACCOUNT_KARTU,
  ERPNEXT_ACCOUNT_SELISIH,
  ERPNEXT_ACCOUNT_PENJUALAN,
  ERPNEXT_ACCOUNT_SC,
  ERPNEXT_ACCOUNT_PB1,
  ERPNEXT_REF_FIELD,
  ERPNEXT_SENDER_ENABLED,
  ERPNEXT_RETRY_INTERVAL_MS,
  ERPNEXT_TIMEOUT_MS,
  missingConfig,
};
