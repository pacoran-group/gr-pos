/**
 * Preflight check - dijalankan SEKALI setelah migration & sebelum
 * `npm start` di instalasi baru (juga aman dijalankan ulang kapan saja
 * untuk diagnosa). Tujuannya: ubah kegagalan yang biasanya "diam-diam"
 * (dashboard kosong, HTTP 200 tapi tidak ada data, error SQL mentah yang
 * tidak jelas buat non-developer) menjadi pesan Bahasa Indonesia yang
 * jelas, SEBELUM staf mulai pakai sistemnya.
 *
 * Lihat README bagian "1. Persiapan server" & "3. Migration database"
 * untuk konteks Jalur A (unit dengan sistem lama) vs Jalur B (unit baru).
 *
 * Cara pakai:
 *   node server/utils/preflightCheck.js
 *   npm run preflight
 *
 * Exit code 0 = aman dilanjutkan. Exit code 1 = ada masalah FATAL (jangan
 * lanjut ke `npm start` sebelum ini dibereskan).
 */
require('dotenv').config({ override: true });
const { pool } = require('../config/db');

const FATAL = [];
const WARN = [];
const OK = [];

function fatal(msg) { FATAL.push(msg); }
function warn(msg) { WARN.push(msg); }
function ok(msg) { OK.push(msg); }

async function tableExists(dbName, table) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = ?`,
    [dbName, table]
  );
  return rows[0].n > 0;
}

async function columnExists(dbName, table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [dbName, table, column]
  );
  return rows[0].n > 0;
}

async function rowCount(table) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return rows[0].n;
}

// Tabel web_* representatif dari tiap era migration - kalau salah satu
// hilang, kemungkinan besar loop migration berhenti di tengah jalan atau
// file di-skip (mis. saat dijalankan manual satu-satu).
const WEB_TABLES_CHECKLIST = [
  { table: 'web_users', migration: '001', note: 'login TIDAK akan bisa dibuat/berfungsi tanpa ini' },
  { table: 'web_tr_trans', migration: '001', note: 'transaksi/buka kamar' },
  { table: 'web_room_player_outbox', migration: '003', note: 'sinkron player room (kalau ROOM_PLAYER_SYNC=on)' },
  { table: 'web_product_stock', migration: '004', note: 'modul Inventory' },
  { table: 'web_legacy_room_state', migration: '005', note: 'cache status room dari server lama' },
  { table: 'web_fnb_hotel_order', migration: '007', note: 'modul F&B Hotel' },
  { table: 'web_promo', migration: '009', note: 'modul Promo' },
  { table: 'web_tr_trans_payments', migration: '017', note: 'pay-per-order' },
  { table: 'web_product_routing', migration: '023', note: 'routing dapur/gudang per produk (dulu file lepas, sekarang migration resmi)' },
];

// Tabel master "warisan" (bukan dibuat oleh migration gr-pos) yang dibaca
// aplikasi. Kalau ini kosong/tidak ada, dashboard & katalog akan kosong
// walau login berhasil - lihat README bagian 1 (Jalur A / Jalur B).
const MASTER_TABLES_CHECKLIST = [
  { table: 'm_room', note: 'daftar kamar (grid Dashboard)' },
  { table: 'm_product', note: 'katalog produk F&B' },
  { table: 'm_promo', note: 'tarif kamar per tipe/threshold' },
  { table: 'tax_service', note: '% service charge' },
  { table: 'm_member', note: 'data member (opsional, dipakai kalau diskon member dipakai)' },
];

async function checkConnection(dbName) {
  try {
    await pool.query('SELECT 1');
    ok(`Koneksi database OK (host ${process.env.DB_HOST || 'localhost'}, db "${dbName}").`);
    return true;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      fatal(
        `Tidak bisa konek ke MariaDB/MySQL di ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306} ` +
        `(connection refused). Kemungkinan servicenya belum jalan - cek "net start MariaDB" ` +
        `(Windows) atau "sudo systemctl status mariadb" (Linux). Lihat README bagian 1.`
      );
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      fatal(
        `Login ke database ditolak untuk user "${process.env.DB_USER || 'root'}". ` +
        `Cek DB_USER/DB_PASSWORD di .env sesuai dengan yang sungguhan dibuat di MariaDB.`
      );
    } else if (err.code === 'ER_BAD_DB_ERROR') {
      fatal(
        `Database "${dbName}" belum ada. Buat dulu: ` +
        `mysql -u root -p -e "CREATE DATABASE ${dbName} CHARACTER SET utf8mb4" - lihat README bagian 1.`
      );
    } else {
      fatal(`Gagal konek ke database: ${err.message}`);
    }
    return false;
  }
}

async function checkWebTables(dbName) {
  for (const { table, migration, note } of WEB_TABLES_CHECKLIST) {
    const exists = await tableExists(dbName, table);
    if (!exists) {
      const isCritical = table === 'web_users' || table === 'web_tr_trans';
      const msg = `Tabel "${table}" (dari migration ${migration}) tidak ada - ${note}. ` +
        `Migration ${migration} sepertinya belum/gagal dijalankan - lihat README bagian 3.`;
      if (isCritical) fatal(msg); else warn(msg);
    }
  }
  if (!FATAL.length) ok('Semua tabel web_* penting (migration 001-023) ditemukan.');

  // Migration 024 hanya mengubah ENUM (tak ada tabel baru), jadi dicek
  // terpisah. Tanpa 024, void/batal item yang SUDAH DIBAYAR gagal total.
  if (await tableExists(dbName, 'web_print_log')) {
    const [[col]] = await pool.query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'web_print_log' AND column_name = 'print_type'`,
      [dbName]
    );
    if (col && !String(col.t).includes("'slip_refund'")) {
      fatal('Migration 024 (refund saat void/batal) belum dijalankan - void/batal item yang sudah dibayar akan GAGAL. Jalankan server/migrations/024_refund_slip.sql.');
    } else if (col) {
      ok('Migration 024 (slip refund) sudah terpasang.');
    }
  }
}

async function checkMasterTables(dbName) {
  let anyMissing = false;
  let anyEmpty = false;
  for (const { table, note } of MASTER_TABLES_CHECKLIST) {
    const exists = await tableExists(dbName, table);
    if (!exists) {
      anyMissing = true;
      warn(`Tabel master "${table}" tidak ada - ${note} TIDAK akan tampil di aplikasi.`);
      continue;
    }
    const n = await rowCount(table);
    if (n === 0) {
      anyEmpty = true;
      warn(`Tabel master "${table}" ADA tapi KOSONG (0 baris) - ${note} TIDAK akan tampil sampai diisi.`);
    } else {
      ok(`Tabel master "${table}": ${n} baris.`);
    }
  }
  if (anyMissing || anyEmpty) {
    warn(
      'Ringkasan: sebagian/seluruh data master (kamar/produk/tarif) belum ada. Ini NORMAL untuk unit ' +
      'yang baru pertama kali instalasi dan belum menjalankan salah satu dari dua jalur di README bagian 1: ' +
      '"Jalur A" (import dump database sistem kasir lama SEBELUM migration) atau "Jalur B" (isi manual pakai ' +
      'template server/migrations/dev_seed_master_data.sql, ganti data contohnya dengan data asli unit ini). ' +
      'Kalau unit ini SEHARUSNYA sudah punya data (baru pindah dari sistem lama), berarti data lamanya ' +
      'belum/gagal diimpor - cek lagi langkah import dump-nya.'
    );
  }
}

async function checkKnownSchemaGotchas(dbName) {
  // m_product.is_active: kode mengasumsikan TEKS 'TRUE'/'FALSE', bukan 0/1.
  // Ini pernah jadi bug "menu produk kosong" tanpa error sama sekali di
  // Grand Royal - deteksi di sini sebelum staf menemukannya sendiri.
  if (await tableExists(dbName, 'm_product')) {
    const hasIsActive = await columnExists(dbName, 'm_product', 'is_active');
    if (!hasIsActive) {
      warn('Tabel "m_product" tidak punya kolom "is_active" - katalog produk gr-pos butuh kolom ini (teks \'TRUE\'/\'FALSE\'). Skema m_product unit ini kemungkinan berbeda dari yang diasumsikan kode.');
    } else {
      const [rows] = await pool.query("SELECT COUNT(*) AS n FROM m_product WHERE is_active = 'TRUE'");
      const total = await rowCount('m_product');
      if (total > 0 && rows[0].n === 0) {
        warn(
          'Tabel "m_product" ada isinya tapi TIDAK ADA baris dengan is_active = \'TRUE\' (teks). ' +
          'Kalau kolom is_active di database ini sebenarnya angka (1/0) bukan teks (\'TRUE\'/\'FALSE\'), ' +
          'katalog produk akan tampil KOSONG di aplikasi tanpa pesan error apapun - ini bug yang sama ' +
          'yang pernah terjadi di instalasi Grand Royal. Sesuaikan query di server/routes/catalog.routes.js ' +
          'dan products.routes.js (cari "is_active = \'TRUE\'") ke tipe kolom asli unit ini.'
        );
      }
    }
  }

  if (await tableExists(dbName, 'tax_service')) {
    const hasCol = await columnExists(dbName, 'tax_service', 'tax_service');
    if (!hasCol) {
      warn('Tabel "tax_service" tidak punya kolom "tax_service" (persen service charge) - cek server/routes/catalog.routes.js getServiceChargePct(), skema unit ini kemungkinan beda nama kolom.');
    }
  }

  if (await tableExists(dbName, 'm_member')) {
    for (const col of ['id_member', 'nama_member', 'tgl_expired']) {
      if (!(await columnExists(dbName, 'm_member', col))) {
        warn(`Tabel "m_member" tidak punya kolom "${col}" yang diasumsikan kode (lihat server/routes/trans.routes.js getMemberDiscount()) - diskon member kemungkinan tidak akan jalan benar di unit ini.`);
      }
    }
  }
}

function checkEnvSanity() {
  const secret = process.env.JWT_SECRET || '';
  if (!secret || secret === 'ganti-dengan-secret-acak-yang-panjang') {
    fatal('JWT_SECRET di .env masih kosong atau masih nilai contoh dari .env.example - WAJIB diganti dengan string acak & rahasia sebelum dipakai staf (lihat README bagian 2).');
  } else {
    ok('JWT_SECRET sudah diisi (bukan nilai contoh).');
  }

  if (!process.env.DB_PASSWORD) {
    warn('DB_PASSWORD di .env kosong. Aman untuk coba-coba di laptop, TAPI untuk server produksi WAJIB set password root MariaDB (lihat README bagian 1) supaya database tidak bisa diakses siapapun di jaringan yang sama.');
  }
}

async function main() {
  const dbName = process.env.DB_NAME || 'bintangnew';
  console.log(`\n=== gr-pos preflight check - database "${dbName}" ===\n`);

  const connected = await checkConnection(dbName);
  if (connected) {
    await checkWebTables(dbName);
    await checkMasterTables(dbName);
    await checkKnownSchemaGotchas(dbName);
  }
  checkEnvSanity();

  if (OK.length) {
    console.log('OK:');
    OK.forEach((m) => console.log('  [OK]   ' + m));
    console.log('');
  }
  if (WARN.length) {
    console.log('PERINGATAN (tidak menghentikan instalasi, tapi cek sebelum dipakai staf sungguhan):');
    WARN.forEach((m) => console.log('  [WARN] ' + m));
    console.log('');
  }
  if (FATAL.length) {
    console.log('FATAL (harus dibereskan dulu sebelum lanjut `npm start`):');
    FATAL.forEach((m) => console.log('  [FATAL] ' + m));
    console.log('');
  }

  console.log(
    FATAL.length
      ? `HASIL: ADA ${FATAL.length} MASALAH FATAL - jangan lanjut dulu ke npm start.\n`
      : WARN.length
        ? `HASIL: aman untuk lanjut, tapi ada ${WARN.length} peringatan yang sebaiknya dicek dulu.\n`
        : 'HASIL: semua OK, aman untuk lanjut ke `npm start`.\n'
  );

  await pool.end();
  process.exit(FATAL.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Preflight check gagal jalan (error tak terduga):', err.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
