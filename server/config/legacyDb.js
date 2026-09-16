/**
 * Koneksi ke database server LAMA (bintangnew di 10.0.0.154) - HANYA dipakai
 * untuk menyalakan/mematikan aplikasi pemutar lagu di dalam room lewat kolom
 * `m_room.is_active` (player polling kolom itu). Lihat
 * server/services/roomPlayer.service.js & migration 003.
 *
 * SENGAJA terpisah dari config/db.js (pool ke database Server02 milik gr-pos).
 * Kredensial diisi di .env (LEGACY_DB_*). Idealnya user MySQL khusus di 154
 * yang HANYA boleh SELECT/UPDATE kolom is_active di m_room - lihat README.
 */
const mysql = require('mysql2/promise');

// Aktif hanya kalau ROOM_PLAYER_SYNC=on DAN host legacy terisi. Selain itu
// (mis. dev tanpa akses ke 154, atau kill-switch saat insiden) semua operasi
// sinkronisasi jadi no-op dan gr-pos tetap jalan normal untuk pembukuannya.
function legacyEnabled() {
  return String(process.env.ROOM_PLAYER_SYNC || '').toLowerCase() === 'on' && !!process.env.LEGACY_DB_HOST;
}

let legacyPool = null;
if (legacyEnabled()) {
  legacyPool = mysql.createPool({
    host: process.env.LEGACY_DB_HOST,
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER || 'root',
    password: process.env.LEGACY_DB_PASSWORD || '',
    database: process.env.LEGACY_DB_NAME || 'bintangnew',
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 5000,
    decimalNumbers: true,
  });
}

module.exports = { legacyPool, legacyEnabled };
