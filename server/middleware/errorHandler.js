const { isLockTimeoutError } = require('../config/db');

/**
 * Error handler terpusat. Yang paling penting: menerjemahkan lock-timeout
 * MySQL (dua terminal bentrok di room yang sama) jadi pesan yang jelas ke
 * kasir, bukan error 500 generik.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (isLockTimeoutError(err)) {
    return res.status(409).json({
      error: 'Room ini sedang diproses di terminal lain. Coba lagi sebentar.',
      code: 'ROOM_LOCKED',
    });
  }

  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error('[unhandled error]', err);
  return res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
}

class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { errorHandler, AppError };
