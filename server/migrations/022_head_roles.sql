-- =====================================================================
-- Migration 022 (16 September 2026): Tambah role manajemen head_unit &
-- head_karaoke.
--
-- web_users.role adalah ENUM (bukan sekadar VARCHAR bebas) sejak migration
-- 001, dilebarkan migration 004 (+gudang). INSERT/UPDATE dgn role di luar
-- daftar ENUM GAGAL dgn error "Data truncated for column 'role'" (sql_mode
-- STRICT_TRANS_TABLES) - jadi role baru WAJIB masuk enum dulu sebelum bisa
-- dipakai createAdmin.js.
--
--   head_unit    : setara supervisor MINUS Analitik & tombol set Maintenance
--                  kamar (lihat ROLE_NAV di public/js/layout.js & gate di
--                  server/routes/analytics.routes.js, rooms.routes.js).
--   head_karaoke : setara admin (mengawasi semua unit karaoke grup) - semua
--                  menu terbuka, KECUALI Void/Tukar Item yang tetap murni
--                  admin-only (kebijakan sengaja sejak 9 Sep 2026, lihat
--                  trans.routes.js requireAdminActor).
--
-- Aman dijalankan ulang.
-- =====================================================================

ALTER TABLE web_users
  MODIFY COLUMN role
    ENUM('admin','supervisor','kasir','dapur','waiter','gudang','head_unit','head_karaoke') NOT NULL;
