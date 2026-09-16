<#
  Start-Demo.ps1  --  Menyalakan gr-pos MODE PRESENTASI (database dummy).
  Klik-kanan > Run with PowerShell, atau:
    powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1

  - Menyalakan MariaDB 12.3 lokal kalau belum jalan (tanpa perlu Windows Service).
  - Menjalankan server gr-pos di http://localhost:4000 memakai database
    "bintangnew_demo" (klon lokal - TIDAK menyentuh bintangnew asli / server 154).
  - Tutup jendela ini (atau Ctrl+C) untuk menghentikan server.
    MariaDB tetap jalan; hentikan manual lewat Task Manager (mariadbd.exe) bila perlu.

  Login demo:  admin / admin123   (juga: kasir / kasir123 , dapur / dapur123)
#>
$ErrorActionPreference = 'Stop'
$mariaBin = 'C:\Program Files\MariaDB 12.3\bin'
$mariadbd = Join-Path $mariaBin 'mariadbd.exe'
$myIni    = 'C:\Program Files\MariaDB 12.3\data\my.ini'
$projDir  = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-DbUp {
  try {
    & (Join-Path $mariaBin 'mysql.exe') -u root -e 'SELECT 1' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

if (Test-DbUp) {
  Write-Host 'MariaDB sudah jalan.' -ForegroundColor Green
} else {
  Write-Host 'Menyalakan MariaDB...' -ForegroundColor Yellow
  Start-Process -FilePath $mariadbd -ArgumentList "--defaults-file=`"$myIni`"" -WindowStyle Hidden
  for ($i = 0; $i -lt 20 -and -not (Test-DbUp); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-DbUp) { Write-Host 'MariaDB siap.' -ForegroundColor Green }
  else { Write-Error 'MariaDB gagal start. Cek instalasi di C:\Program Files\MariaDB 12.3.'; exit 1 }
}

# Pastikan database dummy ada (kalau belum, beri tahu cara membuatnya).
$hasDemo = & (Join-Path $mariaBin 'mysql.exe') -u root -N -e "SHOW DATABASES LIKE 'bintangnew_demo'"
if (-not $hasDemo) {
  Write-Warning "Database 'bintangnew_demo' belum ada."
  Write-Host   "Buat dengan (sekali saja):" -ForegroundColor Yellow
  Write-Host   "  `"$mariaBin\mysql.exe`" -u root -e `"CREATE DATABASE bintangnew_demo CHARACTER SET utf8mb4`""
  Write-Host   "  `"$mariaBin\mysqldump.exe`" -u root --routines --single-transaction bintangnew | `"$mariaBin\mysql.exe`" -u root bintangnew_demo"
  Write-Host   "  node server/utils/createAdmin.js admin admin123 `"Admin Demo`" admin"
  exit 1
}

Set-Location $projDir
Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host '  GR POS - MODE PRESENTASI' -ForegroundColor Cyan
Write-Host '  http://localhost:4000     login: admin / admin123' -ForegroundColor Cyan
Write-Host '  (Ctrl+C untuk berhenti)' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ''
Start-Process 'http://localhost:4000'
npm start
