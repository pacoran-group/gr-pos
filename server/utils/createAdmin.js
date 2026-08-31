/**
 * CLI kecil untuk membuat/reset user di web_users dengan password ter-hash
 * (bcrypt) dengan benar - dipakai sekali saat setup awal, atau kapan pun
 * butuh reset password seorang user.
 *
 * Cara pakai (dijalankan di folder project, setelah `npm install` &
 * setelah migration 001_create_web_tables.sql dijalankan):
 *
 *   node server/utils/createAdmin.js <username> <password> "<Nama Lengkap>" [role]
 *
 * Contoh:
 *   node server/utils/createAdmin.js admin RahasiaKuat123 "Admin Utama" admin
 *   node server/utils/createAdmin.js kasir1 Kasir123 "Budi Kasir" kasir
 *
 * role default: admin. Pilihan role: admin, supervisor, kasir, dapur, waiter, gudang.
 */
require('dotenv').config({ override: true }); // .env project menang atas env sistem - lihat catatan di server.js
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

async function main() {
  const [username, password, fullName, role = 'admin'] = process.argv.slice(2);

  if (!username || !password || !fullName) {
    console.error('Pemakaian: node server/utils/createAdmin.js <username> <password> "<Nama Lengkap>" [role]');
    process.exit(1);
  }

  const validRoles = ['admin', 'supervisor', 'kasir', 'dapur', 'waiter', 'gudang'];
  if (!validRoles.includes(role)) {
    console.error(`Role tidak valid. Pilihan: ${validRoles.join(', ')}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      `INSERT INTO web_users (username, password_hash, full_name, role, active)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), full_name = VALUES(full_name), role = VALUES(role)`,
      [username, hash, fullName, role]
    );
    console.log(`OK - user "${username}" (role: ${role}) siap dipakai untuk login.`);
  } catch (err) {
    console.error('Gagal membuat/update user:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
