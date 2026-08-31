-- =====================================================================
-- Migration untuk POS baru Grand Royal
-- Jalankan di database `bintangnew` yang SUDAH ADA (server pusat).
--
-- PENTING: script ini HANYA membuat tabel baru berprefix `web_`.
-- Tidak menyentuh/mengubah tabel app lama (m_room, m_promo, m_product,
-- m_member, m_user, tax_service, tr_trans, trans_dummy, dst) sama sekali.
-- Aman dijalankan berdampingan dengan aplikasi lama yang masih berjalan.
--
-- Lihat claude project doc "desain-teknis-room-billing.md" untuk
-- penjelasan tiap tabel & mekanisme locking-nya.
-- =====================================================================

-- Master user aplikasi BARU (terpisah dari m_user lama yang plaintext).
-- Role TIDAK terikat ke komputer/terminal tertentu - kasir bisa login
-- di terminal A maupun B dengan hak akses yang sama persis.
CREATE TABLE IF NOT EXISTS web_users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role ENUM('admin','supervisor','kasir','dapur','waiter') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Status maintenance/rusak kamar (terpisah dari m_room.status app lama).
CREATE TABLE IF NOT EXISTS web_room_maintenance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  is_maintenance TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(255) NULL,
  set_by INT NULL,
  set_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at DATETIME NULL,
  UNIQUE KEY uq_room (room_id)
) ENGINE=InnoDB;

-- Soft-lock UX (lapisan bantu, BUKAN mekanisme keamanan utama).
-- Mekanisme keamanan sebenarnya ada di row lock "FOR UPDATE" pada
-- web_tr_trans / m_room di dalam DB transaction (lihat services/db.js).
CREATE TABLE IF NOT EXISTS web_room_soft_lock (
  room_id INT PRIMARY KEY,
  terminal_id VARCHAR(50) NOT NULL,
  user_id INT NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Transaksi kamar - SATU FASE (tidak ada status menunggu_open lagi).
-- Bisa di-INSERT/UPDATE dari terminal manapun (A atau B) - simetris.
CREATE TABLE IF NOT EXISTS web_tr_trans (
  trans_id VARCHAR(30) PRIMARY KEY,
  room_id INT NOT NULL,
  room_type_snapshot VARCHAR(50) NOT NULL,
  cust_name VARCHAR(100) NOT NULL DEFAULT 'MR. GUEST',
  person INT NOT NULL DEFAULT 0,
  waiter_id VARCHAR(100) NULL,
  member_id VARCHAR(25) NULL,
  member_disc_room DECIMAL(12,2) NOT NULL DEFAULT 0,
  member_disc_fnb DECIMAL(12,2) NOT NULL DEFAULT 0,
  initial_paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  initial_payment_method ENUM('cash','debit','credit') NOT NULL DEFAULT 'cash',
  threshold_window ENUM('siang','malam') NOT NULL,
  threshold_amount DECIMAL(12,2) NOT NULL,
  extra_hours_used INT NOT NULL DEFAULT 0,
  status ENUM('active','closed','cancelled') NOT NULL DEFAULT 'active',
  service_charge_pct DECIMAL(5,2) NOT NULL,
  opened_by_user_id INT NOT NULL,
  opened_at_terminal VARCHAR(50) NOT NULL,
  closed_by_user_id INT NULL,
  closed_at_terminal VARCHAR(50) NULL,
  final_payment_method ENUM('cash','qris','card') NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_room_status (room_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS web_tr_trans_details (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  product_id VARCHAR(25) NOT NULL,
  product_name_snapshot VARCHAR(150) NOT NULL,
  qty INT NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  added_by_user_id INT NOT NULL,
  added_at_terminal VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id),
  CONSTRAINT fk_wttd_trans FOREIGN KEY (trans_id) REFERENCES web_tr_trans(trans_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS web_tr_trans_extra_hours (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  approved_by_user_id INT NOT NULL,
  approved_at_terminal VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id),
  CONSTRAINT fk_wtteh_trans FOREIGN KEY (trans_id) REFERENCES web_tr_trans(trans_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Antrian cetak. printer_target menentukan printer FISIK di terminal yang
-- sama (thermal 80x50 utk gudang, epson 2-ply utk billing/tagihan).
-- destination menentukan APAKAH dicetak lokal saat itu juga (local_qz) atau
-- lewat Layar Auto-Print di Komputer C/dapur (dapur_screen/bar_screen).
CREATE TABLE IF NOT EXISTS web_print_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  print_type ENUM('slip_gudang','billing_room','tiket_dapur','tiket_bar','tagihan_akhir') NOT NULL,
  printer_target ENUM('thermal','epson') NOT NULL DEFAULT 'thermal',
  destination ENUM('local_qz','dapur_screen','bar_screen') NOT NULL,
  status ENUM('pending','printed','failed') NOT NULL DEFAULT 'pending',
  payload_snapshot JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  printed_at DATETIME NULL,
  INDEX idx_trans (trans_id),
  INDEX idx_status_dest (status, destination)
) ENGINE=InnoDB;

-- Routing kategori produk: menentukan item kategori APA yang perlu tiket
-- dapur (dimasak) vs TIDAK (kategori "Bar" - minuman siap saji/beralkohol,
-- cukup diambil dari gudang, sudah tercakup di slip gudang, tidak perlu
-- tiket masak terpisah). Dikonfirmasi user 26 Agustus 2026: "yang dimaksud
-- dengan bar adalah gudang tersebut" - jadi bukan stasiun fisik terpisah,
-- cuma beda kategori barang.
--
-- Default needs_cooking = 1 (aman - dianggap perlu dimasak) untuk kategori
-- yang belum diisi manual di sini. Isi tabel ini sesuai kategori asli di
-- m_category (mis. kategori "Bar"/minuman siap saji -> needs_cooking = 0).
CREATE TABLE IF NOT EXISTS web_category_routing (
  category_id INT PRIMARY KEY,
  needs_cooking TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL
) ENGINE=InnoDB;

-- Notifikasi "Pesanan Siap" - dapur menekan tombol setelah selesai masak,
-- lalu muncul pop-up di komputer kasir (bukan papan/layar terpisah untuk
-- waiter - disederhanakan sesuai keputusan user 26 Agustus 2026).
CREATE TABLE IF NOT EXISTS web_order_ready_notify (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  room_id INT NOT NULL,
  message VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acked_at DATETIME NULL,
  INDEX idx_acked (acked_at)
) ENGINE=InnoDB;

-- Audit trail - siapa & terminal mana melakukan tiap aksi.
-- terminal_id di sini murni CATATAN, bukan pembatas kewenangan.
CREATE TABLE IF NOT EXISTS web_tr_trans_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trans_id VARCHAR(30) NOT NULL,
  action ENUM('buka_kamar','tambah_order','tambah_jam','tutup_kamar','batal') NOT NULL,
  user_id INT NOT NULL,
  terminal_id VARCHAR(50) NOT NULL,
  detail JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trans (trans_id)
) ENGINE=InnoDB;

-- Idempotency key: mencegah request yang terkirim ulang (retry) akibat
-- timeout/koneksi lambat menghasilkan baris transaksi/order DUPLIKAT.
-- Ditambahkan 26 Agustus 2026 setelah root cause bug "order duplikat" di
-- sistem lama dikonfirmasi: order terkirim ulang ke Komputer B saat jaringan
-- lambat (peak time), dan sistem lama tidak punya deteksi "sudah pernah
-- diterima" - lihat project doc diagnosis-sync-issue.md untuk detail.
--
-- Cara kerja: setiap kali frontend mengirim aksi Buka Kamar/Tambah
-- Order/Tutup Kamar, ia menyertakan 1 kode unik sekali-pakai (request_key,
-- dibuat di browser). Kalau request dengan kode yang sama sampai ke server
-- lagi (krn retry jaringan), server cukup mengembalikan hasil yang sudah
-- tersimpan dari percobaan pertama, TANPA mengulang proses insert -
-- menutup celah duplikat di level aplikasi, di luar row-locking yang sudah
-- ada (row-locking mencegah 2 TERMINAL BEDA bentrok; ini mencegah 1
-- request YANG SAMA diproses dua kali).
CREATE TABLE IF NOT EXISTS web_idempotency_key (
  endpoint VARCHAR(50) NOT NULL,
  request_key VARCHAR(64) NOT NULL,
  trans_id VARCHAR(30) NULL,
  response_snapshot JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (endpoint, request_key),
  INDEX idx_trans (trans_id)
) ENGINE=InnoDB;

-- Migration ini SENGAJA tidak membuat user admin default dengan password
-- hardcoded (menaruh hash password di file SQL yang ikut ter-commit/terkirim
-- bukan praktik yang aman). Setelah migration ini dijalankan, buat user
-- admin pertama dengan:
--
--   node server/utils/createAdmin.js <username> <password> "<Nama Lengkap>"
--
-- Script itu akan meng-hash password dengan bcrypt lalu INSERT ke web_users.
