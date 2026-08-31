/**
 * Pengirim email - dipakai modul Laporan Tutup Hari & F&B Hotel.
 * Wrapper tipis di atas nodemailer; transport dibuat lazy (sekali) dari
 * kredensial SMTP di .env (lihat server/config/report.js).
 */
const nodemailer = require('nodemailer');
const { AppError } = require('../middleware/errorHandler');
const cfg = require('../config/report');

let _tx = null;

function transporter() {
  if (!cfg.SMTP_HOST) {
    throw new AppError(500, 'SMTP belum dikonfigurasi di .env (butuh SMTP_HOST).');
  }
  if (!_tx) {
    _tx = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE, // true = 465/SSL, false = 587/STARTTLS
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD } : undefined,
    });
  }
  return _tx;
}

/**
 * Kirim satu email dengan 1 lampiran CSV. Penerima WAJIB diisi pemanggil
 * (`to`) - modul yang berbeda punya daftar penerima berbeda di .env.
 * @param {{subject:string, html:string, csv:string, csvFilename:string, to:string[], cc?:string[]}} p
 * @returns {Promise<{messageId:string, accepted:string[], rejected:string[]}>}
 */
async function sendMail({ subject, html, csv, csvFilename, to, cc }) {
  if (!to || !to.length) {
    throw new AppError(500, 'Daftar penerima email kosong (cek *_RECIPIENTS di .env).');
  }
  const info = await transporter().sendMail({
    from: cfg.SMTP_FROM,
    to,
    cc: cc && cc.length ? cc : undefined,
    subject,
    html,
    attachments: [{ filename: csvFilename, content: csv, contentType: 'text/csv; charset=utf-8' }],
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

/** Kirim email laporan Tutup Hari karaoke (penerima default = EOD_REPORT_RECIPIENTS). */
async function sendDailyClose({ subject, html, csv, csvFilename, to, cc }) {
  return sendMail({
    subject, html, csv, csvFilename,
    to: to && to.length ? to : cfg.EOD_REPORT_RECIPIENTS,
    cc: cc && cc.length ? cc : cfg.EOD_REPORT_CC,
  });
}

module.exports = { sendMail, sendDailyClose };
