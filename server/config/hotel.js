/**
 * Config modul "F&B Hotel" - lihat migration 007_fnb_hotel.sql &
 * server/services/hotelFnb.service.js.
 *
 * Style: meniru server/config/unit.js - const flat dari process.env,
 * dibaca sekali saat require (dotenv sudah override:true di server.js).
 *
 * Service charge HOTEL bersifat INKLUSIF: harga menu = harga final yang
 * dibayar tamu (masuk folio). Komponen SC dihitung mundur untuk pembukuan:
 *   sc = round(total * HOTEL_FNB_SC_PCT / (100 + HOTEL_FNB_SC_PCT))
 * (Karaoke TIDAK diubah - di sana SC aditif.)
 */
const { UNIT_ID } = require('./unit');

const HOTEL_UNIT_ID = process.env.HOTEL_UNIT_ID || `HOTEL-${UNIT_ID}`;
const HOTEL_NAME = process.env.HOTEL_NAME || 'Hotel';
const HOTEL_FNB_SC_PCT = Number(process.env.HOTEL_FNB_SC_PCT || 7);

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const HOTEL_FNB_RECIPIENTS = splitList(process.env.HOTEL_FNB_RECIPIENTS);
const HOTEL_FNB_CC = splitList(process.env.HOTEL_FNB_CC);

/** True kalau email rekap F&B hotel bisa dikirim (SMTP host + minimal 1 penerima). */
function hotelFnbMailConfigured() {
  return Boolean(process.env.SMTP_HOST && HOTEL_FNB_RECIPIENTS.length);
}

module.exports = {
  HOTEL_UNIT_ID,
  HOTEL_NAME,
  HOTEL_FNB_SC_PCT,
  HOTEL_FNB_RECIPIENTS,
  HOTEL_FNB_CC,
  hotelFnbMailConfigured,
};
