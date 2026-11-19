param(
    [switch]$ConfirmInstall,
    [switch]$UseClipboard,
    [switch]$ReuseStoredKey,
    [securestring]$RuntimeKey,
    [string]$Profile = "dual-agent-local"
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmInstall) { throw "HITL required: rerun with -ConfirmInstall after reviewing the scheduled task command." }
if ($ReuseStoredKey) {
    $existingSecret = Join-Path (Join-Path $env:APPDATA "dual-agent-workflow-gateway") "tunnel-runtime-key.dpapi"
    if (-not (Test-Path -LiteralPath $existingSecret)) { throw "No stored DPAPI key exists." }
}
elseif ($UseClipboard) {
    $clipboardKey = Get-Clipboard
    if ([string]::IsNullOrWhiteSpace($clipboardKey)) { throw "Clipboard is empty." }
    $clipboardKey = $clipboardKey.Trim()
    if (-not $clipboardKey.StartsWith("sk-") -or $clipboardKey.Length -lt 20 -or $clipboardKey -match "\s") {
        throw "Clipboard does not contain a valid tunnel runtime API key."
    }
    $RuntimeKey = ConvertTo-SecureString $clipboardKey -AsPlainText -Force
    $clipboardKey = $null
    Set-Clipboard -Value " "
}
elseif ($null -eq $RuntimeKey) {
    $RuntimeKey = Read-Host "Paste the tunnel runtime API key (input is hidden)" -AsSecureString
}

$dataDir = Join-Path $env:APPDATA "dual-agent-workflow-gateway"
$secretFile = Join-Path $dataDir "tunnel-runtime-key.dpapi"
$starter = Join-Path $PSScriptRoot "start-tunnel-hidden.ps1"
if (-not (Test-Path -LiteralPath $starter)) { throw "Tunnel starter script not found." }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (-not $ReuseStoredKey) {
    $RuntimeKey | ConvertFrom-SecureString | Set-Content -LiteralPath $secretFile -Encoding ASCII
}

try {
    $acl = Get-Acl -LiteralPath $secretFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "Read,Write", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $secretFile -AclObject $acl
}
catch [System.Security.AccessControl.PrivilegeNotHeldException] {
    Write-Warning "Could not replace inherited ACL without elevated privilege; DPAPI user binding still protects the stored key."
}

$startupDir = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startupDir "DualAgentWorkflowTunnel.cmd"
$command = "@start `"`" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$starter`"`" -Profile `"`"$Profile`"`""
Set-Content -LiteralPath $launcher -Value $command -Encoding ASCII
& $starter -Profile $Profile
Write-Output "Installed and started '$launcher'. The runtime key is protected with Windows DPAPI."
