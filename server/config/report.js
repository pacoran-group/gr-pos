/**
 * Config modul Laporan "Tutup Hari" (End-of-Day) - lihat migration
 * 006_daily_close.sql & server/services/dailyClose.service.js.
 *
 * ASUMSI WAKTU: server dianggap berjalan di zona WIB (UTC+7, tanpa DST).
 * Codebase tidak punya timezone handling - semua DATETIME naive lokal.
 *
 * HARI USAHA: karaoke jalan lewat tengah malam. EOD_CUTOFF_HOUR memisah
 * hari: hari usaha D mencakup transaksi yang end_time-nya di
 *   [ D  EOD_CUTOFF_HOUR:00:00 , (D+1) EOD_CUTOFF_HOUR:00:00 )
 * Contoh default (5): hari usaha "2026-08-28" = 28 Agt 05:00 s/d 29 Agt 05:00.
 *
 * Style: meniru server/config/unit.js - const flat dari process.env,
 * dibaca sekali saat require (dotenv sudah override:true di server.js).
 */
const EOD_CUTOFF_HOUR = Number(process.env.EOD_CUTOFF_HOUR || 5);

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'off').toLowerCase() === 'on';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const SMTP_FROM = process.env.SMTP_FROM || 'GR POS <no-reply@grandroyal.local>';

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const EOD_REPORT_RECIPIENTS = splitList(process.env.EOD_REPORT_RECIPIENTS);
const EOD_REPORT_CC = splitList(process.env.EOD_REPORT_CC);

/** True kalau email tutup-hari bisa dikirim (host + minimal 1 penerima). */
function smtpConfigured() {
  return Boolean(SMTP_HOST && EOD_REPORT_RECIPIENTS.length);
}

module.exports = {
  EOD_CUTOFF_HOUR,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASSWORD,
  SMTP_FROM,
  EOD_REPORT_RECIPIENTS,
  EOD_REPORT_CC,
  smtpConfigured,
};
