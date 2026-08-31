/**
 * Scheduler "Tutup Hari" (End-of-Day) OTOMATIS.
 *
 * Tiap ~10 menit cek: apakah hari usaha yang BARU SAJA berakhir (di jam
 * EOD_CUTOFF_HOUR) sudah di-generate & di-email? Kalau belum ->
 * generateAndPersist + kirim email ke EOD_REPORT_RECIPIENTS + lampiran CSV.
 *
 * - Idempoten via web_daily_close.emailed_at -> aman kalau server restart
 *   atau tick jalan berkali-kali; hanya 1 email per hari usaha.
 * - Aman kalau server sempat mati saat jam cutoff: tick berikutnya menyusul
 *   selama masih hari kalender yang sama.
 * - Tombol "Tutup Hari & Kirim Email" di reports.html tetap berfungsi
 *   independen (bisa dipakai untuk regenerate / kirim ulang versi baru).
 * - Kalau SMTP belum dikonfigurasi (.env), scheduler diam - biarkan alur
 *   manual saja.
 *
 * ASUMSI WAKTU: server dianggap WIB (UTC+7, tanpa DST) - konsisten dgn
 * config/report.js & dailyClose.service.js.
 */
const { pool } = require('../config/db');
const cfg = require('../config/report');
const { UNIT_ID } = require('../config/unit');
const svc = require('./dailyClose.service');
const mailer = require('./mailer.service');

const TICK_MS = 10 * 60 * 1000; // cek tiap 10 menit
const AUTO_AFTER_MIN = 15;      // menit setelah jam cutoff baru boleh kirim

let running = false;

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Hari usaha yang baru saja berakhir, dilihat dari `now` (dianggap WIB).
 * Hari usaha D = [D cutoff:00, (D+1) cutoff:00). Kalau `now` sudah lewat
 * cutoff hari ini, hari usaha yang berakhir tadi pagi = tanggal kalender
 * KEMARIN.
 */
function justEndedBusinessDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return fmtDate(d);
}

async function tick() {
  if (running) return;
  const now = new Date();

  // Hanya jalan setelah (cutoff:AUTO_AFTER_MIN). Sebelum itu -> masih di
  // dalam hari usaha kemarin, atau terlalu dini untuk menutup.
  const minutesSinceCutoff = (now.getHours() - cfg.EOD_CUTOFF_HOUR) * 60 + now.getMinutes();
  if (minutesSinceCutoff < AUTO_AFTER_MIN) return;

  if (!cfg.smtpConfigured()) return; // tanpa SMTP + penerima, biarkan manual

  const businessDate = justEndedBusinessDate(now);
  running = true;
  try {
    const [[existing]] = await pool.query(
      'SELECT emailed_at FROM web_daily_close WHERE unit_id = ? AND business_date = ?',
      [UNIT_ID, businessDate]
    );
    if (existing && existing.emailed_at) return; // sudah terkirim hari ini

    // Pratinjau (tidak menyimpan). Hari tanpa transaksi selesai -> jangan
    // auto-kirim: hindari email kosong + version bump berulang tiap tick.
    // (Hari libur/kosong tetap bisa ditutup manual dari reports.html.)
    const preview = await svc.computeReport(businessDate);
    if (!preview.summary.closed_count) return;

    const { report } = await svc.generateAndPersist(businessDate, null);

    try {
      await mailer.sendDailyClose({
        subject: svc.subjectFor(report),
        html: svc.renderHtmlEmail(report),
        csv: svc.toCsv(report),
        csvFilename: svc.csvFilename(businessDate),
      });
      const emailTo = []
        .concat(cfg.EOD_REPORT_RECIPIENTS, cfg.EOD_REPORT_CC)
        .join(', ')
        .slice(0, 500);
      await pool.query(
        `UPDATE web_daily_close SET emailed_at = NOW(), email_to = ?, email_error = NULL
          WHERE unit_id = ? AND business_date = ?`,
        [emailTo, UNIT_ID, businessDate]
      );
      console.log(`[eod] auto Tutup Hari ${businessDate} terkirim -> ${emailTo}`);
    } catch (mailErr) {
      await pool.query(
        `UPDATE web_daily_close SET email_error = ? WHERE unit_id = ? AND business_date = ?`,
        [String(mailErr.message).slice(0, 500), UNIT_ID, businessDate]
      );
      console.error(`[eod] auto Tutup Hari ${businessDate}: email GAGAL: ${mailErr.message}`);
      // emailed_at tetap NULL -> tick berikutnya mencoba lagi.
    }
  } catch (err) {
    console.error(`[eod] auto tick error: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Pasang scheduler. `timers` = array setInterval handle utk shutdown rapi. */
function start(timers) {
  if (cfg.smtpConfigured()) {
    console.log(
      `[eod] scheduler ENABLED (cek tiap ${TICK_MS / 60000} mnt; kirim otomatis setelah ` +
        `${pad(cfg.EOD_CUTOFF_HOUR)}:${pad(AUTO_AFTER_MIN)} WIB ke ${cfg.EOD_REPORT_RECIPIENTS.join(', ')})`
    );
  } else {
    console.log('[eod] scheduler STANDBY (SMTP/penerima belum di .env) - alur manual saja.');
  }
  setTimeout(tick, 30000);
  timers.push(setInterval(tick, TICK_MS));
}

module.exports = { start, tick, justEndedBusinessDate };
