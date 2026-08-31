/**
 * Sinkron master-data dari server LAMA (154) -> database gr-pos (Server02).
 * Hanya tabel master yang dipakai POS baru.
 *
 * Strategi per tabel: DELETE semua + INSERT ulang dari 154, di dalam 1
 * transaksi (gagal -> rollback, tabel tidak jadi kosong). Kegagalan 1 tabel
 * tidak menghentikan tabel lain.
 *
 * DUA OPTIMASI (28 Agustus 2026) - karena 154 berat saat peak (playback +
 * transaksi + sinkron dapur) dan gr-pos dibuat justru untuk mengurangi beban itu:
 *
 *  1. CADENCE TERPISAH. Tabel yang nyaris tak pernah berubah (m_room, m_promo,
 *     tax_service) HANYA disinkron saat startup + tombol manual, TIDAK tiap
 *     5 menit. `DELETE FROM m_room` tiap 5 menit beradu dengan
 *     `SELECT ... FOR UPDATE` di buka-kamar (mutex booking) -> bisa jadi 409
 *     palsu, tanpa manfaat. Occupancy 154 kini dilacak worker read-only
 *     terpisah (legacyRoomState.service.js), bukan lewat salinan m_room ini.
 *
 *  2. FINGERPRINT SKIP. Sebelum DELETE+INSERT, hitung sidik jari murah
 *     (COUNT + BIT_XOR(CRC32(...))) di 154. Kalau sama dgn sinkron terakhir
 *     (web_master_sync_state), tabel DILEWATI - nol transfer baris, nol
 *     DELETE+INSERT. Siklus "tidak ada perubahan" (kasus umum) jadi hanya 1
 *     query agregat kecil per tabel.
 */
const { pool } = require('../config/db');
const { legacyPool, legacyEnabled } = require('../config/legacyDb');

// FAST: dulu m_category/m_product/m_member disinkron tiap interval. Sejak
// 29 Agu 2026 (keputusan user "cutover bertahap"): gr-pos MEMILIKI m_product
// (kelola lewat halaman Manajemen Produk) & tidak memakai member. m_category
// mengikuti m_product (dipakai hanya sebagai lookup). Jadi FAST kosong -
// tabel-tabel itu TIDAK lagi ditimpa dari 154.
// SLOW: m_room/m_promo/tax_service masih ditarik dari 154 saat startup +
// tombol manual (daftar kamar, harga threshold, %service charge bisa berubah).
const FAST_TABLES = [];
const SLOW_TABLES = ['m_room', 'm_promo', 'tax_service'];
const SYNC_TABLES = [...FAST_TABLES, ...SLOW_TABLES]; // kompat: dipakai halaman Setelan
const CHUNK = 200;

let syncing = false;
let lastResult = null;

/**
 * Sidik jari isi tabel di 154: "<count>:<bit_xor(crc32(concat semua kolom))>".
 * Kolom diambil dinamis dari information_schema supaya tahan skema yang
 * belum terverifikasi. NULL dibedakan dari '' via sentinel 0x00.
 */
async function legacyFingerprint(table) {
  const [cols] = await legacyPool.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  if (!cols.length) throw new Error(`tabel ${table} tidak punya kolom / tidak ada di 154`);
  const concat = cols
    .map((c) => `COALESCE(CAST(\`${c.name}\` AS CHAR), 0x00)`)
    .join(', ');
  const [rows] = await legacyPool.query(
    `SELECT COUNT(*) AS c,
            COALESCE(BIT_XOR(CRC32(CONCAT_WS(0x1f, ${concat}))), 0) AS h
       FROM \`${table}\``
  );
  return { fingerprint: `${rows[0].c}:${rows[0].h}`, rowCount: Number(rows[0].c) };
}

async function getStoredFingerprint(table) {
  const [rows] = await pool.query(
    'SELECT fingerprint FROM web_master_sync_state WHERE table_name = ?',
    [table]
  );
  return rows.length ? rows[0].fingerprint : null;
}

async function storeFingerprint(table, fingerprint, rowCount) {
  await pool.query(
    `INSERT INTO web_master_sync_state (table_name, fingerprint, row_count)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), row_count = VALUES(row_count), synced_at = NOW()`,
    [table, fingerprint, rowCount]
  );
}

/** DELETE + INSERT ulang 1 tabel dari 154 (dalam 1 transaksi lokal). */
async function copyTable(table) {
  const [rows] = await legacyPool.query(`SELECT * FROM \`${table}\``);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Hanya salin kolom yang ADA DI KEDUA sisi (irisan source ∩ destination).
    // Pelindung schema drift: kalau 154 menambah kolom baru yang belum ada di
    // salinan lokal (mis. m_product.ppn), kolom itu DIABAIKAN + diperingatkan,
    // bukan menggagalkan seluruh tabel dengan "Unknown column ...".
    const [destColRows] = await conn.query(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    const destSet = new Set(destColRows.map((c) => c.name));
    const srcCols = rows.length ? Object.keys(rows[0]) : [];
    const colsList = srcCols.filter((c) => destSet.has(c)); // urutan mengikuti source
    const dropped = srcCols.filter((c) => !destSet.has(c));
    if (dropped.length) {
      console.warn(
        `[masterSync] ${table}: kolom 154 diabaikan (belum ada di salinan lokal): ${dropped.join(', ')}`
      );
    }
    if (rows.length && !colsList.length) {
      throw new Error(`tidak ada kolom yang cocok antara 154 dan lokal untuk ${table}`);
    }

    await conn.query(`DELETE FROM \`${table}\``);
    if (rows.length) {
      const colList = colsList.map((c) => `\`${c}\``).join(',');
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const placeholders = slice.map(() => `(${colsList.map(() => '?').join(',')})`).join(',');
        const values = [];
        for (const r of slice) for (const c of colsList) values.push(r[c]);
        await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`, values);
      }
    }
    await conn.commit();
    return rows.length;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Sinkron 1 tabel dgn fingerprint-skip.
 * @returns {Promise<{table:string, skipped?:boolean, rows?:number}>}
 */
async function syncOneTable(table) {
  const { fingerprint, rowCount } = await legacyFingerprint(table);
  const stored = await getStoredFingerprint(table);
  if (stored && stored === fingerprint) {
    return { table, skipped: true, rows: rowCount };
  }
  const rows = await copyTable(table);
  await storeFingerprint(table, fingerprint, rows);
  return { table, rows };
}

/**
 * Jalankan sinkron master-data.
 * @param {object} opts
 * @param {'schedule'|'manual'|'startup'} [opts.trigger]
 * @param {'all'|'fast'|'slow'} [opts.scope] - 'fast' = hanya FAST_TABLES
 *   (dipakai interval berkala); 'all'/'slow' termasuk SLOW_TABLES
 *   (startup / manual).
 */
async function syncMasterData({ trigger = 'schedule', scope = 'all' } = {}) {
  if (!legacyEnabled()) return { skipped: true, reason: 'ROOM_PLAYER_SYNC/LEGACY_DB belum dikonfigurasi.' };
  if (syncing) return { skipped: true, reason: 'Sinkron lain sedang berjalan.' };
  syncing = true;
  const started = Date.now();

  const tables =
    scope === 'fast' ? FAST_TABLES : scope === 'slow' ? SLOW_TABLES : SYNC_TABLES;

  const out = { trigger, scope, tables: {}, skipped_tables: [], errors: {} };
  try {
    for (const t of tables) {
      try {
        const r = await syncOneTable(t);
        if (r.skipped) out.skipped_tables.push(t);
        else out.tables[t] = r.rows;
      } catch (err) {
        out.errors[t] = String(err.message).slice(0, 300);
        console.error(`[masterSync] gagal tabel ${t}: ${err.message}`);
      }
    }
  } finally {
    syncing = false;
  }
  out.duration_ms = Date.now() - started;
  out.ok = Object.keys(out.errors).length === 0;
  out.at = new Date().toISOString();
  lastResult = out;
  const changed = Object.keys(out.tables).length ? JSON.stringify(out.tables) : '{}';
  console.log(
    `[masterSync] ${trigger}/${scope}: changed=${changed} skipped=[${out.skipped_tables.join(',')}] ${out.duration_ms}ms` +
      (out.ok ? '' : ` — ERROR: ${JSON.stringify(out.errors)}`)
  );
  return out;
}

function getLastResult() {
  return lastResult;
}

module.exports = { syncMasterData, getLastResult, SYNC_TABLES, FAST_TABLES, SLOW_TABLES };
