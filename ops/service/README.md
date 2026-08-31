# gr-pos sebagai Windows Service (auto-start + auto-restart)

Tujuan: gr-pos hidup lagi sendiri kalau proses mati / komputer reboot, supaya
**Plan B (aplikasi lama)** nyaris tak pernah dipakai.

Dua cara. **Pakai NSSM** (disarankan). `node-windows` disediakan sebagai
cadangan kalau tidak bisa unduh nssm.exe.

---

## Langkah 1 — MariaDB juga harus jadi service

Percuma gr-pos auto-start kalau databasenya tidak. Cek dulu:

```powershell
Get-Service MariaDB, MySQL -ErrorAction SilentlyContinue
```

Kalau kosong, daftarkan (PowerShell **Run as Administrator**):

```powershell
cd "E:\Kasir GR\gr-pos\ops\service"
powershell -ExecutionPolicy Bypass -File .\Install-MariaDbService.ps1 -Start
```

Skrip ini `mariadbd --install MariaDB`, set `start=auto`, dan set
auto-restart-on-failure. Idempoten.

---

## Langkah 2 — Pasang service gr-pos (NSSM)

### 2a. Sediakan nssm.exe (sekali saja)

1. Unduh <https://nssm.cc/download> → `nssm-2.24.zip`
2. Ekstrak, ambil **`win64\nssm.exe`**
3. Taruh di `E:\Kasir GR\gr-pos\ops\service\nssm.exe`
   (atau di mana pun yang ada di `PATH`)

### 2b. Install

PowerShell **Run as Administrator**:

```powershell
cd "E:\Kasir GR\gr-pos\ops\service"
powershell -ExecutionPolicy Bypass -File .\Install-GrPosService.ps1 -Start
```

Yang di-set skrip:

| Aspek | Nilai |
|---|---|
| Nama service | `gr-pos` (DisplayName "GR-POS (Grand Royal POS)") |
| Command | `node.exe server\server.js`, workdir `E:\Kasir GR\gr-pos` |
| Start | **Delayed auto-start** (beri waktu MariaDB & jaringan siap) |
| Dependensi | `MariaDB` / `MySQL` kalau service-nya ada |
| Restart | on-exit apa pun, delay 5 dtk, **throttle 10 dtk** (anti crash-loop) |
| Stop | kirim CTRL-C, tunggu 5 dtk → `server.js` menutup pool DB rapi |
| Log | `ops\service\logs\gr-pos.out.log` & `gr-pos.err.log`, rotasi online per 10 MB |
| Env | `NODE_ENV=production` |
| Recovery SCM | restart 5s / 10s / 15s (cadangan) |

Skrip aman diulang: kalau service `gr-pos` sudah ada, dihapus dan dipasang ulang.

---

## Operasional harian

```powershell
# status
Get-Service gr-pos
sc.exe qc gr-pos                 # lihat konfigurasi

# start / stop / restart manual
net stop gr-pos ;  net start gr-pos
Restart-Service gr-pos

# lihat log
Get-Content "E:\Kasir GR\gr-pos\ops\service\logs\gr-pos.out.log" -Tail 50 -Wait
Get-Content "E:\Kasir GR\gr-pos\ops\service\logs\gr-pos.err.log" -Tail 50

# health
Invoke-RestMethod http://localhost:4000/api/health
```

### Kalau ada update kode / `.env`

```powershell
Restart-Service gr-pos
```

Cukup itu. `server.js` menangani `SIGTERM`/CTRL-C: menutup HTTP server +
pool MySQL dulu, paksa keluar setelah 8 dtk kalau macet.

### Update Node.js

Path `node.exe` ditanam saat install. Setelah upgrade Node, jalankan ulang
`Install-GrPosService.ps1` supaya path-nya diperbarui.

---

## Uninstall

```powershell
cd "E:\Kasir GR\gr-pos\ops\service"
powershell -ExecutionPolicy Bypass -File .\Uninstall-GrPosService.ps1
```

---

## Alternatif tanpa unduh: node-windows

Kalau nssm.exe tidak bisa didapat. Dari folder `gr-pos`, PowerShell
**Run as Administrator**:

```powershell
npm install --no-save node-windows
node ops\service\nodewindows-install.js
```

Uninstall: `node ops\service\nodewindows-uninstall.js`

Kekurangan dibanding NSSM: rotasi log lebih sederhana, kontrol
restart-throttle lebih kasar, penyetelan dependensi service kurang rapi.
Fungsional untuk auto-start + auto-restart.

---

## Catatan

- **Jangan jalankan `npm start` manual lagi** setelah service aktif — dua
  proses akan berebut port 4000.
- Service jalan sebagai `LocalSystem`. Env var milik user (mis.
  `DB_USER=ppic` yang pernah mengganggu) TIDAK terbawa — lebih bersih.
  `server.js` tetap `dotenv ... { override: true }` jadi `.env` selalu menang.
- QZ Tray (cetak) berjalan di browser kasir, bukan di server — tidak
  terpengaruh perubahan ini.
- Firewall: pastikan port `4000` (atau `APP_PORT` di `.env`) diizinkan
  untuk LAN kalau terminal lain mengakses lewat IP komputer ini.
