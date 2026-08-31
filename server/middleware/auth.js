const jwt = require('jsonwebtoken');

/** Memverifikasi JWT dan menempelkan req.user = { user_id, username, role, terminal_id } */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Token tidak ditemukan. Silakan login.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    // terminal_id murni untuk audit trail (bagian mana request ini berasal),
    // BUKAN pembatas kewenangan - kewenangan dikontrol lewat req.user.role.
    req.terminalId = req.headers['x-terminal-id'] || payload.terminal_id || 'unknown';
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa. Silakan login ulang.' });
  }
}

/** Membatasi endpoint hanya untuk role tertentu, mis. requireRole('admin','supervisor') */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Anda tidak punya akses untuk aksi ini.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
