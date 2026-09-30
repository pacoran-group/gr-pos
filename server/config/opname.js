/**
 * Config Stock Opname.
 *
 * Sejak 2026-09-14 submit stokis LANGSUNG diterapkan ke stok (lihat
 * inventory.routes.js POST /opname, migration 020) dan laporannya diemail ke
 * gudang. Sesi lama yang masih 'pending' (dari masa approval) bisa
 * diterapkan / ditolak admin/supervisor dari detail sesi di inventory.html.
 *
 * OPNAME_REPORT_RECIPIENTS : penerima email laporan hasil opname (comma-
 *   separated). Default 'warehouse@pancorangroup.com' kalau kosong di .env.
 */
const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const OPNAME_REPORT_RECIPIENTS = splitList(process.env.OPNAME_REPORT_RECIPIENTS).length
  ? splitList(process.env.OPNAME_REPORT_RECIPIENTS)
  : ['warehouse@pancorangroup.com'];

function opnameMailConfigured() {
  return Boolean(process.env.SMTP_HOST && OPNAME_REPORT_RECIPIENTS.length);
}

module.exports = {
  OPNAME_REPORT_RECIPIENTS,
  opnameMailConfigured,
};
