const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bintangnew',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  decimalNumbers: true,
});

const LOCK_WAIT_TIMEOUT_SECONDS = Number(process.env.DB_LOCK_WAIT_TIMEOUT_SECONDS || 5);

/**
 * Menjalankan `work(conn)` di dalam satu database transaction, dengan
 * innodb_lock_wait_timeout yang pendek supaya request kedua yang bentrok
 * (mis. dua terminal memproses room yang sama) gagal cepat dengan pesan
 * jelas, bukan menggantung lama atau diam-diam menimpa data.
 *
 * Lihat claude project doc "desain-teknis-room-billing.md" bagian 2.1.
 */
async function withTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`SET innodb_lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_SECONDS}`);
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* ignore rollback error, original error is what matters */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** true kalau error MySQL ini adalah lock wait timeout (room sedang diproses terminal lain) */
function isLockTimeoutError(err) {
  return err && (err.errno === 1205 || err.code === 'ER_LOCK_WAIT_TIMEOUT');
}

module.exports = { pool, withTransaction, isLockTimeoutError };
