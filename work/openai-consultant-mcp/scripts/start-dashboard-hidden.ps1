param(
    [int]$Port = 43110
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $repoRoot "dist\dashboard.js"
if (-not (Test-Path -LiteralPath $dashboard)) {
    throw "dist/dashboard.js not found. Run npm run build first."
}

$env:DAGW_DASHBOARD_PORT = [string]$Port
Start-Process -FilePath "node" -ArgumentList @($dashboard) -WorkingDirectory $repoRoot -WindowStyle Hidden
Write-Output "Dashboard started at http://127.0.0.1:$Port"
