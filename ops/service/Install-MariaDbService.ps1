<#
  Install-MariaDbService.ps1
  ------------------------------------------------------------------
  Mendaftarkan MariaDB lokal sebagai Windows Service auto-start +
  auto-restart. Perlu supaya gr-pos (yang depend ke service "MariaDB")
  bisa start otomatis saat boot dengan DB sudah siap.

  Jalankan sebagai Administrator. Idempoten - aman diulang.
    powershell -ExecutionPolicy Bypass -File .\Install-MariaDbService.ps1 -Start
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'MariaDB',
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Harus "Run as Administrator".'; exit 1
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Service '$ServiceName' sudah ada." -ForegroundColor Green
} else {
  # Cari instalasi MariaDB (versi bisa beda: 'MariaDB 12.3', dst).
  $base = Get-ChildItem 'C:\Program Files\MariaDB *', 'C:\Program Files (x86)\MariaDB *' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $base) { Write-Error "Folder instalasi MariaDB tidak ditemukan di C:\Program Files."; exit 1 }

  $mariadbd = Join-Path $base.FullName 'bin\mariadbd.exe'
  $ini      = Join-Path $base.FullName 'data\my.ini'
  if (-not (Test-Path $mariadbd)) { Write-Error "Tidak menemukan $mariadbd"; exit 1 }
  if (-not (Test-Path $ini))      { Write-Error "Tidak menemukan $ini"; exit 1 }

  Write-Host "mariadbd : $mariadbd"
  Write-Host "my.ini   : $ini"
  & $mariadbd --install $ServiceName --defaults-file="$ini"
  if ($LASTEXITCODE -ne 0) { Write-Error "Gagal --install (exit $LASTEXITCODE)."; exit 1 }
  Write-Host "Service '$ServiceName' terpasang." -ForegroundColor Green
}

# Auto-start + auto-restart on failure.
sc.exe config $ServiceName start= auto | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

if ($Start) {
  if ((Get-Service $ServiceName).Status -ne 'Running') { Start-Service $ServiceName }
  Get-Service $ServiceName | Format-Table -AutoSize
}
