/**
 * Config modul Tutup Kasir / Shift. Lihat migration 018.
 *
 * SHIFT_REQUIRED (env, default 'off'):
 *   'on'  -> kasir WAJIB "Buka Kasir" dulu sebelum bisa memproses
 *            pembayaran (buka kamar / tambah order / checkout). Pembayaran
 *            ditolak kalau tidak ada shift terbuka utk user itu.
 *   'off' -> pembayaran tetap jalan; shift_id diisi kalau kebetulan ada
 *            shift terbuka, kalau tidak NULL. (rollout aman)
 */
const SHIFT_REQUIRED = String(process.env.SHIFT_REQUIRED || 'off').toLowerCase() === 'on';

module.exports = { SHIFT_REQUIRED };
