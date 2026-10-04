# Lint every SwiftTrack service.
#   .\scripts\lint.ps1          # check only (CI mode)
#   .\scripts\lint.ps1 -Fix     # auto-fix where possible
param([switch]$Fix)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ruff = Join-Path $Root '.venv\Scripts\ruff.exe'
if (-not (Test-Path $ruff)) { $ruff = 'ruff' }

$fixArgs = @()
if ($Fix) { $fixArgs = @('--fix') }

$failed = $false

Write-Host '==> eslint (api-gateway)'
Push-Location (Join-Path $Root 'api-gateway')
npx eslint . @fixArgs
if ($LASTEXITCODE -ne 0) { $failed = $true }
Pop-Location

Write-Host '==> eslint (ros-service)'
Push-Location (Join-Path $Root 'ros-service')
npx eslint . @fixArgs
if ($LASTEXITCODE -ne 0) { $failed = $true }
Pop-Location

Write-Host '==> ruff (cms-service, wms-service)'
& $ruff check . @fixArgs
if ($LASTEXITCODE -ne 0) { $failed = $true }

if ($failed) { exit 1 }
Write-Host 'All linters passed.' -ForegroundColor Green
