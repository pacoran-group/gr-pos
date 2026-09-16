/**
 * Cache lokal kolom `m_room.is_active` dari server LAMA (154) - lihat
 * migration 005_legacy_room_state.sql.
 *
 * Kenapa: tiap PC ruangan punya replika MySQL 154 & player.exe polling
 * `m_room.is_active` di sana. Saat peak, 154 berat. gr-pos butuh tahu
 * "menurut 154, room mana yang menyala" untuk (a) mencegah buka-kamar
 * bentrok dgn aplikasi lama (transisi / Plan B), (b) mendeteksi room
 * "orphan" (aktif di 154 tapi gr-pos tak punya transaksinya).
 *
 * Daripada menyalin SELURUH tabel m_room tiap 5 menit (masterSync), worker
 * ini menjalankan SATU query read-only kecil (`SELECT room_id, is_active
 * FROM m_room`) tiap ~15 dtk dan meng-upsert ke web_legacy_room_state.
 * Tanpa DELETE, tanpa write ke 154, nol kontensi dgn booking.
 *
 * buka-kamar memakai check(): kalau cache SEGAR -> pakai itu (nol query ke
 * 154 saat peak); kalau BASI/absen -> pemanggil fallback ke query langsung
 * (roomPlayer.assertRoomAvailableOnLegacy, yang fail-open).
 */
const { pool } = require('../config/db');
const { legacyPool, legacyEnabled } = require('../config/legacyDb');

const POLL_MS = Number(process.env.LEGACY_ROOM_STATE_POLL_MS || 15000);
const STALE_MS = Number(process.env.LEGACY_ROOM_STATE_STALE_MS || 45000);

let polling = false;
let lastPoll = null; // { at, rooms, active, error }

function normActive(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === '1' || s === 'TRUE' ? 1 : 0;
}

/** 1 tick worker: refresh cache dari 154. Read-only ke 154. */
async function pollOnce() {
  if (polling || !legacyEnabled()) return lastPoll;
  polling = true;
  const started = Date.now();
  try {
    const [rows] = await legacyPool.query('SELECT room_id, is_active FROM m_room');
    if (rows.length) {
      const values = [];
      const placeholders = rows
        .map((r) => {
          values.push(Number(r.room_id), normActive(r.is_active));
          return '(?, ?, NOW())';
        })
        .join(',');
      await pool.query(
        `INSERT INTO web_legacy_room_state (room_id, is_active, seen_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), seen_at = VALUES(seen_at)`,
        values
      );
    }
    lastPoll = {
      at: new Date().toISOString(),
      rooms: rows.length,
      active: rows.filter((r) => normActive(r.is_active) === 1).length,
      duration_ms: Date.now() - started,
      error: null,
    };
  } catch (err) {
    lastPoll = { at: new Date().toISOString(), rooms: 0, active: 0, duration_ms: Date.now() - started, error: String(err.message).slice(0, 200) };
    console.warn(`[legacyRoomState] poll gagal (cache dibiarkan basi): ${err.message}`);
  } finally {
    polling = false;
  }
  return lastPoll;
}

/**
 * Status room menurut cache lokal 154.
 * @param {object} conn - koneksi (transaksi booking) atau pool
 * @returns {Promise<{known:boolean, is_active:boolean, seen_at:Date|null, stale:boolean}>}
 *   stale = cache lebih tua dari STALE_MS ATAU tidak ada baris -> pemanggil
 *   sebaiknya fallback ke query langsung ke 154.
 */
async function check(conn, roomId) {
  const q = conn || pool;
  const [rows] = await q.query(
    'SELECT is_active, seen_at FROM web_legacy_room_state WHERE room_id = ?',
    [roomId]
  );
  if (!rows.length) return { known: false, is_active: false, seen_at: null, stale: true };
  const seenAt = new Date(rows[0].seen_at);
  const stale = Date.now() - seenAt.getTime() > STALE_MS;
  return { known: true, is_active: Number(rows[0].is_active) === 1, seen_at: seenAt, stale };
}

/** Semua baris cache (untuk panel dashboard / diagnosa). */
async function getStates() {
  const [rows] = await pool.query(
    'SELECT room_id, is_active, seen_at FROM web_legacy_room_state ORDER BY room_id'
  );
  const now = Date.now();
  return rows.map((r) => ({
    room_id: r.room_id,
    is_active: Number(r.is_active) === 1,
    seen_at: r.seen_at,
    stale: now - new Date(r.seen_at).getTime() > STALE_MS,
  }));
}

/**
 * Room "orphan": menurut cache 154 menyala (is_active=1) TAPI gr-pos tidak
 * punya transaksi aktif non-test untuk room itu. Biasanya = room yang
 * ditangani aplikasi lama (operasi paralel / Plan B saat gr-pos sempat mati)
 * -> perlu rekonsiliasi manual. Hanya baris cache yang tidak basi yang dihitung.
 */
async function getOrphans() {
  const [rows] = await pool.query(
    `SELECT s.room_id, s.seen_at
       FROM web_legacy_room_state s
       LEFT JOIN web_tr_trans t
         ON t.room_id = s.room_id AND t.status = 'active' AND t.is_test = 0
      WHERE s.is_active = 1
        AND t.trans_id IS NULL
        AND s.seen_at >= (NOW() - INTERVAL ? SECOND)
      ORDER BY s.room_id`,
    [Math.ceil(STALE_MS / 1000)]
  );
  return rows.map((r) => ({ room_id: r.room_id, seen_at: r.seen_at }));
}

function getLastPoll() {
  return lastPoll;
}

module.exports = { pollOnce, check, getStates, getOrphans, getLastPoll, POLL_MS, STALE_MS };
