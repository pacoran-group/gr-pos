<#
  Install-Unit.ps1
  ------------------------------------------------------------------
  Instalasi gr-pos satu-langkah untuk UNIT KARAOKE YANG SUDAH PUNYA
  aplikasi + database lama (Jalur A - lihat README bagian 1). Skrip ini
  TIDAK memindahkan/mengekspor data unit ke mana pun - dia connect ke
  database lama yang SUDAH ADA di server ini dan menambahkan tabel
  `web_*` di tempat (CREATE TABLE IF NOT EXISTS, tidak pernah mengubah
  tabel lama). Password database hanya diminta SEKALI, disimpan
  sementara di file lokal (dihapus otomatis di akhir), tidak pernah
  ditampilkan/di-log sebagai teks biasa.

  Jalankan dari folder ini (atau dari mana saja, path project dihitung
  otomatis):
    cd "E:\Kasir GR\gr-pos\ops\install"
    powershell -ExecutionPolicy Bypass -File .\Install-Unit.ps1

  Prasyarat SEBELUM menjalankan skrip ini (lihat README bagian 1):
    - Node.js 18+ sudah terpasang.
    - MariaDB/MySQL sudah terpasang & JALAN (service atau manual) di
      komputer ini, dan Anda tahu nama database aplikasi lama unit ini
      (SHOW DATABASES; kalau ragu) + user/password akses ke database itu.

  Skrip ini interaktif - akan bertanya beberapa hal (nama database,
  user/password DB, identitas unit). Aman dijalankan ulang (semua
  langkah SQL pakai IF NOT EXISTS / idempotent) kalau ada yang gagal di
  tengah jalan dan perlu diulang.
#>
[CmdletBinding()]
param(
  [string]$DbHost = 'localhost',
  [int]$DbPort = 3306,
  [string]$DbUser = 'root',
  [string]$DbName,
  [string]$MySqlBin
)

$ErrorActionPreference = 'Stop'
$projDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $projDir

function Write-Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [PERINGATAN] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[GAGAL] $msg" -ForegroundColor Red; exit 1 }

function ConvertFrom-SecureStringPlain([System.Security.SecureString]$Secure) {
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# ---------------------------------------------------------------------
Write-Step '1. Cek Node.js'
try {
  $nodeVersion = (node -v) 2>$null
} catch { $nodeVersion = $null }
if (-not $nodeVersion) {
  Fail 'Node.js tidak ditemukan. Install dulu dari https://nodejs.org (versi LTS), lalu jalankan ulang skrip ini.'
}
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
  Fail "Node.js $nodeVersion terpasang, tapi gr-pos butuh Node 18+. Update dulu dari https://nodejs.org."
}
Write-Ok "Node.js $nodeVersion"

# ---------------------------------------------------------------------
Write-Step '2. Cari mysql.exe (MariaDB/MySQL client)'
if (-not $MySqlBin) {
  $candidate = Get-ChildItem 'C:\Program Files\MariaDB *\bin\mysql.exe',
                              'C:\Program Files (x86)\MariaDB *\bin\mysql.exe',
                              'C:\Program Files\MySQL\MySQL Server *\bin\mysql.exe' `
                              -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1
  if ($candidate) { $MySqlBin = Split-Path $candidate.FullName -Parent }
}
if (-not $MySqlBin -or -not (Test-Path (Join-Path $MySqlBin 'mysql.exe'))) {
  Fail ('mysql.exe tidak ditemukan otomatis. Jalankan ulang dengan -MySqlBin, contoh: ' +
        '.\Install-Unit.ps1 -MySqlBin "C:\Program Files\MariaDB 12.3\bin"')
}
$mysqlExe = Join-Path $MySqlBin 'mysql.exe'
Write-Ok "Ditemukan: $mysqlExe"

# ---------------------------------------------------------------------
Write-Step '3. Cek service MariaDB/MySQL jalan'
$svc = Get-Service -Name 'MariaDB', 'MySQL', 'MySQL80' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' }
if ($svc) {
  Write-Ok "Service '$($svc[0].Name)' jalan."
} else {
  Write-Warn2 'Tidak ada service MariaDB/MySQL yang RUNNING terdeteksi. Kalau database dijalankan manual (bukan service), abaikan peringatan ini.'
  Write-Warn2 'Kalau memang belum jalan: "net start MariaDB" (PowerShell as Administrator), atau lihat ops\service\Install-MariaDbService.ps1.'
  $cont = Read-Host '  Lanjutkan instalasi? (y/n)'
  if ($cont -ne 'y') { Fail 'Dihentikan oleh user - nyalakan dulu MariaDB/MySQL, lalu jalankan ulang skrip ini.' }
}

# ---------------------------------------------------------------------
Write-Step '4. Info database unit ini'
Write-Host '  Nama database di bawah ini HARUS SAMA dengan database yang SUDAH DIPAKAI'
Write-Host '  aplikasi kasir/billing LAMA di unit ini (bukan nama baru sembarangan).'
Write-Host '  Kalau tidak yakin namanya, batalkan dulu (Ctrl+C) dan cek "SHOW DATABASES;" dulu.'
if (-not $DbName) { $DbName = Read-Host '  Nama database unit ini' }
if ($DbName -notmatch '^[A-Za-z0-9_]+$') {
  Fail "Nama database '$DbName' mengandung karakter yang tidak aman (hanya huruf/angka/underscore diperbolehkan)."
}
$dbUserIn = Read-Host "  User MySQL/MariaDB untuk akses database ini [$DbUser]"
if ($dbUserIn) { $DbUser = $dbUserIn }
$dbHostIn = Read-Host "  Host database [$DbHost]"
if ($dbHostIn) { $DbHost = $dbHostIn }
$securePw = Read-Host "  Password user '$DbUser'" -AsSecureString
$plainPw = ConvertFrom-SecureStringPlain $securePw

# File defaults sementara (bukan .env) supaya password tidak perlu diketik
# ulang tiap kali mysql.exe dipanggil (23 file migration + cek koneksi).
# Dihapus otomatis di blok `finally` paling bawah, isinya TIDAK pernah
# ditulis ke log/console.
$tmpCnf = Join-Path $env:TEMP "grpos-install-$PID.cnf"
@"
[client]
user=$DbUser
password=$plainPw
host=$DbHost
port=$DbPort
"@ | Set-Content -Path $tmpCnf -Encoding ASCII
try { icacls $tmpCnf /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } catch { }

try {
  # ---------------------------------------------------------------------
  Write-Step '5. Tes koneksi & keberadaan database'
  $testOut = & $mysqlExe --defaults-extra-file=$tmpCnf -e 'SELECT 1' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail "Tidak bisa konek ke MySQL/MariaDB sebagai '$DbUser'@'$DbHost`:$DbPort'. Pesan asli: $testOut"
  }
  Write-Ok 'Koneksi ke server database OK.'

  $exists = & $mysqlExe --defaults-extra-file=$tmpCnf -N -e "SHOW DATABASES LIKE '$DbName'"
  if (-not $exists) {
    Write-Warn2 "Database '$DbName' belum ada di server ini."
    $mk = Read-Host "  Buat database kosong baru bernama '$DbName' sekarang? HANYA jawab y kalau unit ini BENAR-BENAR BARU (belum pernah punya sistem kasir lama) - kalau unit ini SEHARUSNYA sudah punya database lama, jawab n dan cari nama yang benar dulu. (y/n)"
    if ($mk -eq 'y') {
      $bt = [char]96
      & $mysqlExe --defaults-extra-file=$tmpCnf -e "CREATE DATABASE $bt$DbName$bt CHARACTER SET utf8mb4"
      if ($LASTEXITCODE -ne 0) { Fail "Gagal membuat database '$DbName'." }
      Write-Ok "Database '$DbName' dibuat kosong. INGAT: unit ini masuk 'Jalur B' di README - data kamar/tarif/produk/member HARUS diisi manual (lihat README bagian 1) sebelum staf mulai pakai."
    } else {
      Fail 'Dihentikan - pastikan dulu nama database lama unit ini benar, lalu jalankan ulang skrip ini.'
    }
  } else {
    Write-Ok "Database '$DbName' ditemukan (Jalur A - data master lama akan tetap dipakai apa adanya)."
  }

  # ---------------------------------------------------------------------
  Write-Step '6. npm install'
  if (Test-Path (Join-Path $projDir 'node_modules')) {
    Write-Ok 'node_modules sudah ada, dilewati (hapus folder ini dulu kalau mau install ulang).'
  } else {
    npm install
    if ($LASTEXITCODE -ne 0) { Fail 'npm install gagal - cek pesan error di atas.' }
    Write-Ok 'npm install selesai.'
  }

  # ---------------------------------------------------------------------
  Write-Step '7. Siapkan .env'
  $envPath = Join-Path $projDir '.env'
  if (Test-Path $envPath) {
    Write-Warn2 '.env sudah ada - TIDAK ditimpa otomatis (supaya tidak menghapus konfigurasi yang sudah ada).'
    Write-Warn2 "Cek manual: DB_HOST=$DbHost, DB_PORT=$DbPort, DB_USER=$DbUser, DB_NAME=$DbName harus sesuai isian tadi."
  } else {
    Copy-Item (Join-Path $projDir '.env.example') $envPath
    $jwtSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
    $unitId = Read-Host '  UNIT_ID unit ini (kode singkat, mis. KRK-CIBUBUR)'
    $unitName = Read-Host '  UNIT_NAME unit ini (nama lengkap, dicetak di struk)'
    $warehouseId = Read-Host "  WAREHOUSE_ID unit ini [WH-$unitId]"
    if (-not $warehouseId) { $warehouseId = "WH-$unitId" }

    $content = Get-Content $envPath
    $content = $content | ForEach-Object {
      switch -Regex ($_) {
        '^DB_HOST='      { "DB_HOST=$DbHost"; break }
        '^DB_PORT='      { "DB_PORT=$DbPort"; break }
        '^DB_USER='      { "DB_USER=$DbUser"; break }
        '^DB_PASSWORD='  { "DB_PASSWORD=$plainPw"; break }
        '^DB_NAME='      { "DB_NAME=$DbName"; break }
        '^JWT_SECRET='   { "JWT_SECRET=$jwtSecret"; break }
        '^UNIT_ID='      { "UNIT_ID=$unitId"; break }
        '^UNIT_NAME='    { "UNIT_NAME=$unitName"; break }
        '^WAREHOUSE_ID=' { "WAREHOUSE_ID=$warehouseId"; break }
        default          { $_ }
      }
    }
    Set-Content -Path $envPath -Value $content
    Write-Ok '.env dibuat dari .env.example + diisi otomatis (DB_*, JWT_SECRET, UNIT_*).'
    Write-Warn2 'Field lain (SMTP_*, EOD_REPORT_RECIPIENTS, HOTEL_*, dst) masih nilai contoh - isi manual sebelum go-live kalau dipakai. Lihat README bagian 2.'
  }

  # ---------------------------------------------------------------------
  Write-Step '8. Jalankan migration (server\migrations\0*.sql)'
  $migrations = Get-ChildItem (Join-Path $projDir 'server\migrations\0*.sql') | Sort-Object Name
  foreach ($f in $migrations) {
    Write-Host "  -> $($f.Name)"
    $out = Get-Content $f.FullName -Raw | & $mysqlExe --defaults-extra-file=$tmpCnf $DbName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Fail "Migration $($f.Name) GAGAL - dihentikan di sini (jangan lanjut ke file berikutnya). Pesan: $out"
    }
  }
  Write-Ok "$($migrations.Count) file migration selesai dijalankan."

  # ---------------------------------------------------------------------
  Write-Step '9. Preflight check'
  node (Join-Path $projDir 'server\utils\preflightCheck.js')
  $preflightExit = $LASTEXITCODE
  if ($preflightExit -ne 0) {
    Write-Host ''
    Fail 'Preflight check menemukan masalah FATAL (lihat di atas) - beresi dulu, lalu jalankan ulang "npm run preflight" sebelum membuat user admin / npm start.'
  }

  # ---------------------------------------------------------------------
  Write-Step '10. Buat user admin pertama'
  $mkAdmin = Read-Host '  Buat user admin sekarang? (y/n)'
  if ($mkAdmin -eq 'y') {
    $adminUser = Read-Host '  Username admin'
    $adminName = Read-Host '  Nama lengkap admin'
    $adminPwSecure = Read-Host '  Password admin' -AsSecureString
    $adminPw = ConvertFrom-SecureStringPlain $adminPwSecure
    node (Join-Path $projDir 'server\utils\createAdmin.js') $adminUser $adminPw $adminName admin
    if ($LASTEXITCODE -ne 0) { Fail 'Gagal membuat user admin - cek pesan di atas.' }
  } else {
    Write-Warn2 'Dilewati - buat manual nanti: node server\utils\createAdmin.js <username> <password> "<Nama>" admin'
  }

  Write-Host ''
  Write-Host '=====================================================' -ForegroundColor Green
  Write-Host '  INSTALASI SELESAI' -ForegroundColor Green
  Write-Host '=====================================================' -ForegroundColor Green
  Write-Host '  Jalankan server:  npm start'
  Write-Host '  Lalu buka:        http://localhost:4000'
  Write-Host '  Auto-start Windows Service: lihat ops\service\README.md'
  Write-Host '  Setup printer (QZ Tray) di tiap komputer kasir: lihat README bagian 7'
  Write-Host ''
}
finally {
  if (Test-Path $tmpCnf) { Remove-Item $tmpCnf -Force }
}
