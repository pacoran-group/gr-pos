<#
  Uninstall-GrPosService.ps1
  Menghentikan & menghapus Windows Service gr-pos.
  Jalankan sebagai Administrator:
    powershell -ExecutionPolicy Bypass -File .\Uninstall-GrPosService.ps1
#>
[CmdletBinding()]
param([string]$ServiceName = 'gr-pos')

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Harus "Run as Administrator".'; exit 1
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host "Service '$ServiceName' tidak ada. Selesai."; exit 0 }

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $local = Join-Path $PSScriptRoot 'nssm.exe'
  if (Test-Path $local) { $nssm = $local }
}

if ($svc.Status -ne 'Stopped') {
  Write-Host "Menghentikan '$ServiceName'..."
  if ($nssm) { & $nssm stop $ServiceName | Out-Null } else { Stop-Service $ServiceName -Force }
  Start-Sleep -Seconds 2
}

if ($nssm) {
  & $nssm remove $ServiceName confirm
} else {
  sc.exe delete $ServiceName | Out-Null
}
Write-Host "Service '$ServiceName' dihapus." -ForegroundColor Green
