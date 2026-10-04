# End-to-end smoke test against the *running* SwiftTrack stack.
#
#   docker compose up -d --wait
#   .\scripts\smoke.ps1                 # whole suite
#   .\scripts\smoke.ps1 -Only delivery  # filter on check names
#
# Requires the compose stack from docker-compose.yml to be healthy.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$python = 'python'
if (Test-Path (Join-Path $Root '.venv\Scripts\python.exe')) {
    $python = Join-Path $Root '.venv\Scripts\python.exe'
}

& $python (Join-Path $Root 'scripts\smoke.py') @Rest
exit $LASTEXITCODE
