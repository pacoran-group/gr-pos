# Instalasi unit satu-langkah (`Install-Unit.ps1`)

Otomatisasi bagian 2-5 di README utama (`../../README.md`) untuk **Jalur A**
(unit yang sudah punya aplikasi + database lama - lihat README bagian 1):
`npm install`, buat `.env`, jalankan semua migration `server/migrations/0*.sql`
berurutan, jalankan preflight check, lalu (opsional) buat user admin pertama.

Skrip ini **tidak pernah memindahkan/mengekspor data unit ke mana pun** -
dia connect ke database lama yang sudah ada DI SERVER ITU JUGA dan hanya
menambahkan tabel baru (`CREATE TABLE IF NOT EXISTS`, tidak menyentuh
tabel lama). Tidak perlu dump, tidak perlu Navicat, tidak perlu akses
remote dari luar unit.

## Sebelum menjalankan

- Node.js 18+ & MariaDB/MySQL sudah terpasang dan JALAN di komputer server
  unit ini (lihat README bagian 1 untuk cara install MariaDB kalau belum
  ada).
- **Tahu nama database aplikasi lama unit ini** (kalau ragu, tanya dulu ke
  admin/vendor aplikasi lama unit itu, atau cek langsung:
  `mysql -u root -p -e "SHOW DATABASES"`).
- User & password MySQL/MariaDB yang boleh akses database itu (root boleh,
  atau user khusus dengan hak `CREATE, ALTER, INSERT, SELECT` di database
  itu saja - lebih aman kalau kredensial ini tidak dipakai di tempat lain).

## Jalankan

```powershell
cd "E:\Kasir GR\gr-pos\ops\install"
powershell -ExecutionPolicy Bypass -File .\Install-Unit.ps1
```

Skrip akan bertanya interaktif: nama database, user/password DB (diminta
SEKALI, disimpan sementara di file lokal yang otomatis terhapus di akhir,
tidak pernah tampil di layar), lalu identitas unit (`UNIT_ID`, `UNIT_NAME`,
dst) kalau `.env` belum ada.

Kalau mau langsung isi sebagian jawaban lewat parameter (skrip tetap
menanyakan sisanya):

```powershell
.\Install-Unit.ps1 -DbName bintangnew_cibubur -DbUser root -MySqlBin "C:\Program Files\MariaDB 12.3\bin"
```

## Kalau gagal di tengah jalan

Aman diulang - semua langkah SQL pakai `IF NOT EXISTS`/idempotent. Perbaiki
sesuai pesan error (skrip berhenti di langkah yang gagal, tidak lanjut ke
langkah berikutnya), lalu jalankan ulang skrip yang sama.

## Setelah selesai

- `npm start` untuk menyalakan server (lihat README bagian 6).
- `..\service\README.md` untuk daftarkan sebagai Windows Service (auto-start
  saat komputer restart).
- README bagian 7 untuk setup QZ Tray (cetak struk) di tiap komputer kasir.
- README bagian 4 untuk isi `web_product_routing` (routing dapur) kalau
  unit ini pakai alur dapur.
