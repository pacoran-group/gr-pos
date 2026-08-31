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

// Alokasi waktu karaoke: PROPORSIONAL dengan nilai belanja FnB.
// Memenuhi threshold = CREDIT_HOURS_PER_THRESHOLD jam (default 2). Belanja
// 2x threshold = 2x jam, dst (dihitung berkelanjutan, bukan bertingkat).
// Ditambah jam gratis dari tombol "+ Add Time" (extra_hours_used).
const CREDIT_HOURS_PER_THRESHOLD = Number(process.env.CREDIT_HOURS_PER_THRESHOLD || 2);

// Default jam untuk room komplimen VVIP (mode 'comp' tanpa jam manual). VIP
// mengisi jam sendiri. Keduanya bisa diperpanjang lewat "+ Add Time".
const COMP_DEFAULT_HOURS = Number(process.env.COMP_DEFAULT_HOURS || 12);

/**
 * @param {object} p
 * @param {number} p.netFnb - total FnB setelah diskon member
 * @param {number} p.thresholdAmount - threshold kamar (snapshot di web_tr_trans)
 * @param {number} [p.extraHours=0] - web_tr_trans.extra_hours_used
 * @param {'threshold'|'comp'} [p.rateMode='threshold'] - web_tr_trans.rate_mode
 * @param {number|null} [p.compHours=null] - web_tr_trans.comp_hours (mode 'comp')
 * @returns {number} total waktu yang didapat dalam milidetik (sejak start_time)
 */
function allottedMs({ netFnb, thresholdAmount, extraHours = 0, rateMode = 'threshold', compHours = null }) {
  const extra = Number(extraHours) || 0;
  if (rateMode === 'comp') {
    // Comp (VIP/VVIP): waktu dari comp_hours yang ditetapkan kasir/approver,
    // BUKAN proporsional belanja F&B. Ditambah jam dari tombol "+ Add Time".
    return Math.round(((Number(compHours) || 0) + extra) * 3600000);
  }
  const t = Number(thresholdAmount) || 0;
  const base = t > 0 ? CREDIT_HOURS_PER_THRESHOLD * (Number(netFnb) / t) : 0;
  return Math.round((base + extra) * 3600000);
}

module.exports = {
  getWindowForTime, getThresholdAmount, allottedMs,
  CREDIT_HOURS_PER_THRESHOLD, COMP_DEFAULT_HOURS,
};
