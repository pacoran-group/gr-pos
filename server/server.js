// override: true - .env milik project ini yang menentukan, bukan variabel
// environment sistem yang mungkin sudah ada untuk aplikasi lain di komputer
// yang sama (mis. DB_USER/DB_HOST milik app lain akan menimpa .env kalau
// override tidak diaktifkan - dotenv default TIDAK menimpa env yang sudah ada).
require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth.routes');
const roomsRoutes = require('./routes/rooms.routes');
const transRoutes = require('./routes/trans.routes');
const printRoutes = require('./routes/print.routes');
const catalogRoutes = require('./routes/catalog.routes');
const productsRoutes = require('./routes/products.routes');
const promoRoutes = require('./routes/promo.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const reportsRoutes = require('./routes/reports.routes');
const hotelFnbRoutes = require('./routes/hotelFnb.routes');
const syncRoutes = require('./routes/sync.routes');
const { errorHandler } = require('./middleware/errorHandler');
const { pool } = require('./config/db');
const { legacyEnabled } = require('./config/legacyDb');
const roomPlayer = require('./services/roomPlayer.service');
const masterSync = require('./services/masterSync.service');
const legacyRoomState = require('./services/legacyRoomState.service');
const eodScheduler = require('./services/eodScheduler');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/trans', transRoutes);
app.use('/api/print-queue', printRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/hotel-fnb', hotelFnbRoutes);
app.use('/api/sync', syncRoutes);

// Frontend statis (login, dashboard, buka kamar, dll)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use(errorHandler);

const PORT = process.env.APP_PORT || 4000;
const timers = []; // handle setInterval supaya bisa dibersihkan saat shutdown

const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] GR POS server START di http://localhost:${PORT} (pid ${process.pid})`);
  console.log('Akses dari komputer lain di LAN yang sama lewat IP komputer server ini, mis. http://192.168.x.x:' + PORT);

  // Worker sinkronisasi player room ke server lama (m_room.is_active di 154).
  if (legacyEnabled()) {
    const intervalMs = Number(process.env.ROOM_PLAYER_SYNC_INTERVAL_MS) || 3000;
    console.log(`Room player sync: ENABLED -> ${process.env.LEGACY_DB_HOST} (tiap ${intervalMs}ms, reconcile tiap 30s)`);
    timers.push(setInterval(roomPlayer.flushOutbox, intervalMs));
    timers.push(setInterval(roomPlayer.reconcileOnce, 30000));

    // Cache read-only status room 154 (SATU query kecil, tanpa write ke 154).
    // Menggantikan kebutuhan menyalin seluruh m_room tiap 5 menit demi occupancy.
    console.log(`Legacy room-state poll: ENABLED (tiap ${Math.round(legacyRoomState.POLL_MS / 1000)}s, stale > ${Math.round(legacyRoomState.STALE_MS / 1000)}s)`);
    setTimeout(legacyRoomState.pollOnce, 3000);
    timers.push(setInterval(legacyRoomState.pollOnce, legacyRoomState.POLL_MS));

    // Sinkron master-data 154 -> Server02.
    //  - startup: SEMUA tabel (FAST + SLOW), dengan fingerprint-skip.
    //  - berkala: HANYA FAST (m_category/m_product/m_member). SLOW (m_room/
    //    m_promo/tax_service) nyaris statis -> cukup startup + tombol manual,
    //    supaya DELETE FROM m_room tidak beradu dgn lock booking tiap 5 menit.
    const masterMs = Number(process.env.MASTER_SYNC_INTERVAL_MS) || 300000; // 5 menit
    console.log(`Master-data sync: ENABLED (FAST tiap ${Math.round(masterMs / 1000)}s; SLOW saat startup + tombol manual)`);
    setTimeout(() => masterSync.syncMasterData({ trigger: 'startup', scope: 'all' }), 10000);
    timers.push(setInterval(() => masterSync.syncMasterData({ trigger: 'schedule', scope: 'fast' }), masterMs));
  } else {
    console.log('Room player sync & Master-data sync: DISABLED (set ROOM_PLAYER_SYNC=on & LEGACY_DB_* di .env)');
  }

  // Scheduler Tutup Hari otomatis (independen dari sync 154).
  eodScheduler.start(timers);
});

// --- Shutdown rapi (dipakai NSSM/Windows Service saat stop/restart) ---
// NSSM mengirim CTRL-C -> SIGTERM -> kill. Kita tutup HTTP server & pool DB
// dulu; kalau macet > 8 dtk, paksa keluar supaya restart tidak menggantung.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] GR POS server STOP (${signal}) - menutup koneksi...`);
  const force = setTimeout(() => {
    console.warn('Shutdown lambat, paksa keluar.');
    process.exit(1);
  }, 8000);
  force.unref();
  timers.forEach(clearInterval);
  server.close(async () => {
    try { await pool.end(); } catch (_) {}
    clearTimeout(force);
    console.log('Bersih. Keluar.');
    process.exit(0);
  });
}
['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach((sig) => process.on(sig, () => shutdown(sig)));
