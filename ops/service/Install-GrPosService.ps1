<#
  Install-GrPosService.ps1
  ------------------------------------------------------------------
  Mendaftarkan gr-pos (server/server.js) sebagai Windows Service yang:
    - start otomatis saat komputer boot (delayed auto-start)
    - RESTART otomatis kalau proses mati / crash (throttle 10 dtk)
    - menulis log ke ops\service\logs\ dengan rotasi
    - berhenti rapi (kirim CTRL-C dulu -> server.js menutup pool DB)
    - (kalau ada service "MariaDB") start SETELAH database siap

  Pakai NSSM (https://nssm.cc). Taruh nssm.exe di PATH atau di
  ops\service\nssm.exe (versi win64). Lihat README.md di folder ini.

  Jalankan di PowerShell **sebagai Administrator**:
    powershell -ExecutionPolicy Bypass -File .\Install-GrPosService.ps1 -Start
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'gr-pos',
  [switch]$Start
)

$ErrorActionPreference = 'Stop'

# --- Harus Administrator ---
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Skrip ini harus dijalankan di PowerShell yang "Run as Administrator".'
  exit 1
}

# --- Lokasi ---
$serviceDir = $PSScriptRoot                                  # ...\gr-pos\ops\service
$root       = Split-Path (Split-Path $serviceDir -Parent) -Parent  # ...\gr-pos
$entry      = Join-Path $root 'server\server.js'
$logDir     = Join-Path $serviceDir 'logs'
if (-not (Test-Path $entry)) { Write-Error "Tidak menemukan $entry - jalankan skrip dari dalam gr-pos\ops\service."; exit 1 }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- node.exe ---
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-Error "node.exe tidak ditemukan. Install Node.js 18+ atau set PATH."; exit 1 }

# --- nssm.exe ---
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $local = Join-Path $serviceDir 'nssm.exe'
  if (Test-Path $local) { $nssm = $local }
}
if (-not $nssm) {
  Write-Error @"
nssm.exe tidak ditemukan.
  1. Unduh dari https://nssm.cc/download (nssm-2.24.zip)
  2. Ambil win64\nssm.exe
  3. Taruh di: $((Join-Path $serviceDir 'nssm.exe'))
  lalu jalankan skrip ini lagi.
"@
  exit 1
}

Write-Host "node : $node"
Write-Host "entry: $entry"
Write-Host "nssm : $nssm"
Write-Host "logs : $logDir"

# --- Kalau service sudah ada, hapus dulu (idempoten) ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Service '$ServiceName' sudah ada - menghapus dulu..."
  if ($existing.Status -ne 'Stopped') { & $nssm stop $ServiceName | Out-Null; Start-Sleep -Seconds 2 }
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

# --- Install ---
& $nssm install $ServiceName $node (Join-Path 'server' 'server.js')
& $nssm set $ServiceName AppDirectory $root
& $nssm set $ServiceName DisplayName 'GR-POS (Grand Royal POS)'
& $nssm set $ServiceName Description  'POS Grand Royal (Node/Express). Auto-restart saat crash. Konfigurasi: gr-pos\.env'
& $nssm set $ServiceName AppEnvironmentExtra 'NODE_ENV=production'

# Start otomatis, tapi DELAYED - beri waktu MariaDB/jaringan siap dulu.
& $nssm set $ServiceName Start SERVICE_DELAYED_AUTO_START

# Restart on exit (kode apa pun) + jangan restart lebih cepat dari 10 dtk
# (cegah crash-loop membanjiri CPU/log).
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm set $ServiceName AppThrottle 10000

# Stop rapi: kirim CTRL-C ke console app (Node menerimanya sbg SIGINT ->
# server.js menutup HTTP server + pool DB). Tunggu 10 dtk sebelum eskalasi
# ke TerminateProcess - beri ruang untuk fallback 8 dtk di server.js.
# AppStopMethodSkip 6 = lewati WM_CLOSE & WM_QUIT (app konsol, tak punya
# window); CTRL-C dan TerminateProcess tetap dipakai.
& $nssm set $ServiceName AppStopMethodSkip 6
& $nssm set $ServiceName AppStopMethodConsole 10000

# Log stdout/stderr + rotasi (online, per 10 MB).
& $nssm set $ServiceName AppStdout (Join-Path $logDir 'gr-pos.out.log')
& $nssm set $ServiceName AppStderr (Join-Path $logDir 'gr-pos.err.log')
& $nssm set $ServiceName AppStdoutCreationDisposition 4
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateOnline 1
& $nssm set $ServiceName AppRotateBytes 10485760

# Kalau ada service database bernama "MariaDB" / "MySQL", jadikan dependensi
# supaya gr-pos start SETELAH DB. (Kalau DB bukan service, lewati - server.js
# tetap toleran: pool connect lazy, worker retry.)
foreach ($dbSvc in @('MariaDB', 'MySQL', 'MySQL80')) {
  if (Get-Service -Name $dbSvc -ErrorAction SilentlyContinue) {
    & $nssm set $ServiceName DependOnService $dbSvc
    Write-Host "Dependensi di-set: $ServiceName -> $dbSvc"
    break
  }
}

# Backup: recovery bawaan SCM juga di-set (kalau NSSM sendiri yang crash).
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/15000 | Out-Null

Write-Host ""
Write-Host "Service '$ServiceName' terpasang." -ForegroundColor Green

if ($Start) {
  Write-Host "Menjalankan service..."
  & $nssm start $ServiceName
  Start-Sleep -Seconds 4
  Get-Service -Name $ServiceName | Format-Table -AutoSize
  try {
    $port = 4000
    $envFile = Join-Path $root '.env'
    if (Test-Path $envFile) {
      $m = Select-String -Path $envFile -Pattern '^\s*APP_PORT\s*=\s*(\d+)' | Select-Object -First 1
      if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
    }
    $h = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5
    Write-Host "Health OK: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
  } catch {
    Write-Warning "Health check belum lewat (mungkin DB belum siap). Cek log: $logDir\gr-pos.err.log"
  }
} else {
  Write-Host "Jalankan:  net start $ServiceName    (atau tambahkan -Start saat memanggil skrip)"
}
