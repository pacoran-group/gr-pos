/**
 * Logika threshold FnB per tipe kamar, dari tabel m_promo (data master
 * yang sudah ada di database bintangnew).
 *
 * Aturan (dikonfirmasi user, lihat rencana-sistem-baru.md):
 * - Threshold beda untuk siang (07:00-17:00) vs malam.
 * - Tambah 1 jam gratis hanya boleh SETELAH nilai transaksi FnB
 *   sudah mencapai/melewati threshold ini.
 */

const SIANG_START_HOUR = 7;
const SIANG_END_HOUR = 17; // exclusive - jam 17:00 ke atas dianggap malam

function getWindowForTime(date = new Date()) {
  const hour = date.getHours();
  return hour >= SIANG_START_HOUR && hour < SIANG_END_HOUR ? 'siang' : 'malam';
}

/**
 * @param {object} conn - koneksi mysql2 (dalam transaction, atau pool)
 * @param {string} roomType - mis. 'SMALL', 'VIP U'
 * @param {'siang'|'malam'} window
 * @returns {Promise<number>} nominal threshold Rupiah
 */
async function getThresholdAmount(conn, roomType, window) {
  const column = window === 'siang' ? 'harga_sewa' : 'harga_sewa1';
  const [rows] = await conn.query(
    `SELECT ${column} AS threshold_amount FROM m_promo WHERE room_type = ? LIMIT 1`,
    [roomType]
  );
  if (!rows.length) {
    const err = new Error(`Tipe kamar "${roomType}" tidak ditemukan di m_promo.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(rows[0].threshold_amount);
}

// Alokasi waktu karaoke (direvisi 9 Sep 2026): FLAT, tidak proporsional.
// Memenuhi threshold = CREDIT_HOURS_PER_THRESHOLD jam (default 2), TITIK.
// Belanja 3x threshold tetap dapat 2 jam. Tamu yang mau lebih lama minta
// tambah waktu MANUAL (tombol di Detail Kamar -> web_tr_trans.extra_minutes,
// boleh negatif untuk pengurangan).
const CREDIT_HOURS_PER_THRESHOLD = Number(process.env.CREDIT_HOURS_PER_THRESHOLD || 2);

// Spare "waktu bayar & jalan ke ruangan": setiap buka kamar non-test dapat
// tambahan menit ini di depan, supaya saat tamu tiba di room hitungan mundur
// belum menggigit paket 2 jam-nya.
const PAYMENT_SPARE_MIN = Number(process.env.PAYMENT_SPARE_MIN || 10);

// Default jam untuk room komplimen VVIP (mode 'comp' tanpa jam manual). VIP
// mengisi jam sendiri. Keduanya bisa diubah lewat tombol tambah/kurang waktu.
const COMP_DEFAULT_HOURS = Number(process.env.COMP_DEFAULT_HOURS || 12);

// Lama sesi Mode Test (tes fisik room) sebelum player dimatikan otomatis
// oleh worker testMode. Staf bisa mengakhiri lebih cepat lewat "Selesai Tes".
const TEST_MODE_MINUTES = Number(process.env.TEST_MODE_MINUTES || 15);

/**
 * Total waktu kamar (ms sejak start_time). Dipakai server-side untuk
 * menghitung expires_at. TIDAK dipanggil untuk sesi Mode Test.
 *
 * threshold: CREDIT_HOURS_PER_THRESHOLD jam FLAT + spare + penyesuaian manual.
 * comp     : comp_hours (ditetapkan admin) + spare + penyesuaian manual.
 *
 * @param {object} p
 * @param {number} [p.extraMinutes=0] - web_tr_trans.extra_minutes (net, boleh negatif)
 * @param {'threshold'|'comp'} [p.rateMode='threshold']
 * @param {number|null} [p.compHours=null] - web_tr_trans.comp_hours (mode 'comp')
 * @param {boolean} [p.withSpare=true] - sertakan PAYMENT_SPARE_MIN
 * @returns {number} milidetik
 */
function allottedMs({ extraMinutes = 0, rateMode = 'threshold', compHours = null, withSpare = true } = {}) {
  const spareMin = withSpare ? PAYMENT_SPARE_MIN : 0;
  const baseHours = rateMode === 'comp' ? (Number(compHours) || 0) : CREDIT_HOURS_PER_THRESHOLD;
  const totalMin = baseHours * 60 + spareMin + (Number(extraMinutes) || 0);
  return Math.round(totalMin * 60000);
}

module.exports = {
  getWindowForTime, getThresholdAmount, allottedMs,
  CREDIT_HOURS_PER_THRESHOLD, PAYMENT_SPARE_MIN, COMP_DEFAULT_HOURS, TEST_MODE_MINUTES,
};
