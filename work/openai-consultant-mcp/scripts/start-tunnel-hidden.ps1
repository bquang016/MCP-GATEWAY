param([string]$Profile = "dual-agent-local")

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $env:APPDATA "dual-agent-workflow-gateway"
$secretFile = Join-Path $dataDir "tunnel-runtime-key.dpapi"
$logFile = Join-Path $dataDir "tunnel-client.log"
$pidFile = Join-Path $dataDir "tunnel-client.pid"
$tunnelExe = "C:\Users\buida\Downloads\tunnel-client-v0.0.20-windows-amd64\tunnel-client.exe"

if (-not (Test-Path -LiteralPath $tunnelExe)) { throw "tunnel-client.exe not found at the configured path." }
if (-not (Test-Path -LiteralPath $secretFile)) { throw "Encrypted runtime key not found. Run install-tunnel-startup.ps1 first." }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$existing = Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue
if ($existing) { Write-Output "Tunnel client is already running."; exit 0 }

$secureKey = ConvertTo-SecureString (Get-Content -LiteralPath $secretFile -Raw).Trim()
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $arguments = @("run", "--profile", $Profile, "--health.listen-addr", "127.0.0.1:0", "--log.file", $logFile, "--pid.file", $pidFile)
    Start-Process -FilePath $tunnelExe -ArgumentList $arguments -WindowStyle Hidden
}
finally {
    $env:CONTROL_PLANE_API_KEY = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Output "Tunnel client started in the background."
