# Run the k6 load test against the running SwiftTrack stack.
#
#   .\scripts\loadtest.ps1                             # 60 VUs x 60 s (plan default)
#   .\scripts\loadtest.ps1 -Vus 10 -Duration 15s       # quick pass
#   $env:BASE_URL = 'http://localhost:3000'            # explicit target
#
# Uses a local `k6` when one is on PATH; otherwise falls back to the official
# Grafana image joined to the compose network, so no host tooling is required.
param(
    [int]$Vus,
    [string]$Duration,
    [string]$Pause,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Network = if ($env:SWIFT_NETWORK) { $env:SWIFT_NETWORK } else { 'swifttrack_swift-network' }
$Script = Join-Path $Root 'loadtest\k6-orders.js'

# k6's own `-e KEY=VALUE` collides with PowerShell's common -E* parameters, so
# the tunables are exposed as first-class switches instead.
$overrides = @()
if ($Vus) { $overrides += @('-e', "VUS=$Vus") }
if ($Duration) { $overrides += @('-e', "DURATION=$Duration") }
if ($Pause) { $overrides += @('-e', "PAUSE=$Pause") }

$localK6 = Get-Command k6 -ErrorAction SilentlyContinue
if ($localK6) {
    $Target = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }
    Write-Host "==> k6 (local) targeting $Target"
    & $localK6.Source run -e "BASE_URL=$Target" @overrides @Rest $Script
    exit $LASTEXITCODE
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Error 'k6 is not installed and Docker is unavailable.'
    exit 1
}

# Inside the compose network the gateway is reachable by service name,
# which sidesteps host/container networking differences entirely.
$Target = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://api-gateway:3000' }
Write-Host "==> k6 (docker) on network $Network targeting $Target"

Get-Content $Script -Raw |
    docker run --rm -i --network $Network grafana/k6:latest run `
        -e "BASE_URL=$Target" @overrides @Rest -
exit $LASTEXITCODE
