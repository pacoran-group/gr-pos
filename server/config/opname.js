/**
 * Config Stock Opname. Lihat migration 019.
 *
 * **2026-09-14: approval holding DIHAPUS atas keputusan konsolidasi user
 * dengan bagian gudang.** Submit stokis sekarang LANGSUNG diterapkan ke
 * stok (lihat inventory.routes.js POST /opname) - tidak ada lagi status
 * 'pending' menunggu siapa pun. Yang gudang/holding butuh cuma (1) laporan
 * email tiap sesi opname (OPNAME_REPORT_RECIPIENTS di bawah) dan (2)
 * histori sesi + daftar stok minus, yang dua-duanya sudah ada di
 * inventory.html. Infrastruktur approval bertanda-tangan (OPNAME_APPLY_PUBKEY,
 * OPNAME_LOCAL_APPLY, OPNAME_POLL_*, opnameApproval.service.js,
 * opnamePuller.service.js, opname-signer.html) SENGAJA TIDAK DIHAPUS -
 * dibiarkan idle sebagai jalur manual/rollback kalau kebijakan ini berubah
 * lagi nanti, bukan berarti masih dipakai.
 *
 * OPNAME_REPORT_RECIPIENTS : penerima email laporan hasil opname (comma-
 *   separated). Default 'warehouse@pancorangroup.com' kalau kosong di .env.
 *
 * OPNAME_APPLY_PUBKEY : public key ECDSA P-256 milik HOLDING (verifikasi
 *   tanda tangan blob approval). Format: base64 dari SPKI DER, ATAU PEM
 *   utuh (dengan header BEGIN PUBLIC KEY). Boleh berisi >1 kunci dipisah
 *   ';' (rotasi kunci / >1 approver) - blob valid kalau cocok salah satu.
 *   TIDAK berubah oleh OPNAME_POLL_* di bawah - private key sekarang BISA
 *   ada di server n8n pusat (lihat opnamePuller.service.js), tapi tetap
 *   TIDAK PERNAH ada di server unit ini; verifikasi tanda tangan di sini
 *   selalu pakai public key saja, siapa pun sumber blob-nya (upload manual
 *   ATAU hasil poll otomatis).
 *
 * OPNAME_LOCAL_APPLY : 'on' -> tombol "Terapkan"/"Tolak" lokal di unit
 *   (admin/supervisor) MASIH aktif (jalur lama, sebelum 019). 'off'
 *   (default) -> hanya impor blob holding yang bisa menerapkan opname.
 *
 * OPNAME_POLL_* : worker opnamePuller.service.js (mirip outboxSender.
 *   service.js, arah kebalikan) - poll berkala ke n8n
 *   (central-reporting/n8n/05-opname-signer.json) minta blob approval yang
 *   sudah ditandatangani & menunggu unit ini, lalu terapkan otomatis lewat
 *   opnameApproval.service.js applyApprovalBlob() (fungsi sama dgn impor
 *   manual). Default off: jalur manual (upload file) tetap satu-satunya
 *   sampai worker ini dinyalakan eksplisit.
 */
function splitKeys(v) {
  return String(v || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const OPNAME_APPLY_PUBKEYS = splitKeys(process.env.OPNAME_APPLY_PUBKEY);
const OPNAME_LOCAL_APPLY = String(process.env.OPNAME_LOCAL_APPLY || 'off').toLowerCase() === 'on';

const OPNAME_POLL_ENABLED = String(process.env.OPNAME_POLL_ENABLED || 'off').toLowerCase() === 'on';
const OPNAME_POLL_URL = process.env.OPNAME_POLL_URL || '';
const OPNAME_POLL_TOKEN = process.env.OPNAME_POLL_TOKEN || '';
const OPNAME_POLL_INTERVAL_MS = Number(process.env.OPNAME_POLL_INTERVAL_MS) || 120000;

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const OPNAME_REPORT_RECIPIENTS = splitList(process.env.OPNAME_REPORT_RECIPIENTS).length
  ? splitList(process.env.OPNAME_REPORT_RECIPIENTS)
  : ['warehouse@pancorangroup.com'];

function opnameMailConfigured() {
  return Boolean(process.env.SMTP_HOST && OPNAME_REPORT_RECIPIENTS.length);
}

module.exports = {
  OPNAME_APPLY_PUBKEYS,
  OPNAME_LOCAL_APPLY,
  OPNAME_POLL_ENABLED,
  OPNAME_POLL_URL,
  OPNAME_POLL_TOKEN,
  OPNAME_POLL_INTERVAL_MS,
  OPNAME_REPORT_RECIPIENTS,
  opnameMailConfigured,
};
