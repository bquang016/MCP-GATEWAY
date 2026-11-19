param(
    [switch]$ConfirmInstall,
    [int]$Port = 43110
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmInstall) {
    throw "HITL required: rerun with -ConfirmInstall after reviewing the scheduled task command."
}

$starter = Join-Path $PSScriptRoot "start-dashboard-hidden.ps1"
if (-not (Test-Path -LiteralPath $starter)) {
    throw "Dashboard starter script not found."
}

$startupDir = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startupDir "DualAgentWorkflowDashboard.cmd"
$command = "@start `"`" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$starter`"`" -Port $Port"
Set-Content -LiteralPath $launcher -Value $command -Encoding ASCII
& $starter -Port $Port
Write-Output "Installed Startup launcher '$launcher' for http://127.0.0.1:$Port"
