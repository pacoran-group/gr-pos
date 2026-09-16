/**
 * Alternatif TANPA unduh (kalau tidak mau pakai NSSM).
 * Memakai paket npm `node-windows` (berbasis winsw) untuk mendaftarkan
 * gr-pos sebagai Windows Service auto-start + auto-restart.
 *
 * Cara pakai (PowerShell "Run as Administrator", dari folder gr-pos):
 *   npm install --no-save node-windows
 *   node ops/service/nodewindows-install.js
 *
 * Uninstall:
 *   node ops/service/nodewindows-uninstall.js
 *
 * Catatan: NSSM (Install-GrPosService.ps1) lebih disarankan - rotasi log
 * lebih baik & kontrol restart-throttle lebih halus. Pakai ini hanya kalau
 * unduh nssm.exe tidak memungkinkan.
 */
const path = require('path');
const fs = require('fs');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch (e) {
  console.error('Paket "node-windows" belum terpasang. Jalankan dulu:\n  npm install --no-save node-windows');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', '..'); // ...\gr-pos
const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });

const svc = new Service({
  name: 'gr-pos',
  description: 'POS Grand Royal (Node/Express). Auto-restart saat crash. Konfigurasi: gr-pos\\.env',
  script: path.join(root, 'server', 'server.js'),
  workingDirectory: root,
  env: [{ name: 'NODE_ENV', value: 'production' }],
  // Backoff restart: mulai 2 dtk, tumbuh 50%, maks ~40 percobaan.
  wait: 2,
  grow: 0.5,
  maxRetries: 40,
  // Maks 5 restart dalam 60 dtk -> cegah crash-loop.
  maxRestarts: 5,
  logpath: logDir,
});

svc.on('install', () => {
  console.log('Service "gr-pos" terpasang. Menjalankan...');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('Service "gr-pos" sudah terpasang sebelumnya.'));
svc.on('start', () => console.log('Service "gr-pos" BERJALAN. Log: ' + logDir));
svc.on('error', (err) => console.error('node-windows error:', err));

svc.install();
