/**
 * Menghapus Windows Service "gr-pos" yang dipasang lewat nodewindows-install.js.
 * PowerShell "Run as Administrator", dari folder gr-pos:
 *   node ops/service/nodewindows-uninstall.js
 */
const path = require('path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch (e) {
  console.error('Paket "node-windows" tidak ada. Jalankan: npm install --no-save node-windows');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', '..');
const svc = new Service({
  name: 'gr-pos',
  script: path.join(root, 'server', 'server.js'),
});

svc.on('uninstall', () => console.log('Service "gr-pos" dihapus.'));
svc.on('error', (err) => console.error('node-windows error:', err));
svc.uninstall();
