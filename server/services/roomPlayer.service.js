/**
 * Sinkronisasi status "room menyala" dari gr-pos (Server02) ke aplikasi
 * pemutar lagu di dalam room, yang polling `m_room.is_active` di server LAMA
 * (10.0.0.154). Lihat migration 003_room_player_outbox.sql untuk latar
 * belakang lengkap.
 *
 * Pola: transactional outbox.
 *  - enqueue(): tulis "niat" perintah ke web_room_player_outbox DI DALAM
 *    transaksi booking (buka/tutup/batal) -> atomik dgn booking.
 *  - flushOutbox(): worker latar, kirim perintah pending ke 154 dgn retry.
 *  - reconcileOnce(): jaring pengaman - pastikan room yg PUNYA transaksi
 *    aktif non-test di gr-pos memang is_active='1' di 154. TIDAK PERNAH
 *    mematikan room (room tak dikenal mungkin milik sistem lama).
 *  - assertRoomAvailableOnLegacy(): tolak buka room yg sudah is_active='1'
 *    di 154 (dipegang sistem lama).
 */
const { pool } = require('../config/db');
const { legacyPool, legacyEnabled } = require('../config/legacyDb');
const { AppError } = require('../middleware/errorHandler');

const MAX_ATTEMPTS = 15;
const STALE_MINUTES = Number(process.env.ROOM_PLAYER_STALE_MINUTES || 10);

// Arah OFF pada reconcile (matikan room di 154 yang gr-pos yakin sudah tutup).
// DEFAULT OFF. Hanya aman dinyalakan kalau gr-pos SATU-SATUNYA pengendali
// room. Saat operasi paralel dgn aplikasi lama / Plan B, biarkan off supaya
// gr-pos tidak mematikan room yang dibuka aplikasi lama.
const RECONCILE_OFF = String(process.env.LEGACY_RECONCILE_OFF || 'off').toLowerCase() === 'on';

/**
 * Catat perintah player ke outbox. `conn` = koneksi transaksi booking
 * (dari withTransaction) supaya atomik; boleh juga `pool` untuk perintah
 * di luar transaksi (reconcile / manual).
 * Perintah pending LAMA untuk room yang sama ditandai 'superseded' dulu,
 * supaya urutan open->close yang cepat tidak mengirim "on" basi setelah "off".
 */
async function enqueue(conn, { roomId, desiredState, reason, transId = null, userId = null }) {
  await conn.query(
    "UPDATE web_room_player_outbox SET status = 'superseded' WHERE room_id = ? AND status = 'pending'",
    [roomId]
  );
  await conn.query(
    `INSERT INTO web_room_player_outbox (room_id, desired_state, reason, trans_id, created_by_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    [roomId, desiredState, reason, transId, userId]
  );
}

/**
 * Tolak buka room yang sudah AKTIF di sistem lama (154) - guard best-effort
 * terhadap dua sistem memperebutkan room yang sama.
 *
 * PENTING: fail-open. Kalau server 154 tidak bisa dihubungi, JANGAN gagalkan
 * booking - biarkan lanjut; perintah "on" tetap masuk outbox dan terkirim
 * saat 154 pulih. Guard ini tidak boleh jadi titik kegagalan tunggal.
 */
async function assertRoomAvailableOnLegacy(roomId) {
  if (!legacyEnabled()) return;
  let rows;
  try {
    [rows] = await legacyPool.query('SELECT is_active FROM m_room WHERE room_id = ?', [roomId]);
  } catch (err) {
    console.warn(`[roomPlayer] tidak bisa cek status room ${roomId} di server lama (lanjut tanpa guard): ${err.message}`);
    return;
  }
  if (rows.length && String(rows[0].is_active) === '1') {
    throw new AppError(
      409,
      `Kamar ${roomId} sedang AKTIF di sistem lama. Tutup dulu di sistem lama sebelum dibuka dari POS baru.`
    );
  }
}

/** Terapkan 1 perintah ke m_room di 154. Bersyarat: kalau sudah di state
 * target, tidak menulis (kurangi beban write ke 154). Return affectedRows. */
async function applyToLegacy(roomId, desiredState) {
  const target = desiredState === 'on' ? '1' : '0';
  const [res] = await legacyPool.query(
    'UPDATE m_room SET is_active = ?, last_update = NOW() WHERE room_id = ? AND is_active <> ?',
    [target, roomId, target]
  );
  return res.affectedRows;
}

let flushing = false;
/** 1 tick worker: kirim perintah pending ke 154. */
async function flushOutbox() {
  if (flushing || !legacyEnabled()) return;
  flushing = true;
  try {
    const [rows] = await pool.query(
      "SELECT * FROM web_room_player_outbox WHERE status = 'pending' ORDER BY id LIMIT 20"
    );
    for (const row of rows) {
      // Stale guard: perintah "on" yang sudah lama - re-validasi masih perlu?
      if (row.desired_state === 'on' && ['buka_kamar', 'reconcile'].includes(row.reason)) {
        const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
        if (ageMin > STALE_MINUTES) {
          const [act] = await pool.query(
            "SELECT 1 FROM web_tr_trans WHERE room_id = ? AND status = 'active' AND is_test = 0 LIMIT 1",
            [row.room_id]
          );
          if (!act.length) {
            await pool.query("UPDATE web_room_player_outbox SET status = 'superseded' WHERE id = ?", [row.id]);
            continue;
          }
        }
      }
      try {
        await applyToLegacy(row.room_id, row.desired_state);
        await pool.query(
          "UPDATE web_room_player_outbox SET status = 'sent', sent_at = NOW() WHERE id = ?",
          [row.id]
        );
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await pool.query(
          'UPDATE web_room_player_outbox SET attempts = ?, last_error = ?, status = ? WHERE id = ?',
          [attempts, String(err.message).slice(0, 255), failed ? 'failed' : 'pending', row.id]
        );
        if (failed) {
          console.error(
            `[roomPlayer] GAGAL PERMANEN kirim perintah player room ${row.room_id} -> ${row.desired_state} (outbox id ${row.id}): ${err.message}`
          );
        }
      }
    }
  } catch (err) {
    console.error('[roomPlayer] flushOutbox error:', err.message);
  } finally {
    flushing = false;
  }
}

let reconciling = false;
/**
 * Jaring pengaman dua arah:
 *  - ON  : room dgn transaksi aktif non-test di gr-pos HARUS on di 154.
 *  - OFF : (opt-in LEGACY_RECONCILE_OFF=on) room yang gr-pos yakin sudah
 *          ditutup tapi masih on di 154. TIDAK PERNAH mematikan room yang
 *          gr-pos tak kenal (mungkin milik aplikasi lama / Plan B).
 */
async function reconcileOnce() {
  if (reconciling || !legacyEnabled()) return;
  reconciling = true;
  try {
    // --- Arah ON ---
    const [active] = await pool.query(
      "SELECT DISTINCT room_id FROM web_tr_trans WHERE status = 'active' AND is_test = 0"
    );
    for (const { room_id } of active) {
      const [leg] = await legacyPool.query('SELECT is_active FROM m_room WHERE room_id = ?', [room_id]);
      if (!leg.length || String(leg[0].is_active) === '1') continue; // sudah on -> aman
      const [pend] = await pool.query(
        "SELECT 1 FROM web_room_player_outbox WHERE room_id = ? AND status = 'pending' LIMIT 1",
        [room_id]
      );
      if (pend.length) continue; // sudah ada perintah antre
      await enqueue(pool, { roomId: room_id, desiredState: 'on', reason: 'reconcile' });
    }

    // --- Arah OFF (opt-in) ---
    if (RECONCILE_OFF) {
      const [stray] = await legacyPool.query("SELECT room_id FROM m_room WHERE is_active = '1'");
      for (const { room_id } of stray) {
        const [act] = await pool.query(
          "SELECT 1 FROM web_tr_trans WHERE room_id = ? AND status = 'active' AND is_test = 0 LIMIT 1",
          [room_id]
        );
        if (act.length) continue; // masih aktif di gr-pos - jangan sentuh
        // gr-pos harus PERNAH menutup room ini (trans terakhir closed/cancelled).
        // Kalau gr-pos tak punya riwayat room ini -> kemungkinan milik aplikasi
        // lama, JANGAN matikan.
        const [last] = await pool.query(
          `SELECT status FROM web_tr_trans WHERE room_id = ?
            ORDER BY COALESCE(end_time, created_at) DESC, created_at DESC LIMIT 1`,
          [room_id]
        );
        if (!last.length || !['closed', 'cancelled'].includes(last[0].status)) continue;
        const [pend] = await pool.query(
          "SELECT 1 FROM web_room_player_outbox WHERE room_id = ? AND status = 'pending' LIMIT 1",
          [room_id]
        );
        if (pend.length) continue;
        await enqueue(pool, { roomId: room_id, desiredState: 'off', reason: 'reconcile' });
      }
    }
  } catch (err) {
    console.error('[roomPlayer] reconcileOnce error:', err.message);
  } finally {
    reconciling = false;
  }
}

module.exports = { enqueue, assertRoomAvailableOnLegacy, flushOutbox, reconcileOnce };
