# GR POS - Kasir Baru Grand Royal

Aplikasi kasir/billing baru untuk Grand Royal: satu database bersama, Komputer
A & B **simetris** (bisa melakukan aksi yang sama termasuk Buka Kamar), dengan
**row-level locking** yang menjamin dua terminal tidak bisa mengubah kamar
yang sama secara bersamaan. Lihat penjelasan lengkap desainnya di project doc
"desain-teknis-room-billing.md" dan "rencana-sistem-baru.md".

## Yang sudah ada di paket ini

- Backend Node.js/Express + MySQL (folder `server/`)
- Frontend vanilla JS (folder `public/`): login, dashboard kamar, buka kamar,
  detail transaksi, layar dapur, setelan printer per-terminal
- Migration SQL untuk semua tabel baru (`server/migrations/001_create_web_tables.sql`)
- Print via QZ Tray: struk billing di printer Epson (2-ply), slip
  gudang/tiket dapur di printer thermal
- Notifikasi "Pesanan Siap" (pop-up di komputer kasir)
- **Idempotency key** di Buka Kamar/Tambah Order/Tutup Kamar - kalau request
  yang sama terkirim ulang akibat timeout/koneksi lambat (persis pola yang
  menyebabkan bug "order duplikat" di sistem lama - lihat project doc
  `diagnosis-sync-issue.md`), server mengenali & mengembalikan hasil yang
  sama, TIDAK memproses ulang/menduplikasi data.
- **Sudah diverifikasi**: mekanisme locking diuji dengan skenario 2 terminal
  membuka kamar yang sama secara bersamaan - hasilnya konsisten (1 berhasil,
  1 ditolak, tidak ada data bentrok). Idempotency key di atas juga sudah
  diuji dgn skenario "request yang sama dikirim 2x" untuk ketiga endpoint -
  hasilnya konsisten, tidak ada baris duplikat.

## Yang BELUM ada / perlu dikerjakan sebelum go-live

- Laporan Keuangan, Manajemen Stok penuh (belum ada di MVP ini - fokus awal
  di alur Buka Kamar/Order/Tutup Kamar sesuai yang paling mendesak).
- Halaman Manajemen Member/Produk (untuk sekarang, dikelola langsung lewat
  tabel `m_member`/`m_product` yang sudah ada di database, sama seperti
  sistem lama).
- Setup sertifikat QZ Tray supaya tidak muncul popup izin tiap kali cetak
  (lihat bagian QZ Tray di bawah).
- **Isi tabel `web_category_routing`** sesuai kategori produk ASLI di
  `m_category` (lihat langkah 4 di bawah) - kalau dilewati, semua item
  default dianggap "perlu dimasak" (aman, tapi item kategori Bar akan
  dapat tiket dapur juga, bukan salah, cuma redundan).

---

## 1. Persiapan server

Server ini dipasang di **satu komputer** di LAN Grand Royal (bisa di
Komputer Server Lagu yang sudah ada, atau komputer lain yang selalu
menyala) - komputer A, B, C semuanya mengakses lewat browser ke alamat
komputer ini.

Butuh **Node.js 18+** terpasang di komputer server itu. Cek dengan:

```
node -v
```

Kalau belum ada, download dari https://nodejs.org (pilih versi LTS).

## 2. Install

Salin folder `gr-pos` ini ke komputer server, lalu di dalam foldernya:

```
npm install
cp .env.example .env
```

Edit `.env` sesuai kondisi database `bintangnew` yang sudah ada (host,
user, password MySQL). Kalau server ini dipasang di komputer yang sama
dengan MySQL `bintangnew`, `DB_HOST=localhost` biasanya sudah benar.

**WAJIB**: ganti `JWT_SECRET` di `.env` dengan string acak yang panjang
(jangan pakai contoh bawaan).

## 3. Migration database

Jalankan SQL ini di database `bintangnew` (lewat phpMyAdmin, HeidiSQL,
atau `mysql` CLI) - **HANYA membuat tabel baru berprefix `web_`, tidak
mengubah tabel app lama sama sekali**:

```
mysql -u root -p bintangnew < server/migrations/001_create_web_tables.sql
```

(Kalau mau mencoba dulu di database KOSONG/laptop developer sebelum ke
server sungguhan, jalankan juga `server/migrations/dev_seed_master_data.sql`
- **JANGAN dijalankan di database `bintangnew` produksi**, karena itu
sudah punya data master asli.)

## 4. Isi tabel `web_category_routing`

Supaya item yang perlu dimasak (dapur) dan yang tidak (kategori "Bar" -
minuman siap saji/beralkohol, cukup ambil dari gudang) ke-routing dengan
benar, isi tabel ini sesuai `category_id` ASLI di `m_category` produksi:

```sql
-- Contoh - SESUAIKAN category_id dengan yang sebenarnya di database Anda
SELECT category_id, category_name FROM m_category; -- lihat dulu daftarnya

INSERT INTO web_category_routing (category_id, needs_cooking, note) VALUES
  (1, 1, 'Makanan - perlu dimasak'),
  (2, 0, 'Bar/minuman siap saji - cukup dari gudang')
ON DUPLICATE KEY UPDATE needs_cooking = VALUES(needs_cooking);
```

Kategori yang belum diisi di tabel ini default dianggap `needs_cooking = 1`
(aman - tetap dapat tiket dapur).

## 5. Buat user pertama (admin)

```
node server/utils/createAdmin.js admin PasswordKuatAnda "Nama Admin" admin
```

Bisa dipakai berulang untuk membuat user lain (kasir, dapur, dst):

```
node server/utils/createAdmin.js kasir1 Password123 "Budi Kasir" kasir
node server/utils/createAdmin.js dapur1 Password123 "Dapur 1" dapur
```

Role yang tersedia: `admin`, `supervisor`, `kasir`, `dapur`, `waiter`.

## 6. Jalankan server

```
npm start
```

Server jalan di `http://localhost:4000` (atau port lain kalau diganti di
`.env`). Dari Komputer A/B/C, buka browser ke `http://<IP-komputer-server>:4000`
(cari IP-nya dengan `ipconfig` di Windows komputer server).

Supaya server otomatis nyala lagi kalau komputer restart, disarankan
pakai [PM2](https://pm2.keymetrics.io/) atau Windows Task Scheduler -
di luar scope README ini, tanya kalau butuh bantuan setup-nya.

## 6b. Sinkronisasi player room ke server LAMA (154)

Aplikasi pemutar lagu di dalam room polling `m_room.is_active` di MySQL
**server lama (10.0.0.154)** - room "menyala" saat `is_active = '1'`. Karena
gr-pos jalan di Server02 dgn database `bintangnew` terpisah, buka/tutup/batal
kamar (non Mode-Test) **mengantre** perintah ke tabel `web_room_player_outbox`
(migration `003`), lalu worker latar mengirim `UPDATE m_room SET is_active=?,
last_update=NOW()` ke 154 dengan retry. Kalau 154/jaringan mati, transaksi
kasir **tetap sukses**; perintah menyusul saat 154 pulih.

Aktifkan di `.env` (isi `LEGACY_DB_*`, set `ROOM_PLAYER_SYNC=on`). Set
`ROOM_PLAYER_SYNC=off` untuk mematikan sinkronisasi (kill-switch / dev) -
gr-pos tetap jalan, kembali ke cara manual (UPDATE lewat Navicat).

Buat user MySQL khusus di **server 154** (hak minimal, JANGAN pakai `root`):

```sql
CREATE USER 'grpos_sync'@'<IP_SERVER02>' IDENTIFIED BY '<password-kuat>';
GRANT SELECT (room_id, is_active), UPDATE (is_active, last_update)
  ON bintangnew.m_room TO 'grpos_sync'@'<IP_SERVER02>';
FLUSH PRIVILEGES;
```

Override manual (pengganti UPDATE Navicat): `POST /api/rooms/:id/player`
`{ "state": "on"|"off" }` - khusus admin/supervisor.

Masa transisi: gr-pos hanya mengubah `is_active` untuk room yang punya
transaksi aktif miliknya; menolak membuka room yang sudah `is_active='1'`
di 154 (dipegang sistem lama); reconcile hanya **menyalakan**, tak pernah
mematikan. Satu room jangan dilayani old-POS & new-POS bersamaan.

## 7. Setup QZ Tray (WAJIB untuk cetak) - di SETIAP komputer A, B, C

1. Install QZ Tray dari https://qz.io/download/ di komputer itu (gratis).
2. Pastikan QZ Tray jalan di background (ada ikon di system tray Windows).
3. Buka halaman POS ini di browser komputer itu, login, lalu buka menu
   **Setelan Printer** (`/settings.html`).
4. Isi nama printer PERSIS seperti yang muncul di "Devices and Printers"
   Windows:
   - Komputer A & B: isi **nama printer Epson** (utk billing/tagihan, 2-ply)
     dan **nama printer thermal** (utk slip gudang).
   - Komputer C (dapur): isi nama printer thermal saja (dapur cuma
     mencetak tiket dapur).
5. Coba Buka Kamar sekali dari komputer itu - QZ Tray akan menampilkan
   popup "Allow/Block" pertama kali, pilih **Allow** (dan centang
   "remember" kalau tersedia).

Kalau LAN Grand Royal tidak selalu tersambung internet, `qz-tray.js`
(library yang dipakai halaman-halaman ini, dimuat dari CDN) perlu
di-download manual dari https://github.com/qzind/tray/releases dan
ditaruh di `public/vendor/qz-tray.js`, lalu ganti baris:

```html
<script src="https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js"></script>
```

menjadi:

```html
<script src="/vendor/qz-tray.js"></script>
```

di file `orders.html`, `room-detail.html`, `checkout.html`, dan `dapur.html`.

(Opsional, disarankan untuk produksi) Setup sertifikat digital QZ Tray
supaya popup "Allow/Block" tidak muncul terus-menerus - lihat dokumentasi
resmi QZ Tray bagian "Custom signing certificate". Di luar scope kode ini
karena spesifik per instalasi.

## 8. Alur pemakaian sehari-hari

Tampilan mengikuti desain gelap/neon yang diberikan (sidebar navigasi,
kartu kamar dengan timer, katalog produk bergambar, keranjang order,
layar checkout dengan pilihan metode bayar):

- **Kasir** (Komputer A atau B, sama saja): login → **Dashboard** (grid
  kamar dengan status warna: hijau=kosong, pink=terpakai, kuning=sedang
  diproses terminal lain, abu=maintenance) → klik kamar kosong → masuk ke
  **Orders** (katalog menu bergambar + keranjang di kanan) → isi nama
  tamu/jumlah orang/member → tambah item → "Buka Kamar & Cetak Struk" →
  2 struk otomatis tercetak (thermal gudang + Epson billing) di komputer
  yang dipakai → diarahkan ke **Detail Pesanan Ruangan** (timer sesi,
  riwayat order, tambah item cepat, "+ Add Time"). Tekan **Settle Bill**
  untuk ke halaman **Checkout** (ringkasan tagihan + pilih metode bayar
  Cash/QRIS/Card/Member + hitung kembalian) → "Process Payment" mencetak
  tagihan akhir & membebaskan kamar.
- **Dapur** (Komputer C): buka halaman `/dapur.html`, biarkan terbuka
  seharian - tiket baru otomatis muncul & tercetak. Tekan "Tandai Siap"
  setelah selesai masak → pop-up muncul di komputer kasir manapun yang
  login.
- **Admin/Supervisor**: bisa set kamar Maintenance/Rusak, dan Batalkan
  transaksi kalau perlu.
- **Mode Test = tes fisik room** (kasir/waiter/supervisor/admin): centang di
  layar Sesi Baru. Room dibuka & **player di sistem lama (154) DINYALAKAN**
  supaya staf bisa masuk mencoba lagu & mic sebelum tamu datang. Threshold &
  pembayaran dilewati, tidak ada struk/tiket/stok, tidak masuk omzet. Player
  dimatikan saat "Selesai Tes" di layar Detail Ruangan, atau otomatis setelah
  `TEST_MODE_MINUTES` menit (default 15). Room yang sedang dites tidak bisa
  langsung dibooking - akhiri tesnya dulu.
- **VIP / VVIP** (di layar Sesi Baru, pilihan "Tarif Kamar"): buka kamar
  TANPA minimum F&B. Wajib password admin/supervisor. Sesi tetap nyata
  (player nyala, struk & tiket tercetak, stok bergerak, tagihan akhir
  menagih konsumsi asli). VVIP dapat alokasi `COMP_DEFAULT_HOURS` jam
  (default 12, bisa diperpanjang lewat "+ Add Time"); VIP diisi batas
  jamnya oleh kasir. Nilai "komplimen" (threshold yang ditanggung) +
  jumlah jam komplimen muncul di laporan Tutup Hari.
- **Promo** (halaman `/promo.html`, admin/supervisor) auto-apply server saat
  buka kamar / tambah order kalau sedang berlaku (tanggal + jam + hari):
  - **B1G1** - beli N produk yang sama, gratis M.
  - **Paket Harga** - beli satu set komponen, subtotalnya diganti harga paket.
  - **Hadiah Check-in** - dalam window promo, tamu dapat 1 produk gratis
    (mis. tahu) saat Buka Kamar. Bila "wajib kartu ID" dicentang di promo,
    kasir harus mencentang "Tamu menunjukkan kartu ID" di layar Sesi Baru.
    Item hadiah tetap dibuatkan tiket dapur/slip gudang & mengurangi stok,
    tapi tidak menambah tagihan atau alokasi waktu karaoke.

Nav sidebar "Inventory" dan "Reports" tampil untuk konsistensi visual
tapi halamannya masih placeholder ("segera hadir") - belum termasuk MVP.

## 9. Struktur folder

```
gr-pos/
  server/
    config/db.js              - koneksi MySQL + helper transaction+locking
    middleware/                - auth (JWT), error handler
    routes/                     - semua endpoint API
    services/                   - logika threshold & antrian print
    utils/                       - generator ID transaksi, script buat user
    migrations/                  - SQL migration + seed dev/test
    server.js                    - entry point
  public/
    index.html                   - login
    dashboard.html                - Room Monitor (grid kamar + timer + status)
    orders.html                   - Katalog menu + keranjang (sesi baru & tambah order)
    room-detail.html              - Detail pesanan ruangan (timer, riwayat, tambah cepat)
    checkout.html                 - Pembayaran (ringkasan, metode bayar, kembalian)
    dapur.html                    - Layar auto-print dapur (Komputer C)
    settings.html                 - Setelan nama printer per-terminal
    coming-soon.html              - placeholder utk Inventory/Reports (belum di MVP)
    buka-kamar.html, trans.html   - file lama, sekarang cuma redirect ke halaman baru
    js/api.js                    - wrapper panggilan API
    js/layout.js                  - sidebar+topbar bersama & ikon SVG
    js/qz-print.js                - modul cetak lokal via QZ Tray
    css/theme.css                 - tema gelap/neon (warna, kartu, grid, dst)
  .env.example
  package.json
```

## 10. Keamanan & catatan penting

- Password user di-hash dengan bcrypt (tabel `web_users`), bukan plaintext
  seperti `m_user` sistem lama.
- `terminal_id` (nama komputer, diisi bebas oleh kasir saat login) HANYA
  untuk catatan/audit trail - BUKAN pembatas hak akses. Hak akses
  ditentukan oleh `role` user.
- Mekanisme locking (mencegah 2 terminal mengubah kamar yang sama
  bersamaan) sudah diverifikasi bekerja dengan benar - lihat penjelasan
  di project doc "desain-teknis-room-billing.md" bagian 2.
- Sebelum dipakai sungguhan, TES DULU di jam sepi / dengan data uji coba
  sebelum sepenuhnya menggantikan sistem lama, terutama karena
  `m_room.status` ikut ditulis oleh app baru ini (field yang sama yang
  dipakai app lama) - lihat kode status di `server/routes/trans.routes.js`
  (`ROOM_STATUS_AVAILABLE`/`ROOM_STATUS_OCCUPIED`) dan SESUAIKAN dengan
  kode status yang sebenarnya dipakai di data `m_room` production Anda
  kalau berbeda dari asumsi awal ('1'=kosong, '2'=terpakai).
