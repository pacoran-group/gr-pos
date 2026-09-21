-- =====================================================================
-- DUA KEGUNAAN file ini (SAMA-SAMA aman, karena semua CREATE TABLE pakai
-- IF NOT EXISTS dan semua INSERT pakai IGNORE - jalan ulang tidak
-- menduplikasi/menimpa data yang sudah ada):
--
-- 1) DEV/TEST LOKAL - jalankan APA ADANYA di database kosong (laptop
--    developer) untuk mencoba aplikasi tanpa data asli venue manapun.
--
-- 2) TEMPLATE "Jalur B" produksi (unit baru yang BELUM PERNAH punya sistem
--    kasir/database lama sama sekali - lihat README bagian 1). gr-pos
--    tidak (dan tidak akan) punya halaman admin untuk membuat kamar, tipe
--    kamar/tarif, % service charge, atau member - satu-satunya cara tabel
--    itu terisi di database yang benar-benar baru adalah SQL manual. Untuk
--    kasus ini: COPY file ini, HAPUS/GANTI seluruh baris di bagian "DATA
--    CONTOH" di bawah dengan data ASLI unit ybs (kamar, tipe & tarif
--    kamar, % service charge), baru dijalankan di database unit itu.
--
-- JANGAN dijalankan (apalagi dgn data contoh di bawah) di database yang
-- SUDAH punya data master asli (mis. `bintangnew` Grand Royal, atau unit
-- manapun yang datanya sudah diisi) - isi tabelnya akan bentrok dengan
-- data asli / kamar dobel.
--
-- SKEMA di bawah ini SUDAH DISESUAIKAN (21 Sep 2026) dengan skema nyata
-- yang dipakai kode SEKARANG (bukan tebakan awal developer yang salah -
-- lihat server/routes/catalog.routes.js, products.routes.js,
-- trans.routes.js untuk skema asli yang dikonfirmasi dari database
-- produksi Grand Royal). Catatan penting kalau unit lain punya sistem
-- kasir lama dengan skema BERBEDA dari ini (sangat mungkin - vendor beda):
-- jalankan `node server/utils/preflightCheck.js` setelah import data lama
-- unit itu untuk mendeteksi kolom yang tidak cocok SEBELUM go-live, bukan
-- ditemukan nanti sebagai "menu produk kosong" tanpa pesan error.
--
-- Tabel m_category SENGAJA TIDAK dibuat di sini - sejak 29 Agu 2026 kode
-- tidak lagi memakai tabel kategori terpisah, `m_product.category` sudah
-- menyimpan nama kategori langsung sebagai teks (lihat products.routes.js).
-- =====================================================================

CREATE TABLE IF NOT EXISTS m_room (
  room_id INT AUTO_INCREMENT PRIMARY KEY,
  room_name VARCHAR(50) NOT NULL,
  room_type VARCHAR(20) NOT NULL,
  status VARCHAR(5) NOT NULL DEFAULT '1'
) ENGINE=InnoDB;

-- room_type di sini HARUS sama persis (termasuk spasi/huruf besar-kecil)
-- dengan room_type yang dipakai di m_room di atas - dipakai untuk mencari
-- tarif kamar saat buka kamar (server/services/threshold.service.js).
CREATE TABLE IF NOT EXISTS m_promo (
  promo_id INT AUTO_INCREMENT PRIMARY KEY,
  room_type VARCHAR(20) NOT NULL,
  harga_sewa DECIMAL(12,2) NOT NULL,
  harga_sewa1 DECIMAL(12,2) NOT NULL,
  urut INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- Skema PERSIS sama dengan m_product produksi Grand Royal (lihat
-- products.routes.js baris komentar header). Kolom qty_stok/jenis_stok/
-- disc/sc/ppn tidak dipakai logika gr-pos, hanya di-insert dgn nilai
-- default supaya konsisten dengan skema asli.
CREATE TABLE IF NOT EXISTS m_product (
  prod_id INT AUTO_INCREMENT PRIMARY KEY,
  prod_desc VARCHAR(150) NOT NULL,
  category VARCHAR(50) NOT NULL,
  qty_stok INT NOT NULL DEFAULT 0,
  harga_jual DOUBLE NOT NULL,
  tgl_masuk DATE NULL,
  satuan VARCHAR(15) NULL,
  harga_mdl DOUBLE NOT NULL DEFAULT 0,
  jenis_stok VARCHAR(20) NULL,
  is_active VARCHAR(15) NOT NULL DEFAULT 'TRUE',
  disc DOUBLE NOT NULL DEFAULT 0,
  sc DOUBLE NOT NULL DEFAULT 0,
  ppn DOUBLE NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- 1 baris saja dipakai (LIMIT 1 di catalog.routes.js/trans.routes.js) -
-- kolom `tax_service` adalah % service charge yang berlaku (bukan nama
-- tabelnya - penamaan asli begini, memang membingungkan).
CREATE TABLE IF NOT EXISTS tax_service (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_tax INT NOT NULL DEFAULT 0,
  food_tax INT NOT NULL DEFAULT 0,
  tax_service INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS m_member (
  id_member VARCHAR(25) PRIMARY KEY,
  ktp VARCHAR(30) NULL,
  nama_member VARCHAR(100) NOT NULL,
  alamat VARCHAR(255) NULL,
  telp VARCHAR(30) NULL,
  disc_room DECIMAL(5,2) NOT NULL DEFAULT 0,
  disc_fnb DECIMAL(5,2) NOT NULL DEFAULT 0,
  tgl_expired DATE NULL
) ENGINE=InnoDB;

-- =====================================================================
-- DATA CONTOH (bukan data asli venue manapun) - untuk pemakaian #2 di
-- atas (Jalur B produksi), GANTI SEMUA baris di bawah ini dengan data
-- asli unit sebelum dipakai staf sungguhan.
-- =====================================================================

INSERT IGNORE INTO tax_service (id, room_tax, food_tax, tax_service) VALUES (1, 0, 0, 5);

INSERT IGNORE INTO m_promo (room_type, harga_sewa, harga_sewa1, urut) VALUES
  ('SMALL', 150000, 200000, 1),
  ('MEDIUM', 180000, 250000, 2),
  ('BIG', 320000, 400000, 3),
  ('VIP', 400000, 500000, 4),
  ('VIP U', 500000, 650000, 5),
  ('VIP S', 650000, 800000, 6);

INSERT IGNORE INTO m_product (prod_id, prod_desc, category, harga_jual, harga_mdl, satuan, is_active, qty_stok, tgl_masuk, jenis_stok, disc, sc, ppn) VALUES
  (1, 'Kentang Goreng', 'MAKANAN', 35000, 20000, 'PORSI', 'TRUE', 0, CURDATE(), '', 0, 0, 0),
  (2, 'Nasi Goreng', 'MAKANAN', 45000, 25000, 'PORSI', 'TRUE', 0, CURDATE(), '', 0, 0, 0),
  (3, 'Es Teh Manis', 'MINUMAN', 15000, 5000, 'GELAS', 'TRUE', 0, CURDATE(), '', 0, 0, 0),
  (4, 'Jus Alpukat', 'MINUMAN', 25000, 12000, 'GELAS', 'TRUE', 0, CURDATE(), '', 0, 0, 0),
  (5, 'Kacang Kulit', 'SNACK', 20000, 10000, 'PORSI', 'TRUE', 0, CURDATE(), '', 0, 0, 0);

INSERT IGNORE INTO m_member (id_member, nama_member, disc_room, disc_fnb, tgl_expired) VALUES
  ('M001', 'Member Contoh', 10.00, 5.00, '2099-12-31');

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
