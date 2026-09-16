# GR POS - Kasir/Billing Multi-Modul

Aplikasi kasir/billing untuk venue karaoke + F&B (dikembangkan awal untuk
Grand Royal, ditulis supaya bisa dipakai unit lain di grup dengan database
masing-masing - lihat bagian "Multi-unit" di bawah). Satu database per unit,
terminal-terminal di LAN yang sama **simetris** (bisa melakukan aksi yang
sama termasuk Buka Kamar), dengan **row-level locking** yang menjamin dua
terminal tidak bisa mengubah kamar yang sama secara bersamaan.

## Modul yang tersedia

- **Room billing**: Dashboard grid kamar (status warna), Buka Kamar/Tambah
  Order/Tutup Kamar, Mode Test (coba fisik room tanpa billing), room
  komplimen VIP/VVIP, "+ Add Time" (waktu flat 2 jam per kelipatan threshold
  + penyesuaian manual jam/menit oleh admin/supervisor).
- **Pembayaran per-order ("pay-per-order")**: setiap order (buka kamar &
  tambah item) dibayar tuntas saat itu juga; Checkout/Settle Bill di akhir
  sesi hanya jadi **rekap & tutup kamar**, tidak memproses pembayaran lagi.
  Harga produk sudah inklusif Service Charge (+ Pajak Restoran/PB1 kalau
  `RESTO_TAX_PCT` > 0) - lihat `server/config/billing.js`. Item kategori
  Rokok bebas SC & Pajak Restoran.
- **F&B Hotel**: kasir karaoke input order room-service tamu hotel, tercatat
  terpisah dari omzet karaoke, dengan rekap harian per kamar (halaman +
  email) ke front desk.
- **Produk & Promo**: katalog produk, promo auto-apply saat buka kamar/tambah
  order (B1G1, Paket Harga, Hadiah Check-in dengan opsi wajib cek ID).
- **Inventory**: stok per unit/gudang, catat mutasi, **Stock Opname**
  (submit langsung diterapkan + email ke gudang, migration 020), laporan
  "Rencana Kirim" (proyeksi kebutuhan restock berbasis kecepatan pemakaian).
- **Pengeluaran**: form pengeluaran per kuitansi (tanggal, vendor, total,
  catatan, link bukti transfer) + QR code yang mengarah ke folder
  penyimpanan bukti (Google Drive/Synology/dll - lihat `RECEIPT_FOLDER_URL`
  di `public/pengeluaran.html`) supaya kasir tinggal scan dari HP dan
  upload foto langsung.
- **Tutup Kasir (shift)**: buka/tutup shift per kasir, rekonsiliasi kas
  (modal awal vs kas fisik dihitung).
- **Reports**: Tutup Hari / End-of-Day (rekap finansial harian, email
  otomatis ke `EOD_REPORT_RECIPIENTS` setelah jam cutoff), dengan toggle
  tampilan Ringkas (finance) / Lengkap.
- **Laporan Void**: rekap item yang di-void/ditukar, dikelompokkan per sesi
  kasir yang membuka. Void hanya bisa dilakukan login admin.
- **Analitik**: dashboard KPI manajemen (omzet per hari, heatmap jam×hari,
  produk tercepat/terlambat laku, insight otomatis).
- **Role & menu**: role `admin`/`supervisor`/`kasir`/`waiter`/`dapur`/
  `gudang`. Menu sidebar disaring per role di `public/js/layout.js`
  (`ROLE_NAV`) - mis. `gudang` hanya melihat Inventory, `kasir` hanya
  Dashboard/Orders/F&B Hotel/Tutup Kasir.
- **Tema**: dark (default) + light, toggle di sidebar, tersimpan per-browser.
- **Idempotency key** di Buka Kamar/Tambah Order/Tutup Kamar - request yang
  sama terkirim ulang (timeout/koneksi lambat) tidak diproses dua kali.
- **Sinkronisasi opsional ke pusat**: `web_sync_outbox` (per modul: stock,
  expense, daily_close) bisa dikirim ke webhook n8n pusat kalau
  `SYNC_SENDER_ENABLED=on` - lihat bagian "Multi-unit" di bawah.

Beberapa modul (room billing karaoke, sinkron player ke server lagu lama)
memang spesifik venue karaoke - kalau unit tujuan bukan karaoke, modul itu
tinggal tidak dipakai/di-nonaktifkan lewat `.env` (`ROOM_PLAYER_SYNC=off`)
tanpa mengganggu modul lain (Inventory, Pengeluaran, Reports, dst berlaku
generik untuk tipe usaha apa pun).

---

## 1. Persiapan server

Server ini dipasang di **satu komputer** di LAN unit (server yang selalu
menyala) - semua terminal kasir mengakses lewat browser ke alamat komputer
ini.

Butuh **Node.js 18+** dan **MySQL/MariaDB** terpasang di komputer server itu.

```
node -v
```

Kalau belum ada, download dari https://nodejs.org (pilih versi LTS).

### Install MariaDB (kalau belum ada MySQL/MariaDB di komputer server)

**Windows** (cara tercepat, lewat winget):

```
winget install MariaDB.Server
```

Cek jalan dengan (sesuaikan path versi hasil install):

```
"C:\Program Files\MariaDB <versi>\bin\mysql.exe" -u root -e "SELECT 1"
```

**Penting - dua gotcha yang sering kejadian di instalasi baru:**

- Installer silent winget **tidak selalu otomatis mendaftarkan Windows
  Service** - kalau `mysql -u root` di atas gagal connect, daftarkan manual
  lewat PowerShell **as Administrator**:
  ```
  "C:\Program Files\MariaDB <versi>\bin\mysqld.exe" --install MariaDB --datadir="C:\Program Files\MariaDB <versi>\data"
  net start MariaDB
  ```
  (atau jalankan manual tanpa service: `mariadbd.exe --datadir="...\data" --console`,
  tapi ini mati kalau komputer restart - service lebih baik untuk produksi).
- User `root` bawaan **tidak punya password**. Untuk produksi, set password
  root lalu isi `DB_PASSWORD` di `.env` (jangan biarkan kosong):
  ```
  "C:\Program Files\MariaDB <versi>\bin\mysqladmin.exe" -u root password "PasswordKuatAnda"
  ```

**Linux** (Ubuntu/Debian): `sudo apt install mariadb-server` lalu
`sudo mysql_secure_installation` untuk set password root.

Setelah MariaDB jalan, buat database kosong untuk unit ini (sesuaikan nama
dengan `DB_NAME` yang akan diisi di `.env` langkah berikutnya):

```
mysql -u root -p -e "CREATE DATABASE nama_database_unit CHARACTER SET utf8mb4"
```

## 2. Install

Salin folder `gr-pos` ini ke komputer server, lalu di dalam foldernya:

```
npm install
cp .env.example .env
```

Edit `.env` sesuai kondisi database unit ini (host, user, password). Kalau
server ini dipasang di komputer yang sama dengan databasenya,
`DB_HOST=localhost` biasanya sudah benar.

**WAJIB** diisi/diganti per unit (jangan pakai nilai contoh):

- `JWT_SECRET` - string acak yang panjang & rahasia, beda tiap unit.
- `DB_NAME`, `DB_USER`, `DB_PASSWORD` - sesuai database unit ini.
- `UNIT_ID`, `UNIT_NAME`, `WAREHOUSE_ID` - identitas unit ini (dicetak di
  struk & laporan, jadi stempel data kalau kelak dikonsolidasi ke sistem
  pusat grup). Kalau unit ini juga punya modul F&B Hotel: `HOTEL_UNIT_ID`,
  `HOTEL_NAME` juga.
- `EOD_REPORT_RECIPIENTS`, `HOTEL_FNB_RECIPIENTS` - email penerima laporan
  unit ini (bukan email unit lain).
- `SMTP_*` - kalau unit ini mau mengirim laporan lewat email sendiri.

Semua variabel lain di `.env.example` sudah dikomentari penjelasannya
masing-masing (mode tagihan, sinkron player lama, sinkron ke pusat, dst) -
default-nya aman untuk instalasi baru (fitur opsional dimatikan sampai
sengaja dinyalakan).

## 3. Migration database

Jalankan seluruh file di `server/migrations/` **berurutan sesuai nomor**
(001 sampai nomor terbesar) di database unit ini - migration hanya membuat
tabel baru berprefix `web_` (kecuali disebutkan lain di komentar filenya),
tidak mengubah tabel app lama:

```
for f in server/migrations/0*.sql; do mysql -u root -p namadatabase < "$f"; done
```

(atau jalankan satu-satu lewat phpMyAdmin/HeidiSQL kalau lebih nyaman -
urutannya tetap harus sesuai nomor karena migration belakangan bisa
bergantung pada kolom/tabel dari migration sebelumnya).

`server/migrations/dev_seed_master_data.sql` **HANYA** untuk mencoba di
database kosong/laptop developer - **JANGAN** dijalankan di database
produksi yang sudah punya data master asli.

## 4. Isi tabel `web_category_routing` (kalau pakai alur dapur)

Supaya item yang perlu dimasak (dapur) dan yang tidak (mis. kategori
"Bar"/minuman siap saji) ke-routing dengan benar, isi tabel ini sesuai
`category_id` ASLI di `m_category` unit ini:

```sql
SELECT category_id, category_name FROM m_category; -- lihat dulu daftarnya

INSERT INTO web_category_routing (category_id, needs_cooking, note) VALUES
  (1, 1, 'Makanan - perlu dimasak'),
  (2, 0, 'Bar/minuman siap saji - cukup dari gudang')
ON DUPLICATE KEY UPDATE needs_cooking = VALUES(needs_cooking);
```

Kategori yang belum diisi di tabel ini default `needs_cooking = 1` (aman -
tetap dapat tiket dapur).

## 5. Buat user pertama (admin)

```
node server/utils/createAdmin.js admin PasswordKuatAnda "Nama Admin" admin
```

Bisa dipakai berulang untuk membuat user lain:

```
node server/utils/createAdmin.js kasir1 Password123 "Budi Kasir" kasir
node server/utils/createAdmin.js dapur1 Password123 "Dapur 1" dapur
node server/utils/createAdmin.js gudang1 Password123 "Gudang 1" gudang
```

Role yang tersedia: `admin`, `supervisor`, `kasir`, `dapur`, `waiter`,
`gudang`.

## 6. Jalankan server

```
npm start
```

Server jalan di `http://localhost:4000` (atau port lain sesuai `APP_PORT`
di `.env`). Dari komputer kasir lain, buka browser ke
`http://<IP-komputer-server>:4000`.

Supaya server otomatis nyala lagi kalau komputer restart (Windows), lihat
`ops/service/README.md` - skrip NSSM untuk daftarkan sebagai Windows
Service.

## 6b. Sinkronisasi player room ke server lama (khusus venue karaoke)

**Lewati bagian ini kalau unit ini bukan venue karaoke / tidak punya sistem
player lagu terpisah.**

Aplikasi pemutar lagu di dalam room (kalau ada) biasanya polling
`m_room.is_active` di MySQL **server lama terpisah**. Kalau gr-pos jalan
dengan database sendiri yang terpisah dari server lagu itu, buka/tutup/batal
kamar (non Mode-Test) **mengantre** perintah ke tabel
`web_room_player_outbox` (migration `003`), lalu worker latar mengirim
`UPDATE m_room SET is_active=?, last_update=NOW()` ke server lama itu dengan
retry. Kalau server lama/jaringan mati, transaksi kasir **tetap sukses**;
perintah menyusul saat server lama pulih.

Aktifkan di `.env` (isi `LEGACY_DB_*`, set `ROOM_PLAYER_SYNC=on`). Biarkan
`ROOM_PLAYER_SYNC=off` (default) kalau tidak berlaku untuk unit ini.

Buat user MySQL khusus di **server lama** (hak minimal, JANGAN pakai
`root`):

```sql
CREATE USER 'grpos_sync'@'<IP_SERVER_GRPOS>' IDENTIFIED BY '<password-kuat>';
GRANT SELECT (room_id, is_active), UPDATE (is_active, last_update)
  ON namadatabase.m_room TO 'grpos_sync'@'<IP_SERVER_GRPOS>';
FLUSH PRIVILEGES;
```

Override manual: `POST /api/rooms/:id/player` `{ "state": "on"|"off" }` -
khusus admin/supervisor.

## 7. Setup QZ Tray (WAJIB untuk cetak struk fisik) - di SETIAP komputer kasir

1. Install QZ Tray dari https://qz.io/download/ di komputer itu (gratis).
2. Pastikan QZ Tray jalan di background (ada ikon di system tray Windows).
3. Buka halaman POS ini di browser komputer itu, login, lalu buka menu
   **Settings** (`/settings.html`).
4. Isi nama printer PERSIS seperti yang muncul di "Devices and Printers"
   Windows (printer billing/tagihan + printer thermal gudang/dapur, sesuai
   printer yang tersedia di komputer itu).
5. Coba transaksi sekali dari komputer itu - QZ Tray akan menampilkan popup
   "Allow/Block" pertama kali, pilih **Allow** (centang "remember" kalau
   tersedia).

Kalau LAN unit tidak selalu tersambung internet, `qz-tray.js` (dimuat dari
CDN di beberapa halaman) perlu di-download manual dari
https://github.com/qzind/tray/releases dan ditaruh di
`public/vendor/qz-tray.js`, lalu ganti baris CDN-nya menjadi
`<script src="/vendor/qz-tray.js"></script>` di file `orders.html`,
`room-detail.html`, `checkout.html`, dan `dapur.html`.

(Opsional, disarankan untuk produksi) Setup sertifikat digital QZ Tray
supaya popup "Allow/Block" tidak muncul terus-menerus - lihat dokumentasi
resmi QZ Tray bagian "Custom signing certificate".

## 8. Alur pemakaian sehari-hari

- **Kasir**: login → **Dashboard** (grid kamar dengan status warna:
  hijau=kosong, ungu=terpakai, kuning=diproses terminal lain,
  abu=maintenance) → klik kamar kosong → **Orders** (katalog menu + keranjang)
  → isi nama tamu/jumlah orang/member → tambah item → "Buka Kamar & Cetak
  Struk" (pembayaran diproses saat itu juga, struk tercetak) → diarahkan ke
  **Detail Ruangan** (timer sesi, riwayat order, tambah item cepat - tiap
  tambahan dibayar saat itu juga - , "+ Add Time"). Tekan **Settle Bill**
  di akhir sesi untuk ke halaman **Checkout**, yang sekarang berfungsi
  sebagai **rekap & tutup kamar** ("Cetak Rekap & Close Room") - bukan
  pemrosesan pembayaran lagi, karena semua sudah dibayar per order.
- **Dapur**: buka halaman `/dapur.html`, biarkan terbuka seharian - tiket
  baru otomatis muncul & tercetak. Tekan "Tandai Siap" setelah selesai
  masak → pop-up muncul di komputer kasir manapun yang login.
- **Gudang**: role `gudang` hanya melihat menu **Inventory** (stok +
  laporan Rencana Kirim + Stock Opname).
- **Admin/Supervisor**: akses penuh semua menu (Produk, Promo, Inventory,
  Pengeluaran, Tutup Kasir, Reports, Laporan Void, Analitik, Settings), bisa
  set kamar Maintenance/Rusak, void/tukar item, dan set kamar VIP/VVIP.
- **Mode Test** (kasir/waiter/supervisor/admin): centang di layar Sesi Baru
  untuk tes fisik room (nyalakan player, tanpa billing/stok/struk, tidak
  masuk omzet) - otomatis berakhir setelah `TEST_MODE_MINUTES` menit.
- **VIP/VVIP** (pilihan "Tarif Kamar" di Sesi Baru): buka kamar tanpa
  minimum F&B, wajib password admin/supervisor. Sesi tetap nyata (stok
  bergerak, struk tercetak, dsb).
- **Promo** (`/promo.html`, admin/supervisor): auto-apply saat buka
  kamar/tambah order kalau sedang berlaku - B1G1, Paket Harga, Hadiah
  Check-in.

## 9. Struktur folder

```
gr-pos/
  server/
    config/       - konfigurasi terpusat (billing, unit, hotel, opname, dst)
    middleware/    - auth (JWT), error handler
    routes/        - semua endpoint API (lihat prefix di server.js)
    services/      - logika bisnis (bill, promo, stock, EOD, cashier shift,
                     sinkron outbox/legacy, dst)
    utils/          - generator ID transaksi, script buat admin, seed demo
    migrations/     - SQL migration berurutan (001, 002, ...) + seed dev
    server.js       - entry point
  public/
    index.html                    - login
    dashboard.html                 - Room Monitor
    orders.html                    - Katalog menu + keranjang
    room-detail.html               - Detail ruangan (timer, riwayat, +Add Time)
    checkout.html                  - Rekap & tutup kamar
    dapur.html                     - Layar auto-print dapur
    fnb-hotel.html / -report.html  - F&B Hotel (input + rekap harian)
    products.html, promo.html      - Manajemen produk & promo
    inventory.html                 - Stok + Stock Opname + Rencana Kirim
    pengeluaran.html                - Input pengeluaran + QR upload bukti
    tutup-kasir.html                - Buka/tutup shift kasir
    reports.html                    - Tutup Hari / EOD
    laporan-void.html               - Rekap void per sesi kasir
    analitik.html                   - Dashboard KPI manajemen
    settings.html                   - Setelan nama printer per-terminal
    opname-signer.html              - Alat generate keypair approval opname (idle)
    js/api.js                       - wrapper panggilan API
    js/layout.js                    - sidebar+topbar bersama, ROLE_NAV/ROLE_HOME
    js/qz-print.js, receipt-print.js - modul cetak lokal via QZ Tray
    js/theme-boot.js                - dark/light theme sebelum render
    css/theme.css                    - tema (warna, kartu, grid, dst)
  ops/service/    - skrip NSSM utk daftarkan sbg Windows Service (opsional)
  .env.example
  package.json
```

## 10. Multi-unit / sinkron ke pusat (opsional)

Skema `web_product_stock`, `web_stock_movement`, `web_sync_outbox`, dsb
sudah men-stamp `unit_id`/`warehouse_id` (isi dari `.env`) supaya siap
dikonsolidasikan ke sistem pusat grup. Ini **opsional dan mati secara
default**:

- `SYNC_OUTBOX_ENABLED=on` - tiap mutasi (stok, pengeluaran, tutup hari)
  ditulis juga sebagai baris `web_sync_outbox` (belum dikirim ke mana pun).
- `SYNC_SENDER_ENABLED=on` + `SYNC_INGEST_URL` - worker
  `outboxSender.service.js` mengirim baris yang menumpuk itu ke webhook
  n8n pusat secara berkala.

Selama kedua flag ini `off`, gr-pos berjalan sepenuhnya independen per unit
(tidak ada data yang keluar dari database unit itu sendiri).

## 11. Keamanan & catatan penting

- Password user di-hash dengan bcrypt (tabel `web_users`).
- `terminal_id` (nama komputer, diisi bebas oleh kasir saat login) HANYA
  untuk catatan/audit trail - BUKAN pembatas hak akses. Hak akses
  ditentukan oleh `role` user.
- Mekanisme locking (mencegah 2 terminal mengubah kamar yang sama
  bersamaan) sudah diverifikasi bekerja dengan skenario 2 terminal membuka
  kamar yang sama secara bersamaan.
- Sebelum dipakai sungguhan di unit baru, TES DULU di jam sepi / dengan
  data uji coba, terutama karena `m_room.status` ikut ditulis oleh app ini
  (field yang sama yang mungkin dipakai app lama kalau migrasi bertahap) -
  lihat kode status di `server/routes/trans.routes.js`
  (`ROOM_STATUS_AVAILABLE`/`ROOM_STATUS_OCCUPIED`) dan SESUAIKAN dengan
  kode status yang sebenarnya dipakai di data `m_room` unit ini kalau
  berbeda dari asumsi awal ('1'=kosong, '2'=terpakai).
- Jangan commit `.env` atau file `.env.backup*` apa pun ke repo ini - lihat
  `.gitignore`. Tiap unit punya kredensial & secret sendiri.
