/**
 * Generate trans_id yang cukup unik untuk dipakai sebagai PRIMARY KEY.
 * Format: TRX-YYYYMMDD-HHMMSS-XXXX (XXXX = random base36).
 * Tidak perlu koordinasi antar-terminal karena PRIMARY KEY di database
 * yang akan menolak duplikat kalau pernah terjadi tabrakan (sangat kecil
 * kemungkinannya).
 */
function generateTransId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TRX-${stamp}-${rand}`;
}

module.exports = { generateTransId };
