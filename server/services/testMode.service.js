/**
 * Worker auto-expire sesi MODE TEST (tes fisik room).
 *
 * Mode Test = staf (kasir/waiter) buka room untuk cek lagu & mic secara
 * fisik sebelum tamu datang. Saat mulai, player room di 154 dinyalakan.
 * Kalau staf lupa menekan "Selesai Tes", worker ini menutup sesi & antre
 * perintah MATIKAN player setelah TEST_MODE_MINUTES sejak start_time.
 *
 * Dipanggil berkala dari server.js (tiap 60 dtk). Aman jalan walau
 * ROOM_PLAYER_SYNC off - enqueue hanya menulis outbox lokal; flushOutbox
 * yang no-op kalau legacy tidak dikonfigurasi.
 */
const { withTransaction } = require('../config/db');
const roomPlayer = require('./roomPlayer.service');
const { TEST_MODE_MINUTES } = require('./threshold.service');

let running = false;

/** 1 tick: tutup semua sesi test yang sudah lewat TEST_MODE_MINUTES. */
async function expireStale() {
  if (running) return;
  running = true;
  try {
    await withTransaction(async (conn) => {
      const [stale] = await conn.query(
        `SELECT trans_id, room_id FROM web_tr_trans
          WHERE status = 'active' AND is_test = 1
            AND start_time < (NOW() - INTERVAL ? MINUTE)
          FOR UPDATE`,
        [TEST_MODE_MINUTES]
      );
      for (const t of stale) {
        await conn.query(
          "UPDATE web_tr_trans SET status = 'closed', end_time = NOW() WHERE trans_id = ?",
          [t.trans_id]
        );
        await roomPlayer.enqueue(conn, {
          roomId: t.room_id, desiredState: 'off', reason: 'test_close',
          transId: t.trans_id, userId: null,
        });
        // user_id 0 = sentinel "system" (kolom NOT NULL, tanpa FK).
        await conn.query(
          `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
           VALUES (?, 'tutup_kamar', 0, 'system', ?)`,
          [t.trans_id, JSON.stringify({ is_test: true, auto_expired: true, after_minutes: TEST_MODE_MINUTES })]
        );
        console.log(`[testMode] sesi tes ${t.trans_id} (room ${t.room_id}) auto-selesai setelah ${TEST_MODE_MINUTES} mnt - player dimatikan.`);
      }
    });
  } catch (err) {
    console.error('[testMode] expireStale error:', err.message);
  } finally {
    running = false;
  }
}

module.exports = { expireStale };
