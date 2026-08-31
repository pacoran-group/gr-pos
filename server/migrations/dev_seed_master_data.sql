-- =====================================================================
-- HANYA UNTUK DEV/TEST LOKAL - JANGAN JALANKAN DI DATABASE PRODUKSI
-- (`bintangnew` yang asli SUDAH PUNYA data master ini - m_room, m_promo,
-- m_product, dst. Menjalankan script ini di sana akan bentrok/duplikat.)
--
-- Kegunaan: kalau developer ingin menguji aplikasi ini di database
-- MySQL kosong (mis. laptop developer, sebelum instalasi di server LAN
-- Grand Royal yang sebenarnya), script ini membuat versi MINIMAL dari
-- tabel master yang dibutuhkan (m_room, m_promo, m_product, m_category,
-- tax_service, m_member) berisi data contoh yang meniru struktur nyata
-- (32 kamar, 6 tipe kamar, threshold m_promo) sesuai temuan di
-- rencana-sistem-baru.md - BUKAN data asli venue.
-- =====================================================================

CREATE TABLE IF NOT EXISTS m_room (
  room_id INT AUTO_INCREMENT PRIMARY KEY,
  room_name VARCHAR(50) NOT NULL,
  room_type VARCHAR(20) NOT NULL,
  status VARCHAR(5) NOT NULL DEFAULT '1'
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS m_promo (
  promo_id INT AUTO_INCREMENT PRIMARY KEY,
  room_type VARCHAR(20) NOT NULL,
  harga_sewa DECIMAL(12,2) NOT NULL,
  harga_sewa1 DECIMAL(12,2) NOT NULL,
  urut INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS m_category (
  category_id INT AUTO_INCREMENT PRIMARY KEY,
  category_name VARCHAR(50) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS m_product (
  product_id VARCHAR(25) PRIMARY KEY,
  product_name VARCHAR(150) NOT NULL,
  category_id INT NULL,
  price DECIMAL(12,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tax_service (
  id INT AUTO_INCREMENT PRIMARY KEY,
  service_charge_pct DECIMAL(5,2) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS m_member (
  member_id VARCHAR(25) PRIMARY KEY,
  member_name VARCHAR(100) NOT NULL,
  disc_room_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  disc_fnb_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- --- Data contoh (bukan data asli) ---

INSERT IGNORE INTO m_category (category_id, category_name) VALUES
  (1,'Makanan'), (2,'Minuman'), (3,'Snack'), (4,'Rokok'), (5,'Bar');

-- Contoh routing: kategori "Bar" (id 5, minuman siap saji/beralkohol) tidak
-- perlu tiket dapur - cukup diambil dari gudang (sudah ada di slip gudang).
-- Kategori lain default needs_cooking=1 (Makanan perlu dimasak, dst).
INSERT IGNORE INTO web_category_routing (category_id, needs_cooking, note) VALUES
  (1, 1, 'Makanan - perlu dimasak dapur'),
  (2, 1, 'Minuman non-bar (jus, teh, dsb) - contoh, sesuaikan'),
  (3, 1, 'Snack - contoh, sesuaikan'),
  (4, 0, 'Rokok - tidak perlu dimasak'),
  (5, 0, 'Bar - minuman siap saji/beralkohol, cukup ambil dari gudang');

INSERT IGNORE INTO tax_service (id, service_charge_pct) VALUES (1, 5.00);

INSERT IGNORE INTO m_promo (room_type, harga_sewa, harga_sewa1, urut) VALUES
  ('SMALL', 150000, 200000, 1),
  ('MEDIUM', 180000, 250000, 2),
  ('BIG', 320000, 400000, 3),
  ('VIP', 400000, 500000, 4),
  ('VIP U', 500000, 650000, 5),
  ('VIP S', 650000, 800000, 6);

INSERT IGNORE INTO m_product (product_id, product_name, category_id, price, active) VALUES
  ('P001', 'Kentang Goreng', 1, 35000, 1),
  ('P002', 'Nasi Goreng', 1, 45000, 1),
  ('P003', 'Es Teh Manis', 2, 15000, 1),
  ('P004', 'Jus Alpukat', 2, 25000, 1),
  ('P005', 'Kacang Kulit', 3, 20000, 1);

INSERT IGNORE INTO m_member (member_id, member_name, disc_room_pct, disc_fnb_pct, active) VALUES
  ('M001', 'Member Contoh', 10.00, 5.00, 1);

-- 32 kamar contoh (10 SMALL, 7 MEDIUM, 2 BIG, 6 VIP, 6 VIP U, 1 VIP S)
INSERT IGNORE INTO m_room (room_id, room_name, room_type, status) VALUES
  (1,'Room 1','SMALL','1'), (2,'Room 2','SMALL','1'), (3,'Room 3','SMALL','1'),
  (4,'Room 4','SMALL','1'), (5,'Room 5','SMALL','1'), (6,'Room 6','SMALL','1'),
  (7,'Room 7','SMALL','1'), (8,'Room 8','SMALL','1'), (9,'Room 9','SMALL','1'),
  (10,'Room 10','SMALL','1'),
  (11,'Room 11','MEDIUM','1'), (12,'Room 12','MEDIUM','1'), (13,'Room 13','MEDIUM','1'),
  (14,'Room 14','MEDIUM','1'), (15,'Room 15','MEDIUM','1'), (16,'Room 16','MEDIUM','1'),
  (17,'Room 17','MEDIUM','1'),
  (18,'Room 18','BIG','1'), (19,'Room 19','BIG','1'),
  (20,'Room 20','VIP','1'), (21,'Room 21','VIP','1'), (22,'Room 22','VIP','0'),
  (23,'Room 23','VIP','1'), (24,'Room 24','VIP','1'), (25,'Room 25','VIP','1'),
  (26,'Room 26','VIP U','1'), (27,'Room 27','VIP U','1'), (28,'Room 28','VIP U','1'),
  (29,'Room 29','VIP U','1'), (30,'Room 30','VIP U','1'), (31,'Room 31','VIP U','1'),
  (32,'Room 32','VIP S','1');
-- Catatan: Room 22 sengaja status '0' meniru temuan asli (kamar rusak/maintenance).
