-- =====================================================================
-- Migration 007 (29 Agustus 2026): Modul "F&B Hotel".
--
-- Dapur Grand Royal melayani karaoke DAN hotel (satu kawasan). Order F&B
-- hotel tadinya diketik lewat POS karaoke -> nilainya salah masuk omzet
-- karaoke. Modul ini memisahkannya: kasir karaoke memilih item dari katalog
-- yang SAMA (m_product) + mengetik nomor kamar hotel -> order tercatat di
-- tabel TERPISAH (bukan web_tr_trans), tiket dapur bertanda "HOTEL - Kamar X",
-- dan ada rekap harian per kamar untuk front desk posting ke folio.
--
-- Pembayaran: masuk tagihan kamar (folio), di-posting MANUAL oleh front desk
-- hotel. Item chiller (bayar di tempat) di luar cakupan v1 -> charge_mode
-- selalu 'folio'.
--
-- Service charge HOTEL bersifat INKLUSIF (beda dari karaoke yang aditif -
-- karaoke TIDAK diubah): harga menu = harga final. Komponen SC dihitung
-- mundur: sc_component = round(total * sc_pct / (100 + sc_pct)),
-- base_amount = total - sc_component. Front desk posting `total_amount`
-- apa adanya ke folio; SC hanya rincian info.
--
-- Waktu server DIANGGAP WIB. Jendela hari usaha memakai EOD_CUTOFF_HOUR
-- (config/report.js) - sama seperti laporan Tutup Hari karaoke.
--
-- Aman dijalankan ulang (CREATE TABLE IF NOT EXISTS + ALTER enum additive,
-- pola sama migration 002). Hanya tabel web_ baru + 1 ALTER enum
-- web_print_log. Tanpa FK ke web_tr_trans / m_product. Tidak menyentuh 154.
-- =====================================================================

-- Tambah jenis cetak slip arsip F&B hotel (di printer thermal kasir).
ALTER TABLE web_print_log
  MODIFY COLUMN print_type
    ENUM('slip_gudang','billing_room','tiket_dapur','tiket_bar','tagihan_akhir',
         'slip_retur','tiket_dapur_batal','slip_fnb_hotel') NOT NULL;

CREATE TABLE IF NOT EXISTS web_fnb_hotel_order (
  order_id             VARCHAR(30)  NOT NULL PRIMARY KEY,    -- HFB-YYYYMMDD-HHMMSS-XXXX
  unit_id              VARCHAR(30)  NOT NULL,                -- UNIT_ID deployment (unit penerbit / box karaoke)
  hotel_unit_id        VARCHAR(30)  NOT NULL,                -- HOTEL_UNIT_ID (unit pemilik pendapatan)
  hotel_room_no        VARCHAR(20)  NOT NULL,                -- teks bebas, mis. '214'
  cust_name            VARCHAR(100) NULL,
  charge_mode          ENUM('folio','cash') NOT NULL DEFAULT 'folio',
  total_amount         DECIMAL(12,2) NOT NULL,              -- total menu all-in (di-posting ke folio)
  sc_pct               DECIMAL(5,2)  NOT NULL DEFAULT 7.00, -- rate inklusif (info)
  sc_component         DECIMAL(12,2) NOT NULL,              -- round(total_amount * sc_pct / (100 + sc_pct))
  base_amount          DECIMAL(12,2) NOT NULL,              -- total_amount - sc_component
  status               ENUM('sent','cancelled') NOT NULL DEFAULT 'sent',
  note                 VARCHAR(255) NULL,
  created_by_user_id   INT          NOT NULL,
  created_at_terminal  VARCHAR(50)  NOT NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_by_user_id INT          NULL,
  cancelled_reason     VARCHAR(255) NULL,
  cancelled_at         DATETIME     NULL,
  INDEX idx_created (created_at),
  INDEX idx_room (hotel_room_no),
  INDEX idx_status_created (status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS web_fnb_hotel_order_details (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  order_id              VARCHAR(30)  NOT NULL,
  product_id            VARCHAR(25)  NOT NULL,
  product_name_snapshot VARCHAR(150) NOT NULL,
  qty                   INT          NOT NULL,
  price                 DECIMAL(12,2) NOT NULL,             -- harga menu all-in saat order
  subtotal              DECIMAL(12,2) NOT NULL,             -- price * qty
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  CONSTRAINT fk_wfhod_order FOREIGN KEY (order_id)
    REFERENCES web_fnb_hotel_order(order_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Snapshot rekap "Tutup Hari F&B Hotel" (cermin web_daily_close).
CREATE TABLE IF NOT EXISTS web_fnb_hotel_close (
  unit_id              VARCHAR(30)  NOT NULL,               -- HOTEL_UNIT_ID (pemilik pendapatan)
  business_date        DATE         NOT NULL,
  version              INT          NOT NULL DEFAULT 1,
  generated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_by_user_id INT          NULL,
  range_start          DATETIME     NOT NULL,
  range_end            DATETIME     NOT NULL,
  payload              JSON         NOT NULL,
  order_count          INT          NOT NULL DEFAULT 0,
  total_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  emailed_at           DATETIME     NULL,
  email_to             VARCHAR(500) NULL,
  email_error          VARCHAR(500) NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (unit_id, business_date),
  INDEX idx_business_date (business_date)
) ENGINE=InnoDB;
