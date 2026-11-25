param(
    [switch]$ConfirmInstall,
    [switch]$ReplaceExisting,
    [string]$Name = "dual-agent-workflow-gateway",
    [string]$WorkspaceRoot
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmInstall) {
    throw "HITL required: rerun with -ConfirmInstall after reviewing the Codex MCP registration command."
}

$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if ($null -eq $codexCommand) {
    throw "Codex CLI was not found in PATH. Install or open Codex, then retry."
}

$entryPoint = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\dist\index.js"))
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Gateway build was not found. Run 'npm run build' before installing the Codex MCP server."
}

$existing = $false
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $codexCommand.Source mcp get $Name --json 2>$null | Out-Null
$getExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($getExitCode -eq 0) {
    $existing = $true
}

if ($existing -and -not $ReplaceExisting) {
    throw "An MCP server named '$Name' already exists. Use -ReplaceExisting to replace it explicitly."
}

if ($existing) {
    & $codexCommand.Source mcp remove $Name
    if ($LASTEXITCODE -ne 0) {
        throw "Could not remove the existing Codex MCP server '$Name'."
    }
}

$arguments = @("mcp", "add", $Name)
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspaceRoot)
    if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) {
        throw "WorkspaceRoot does not exist or is not a directory."
    }
    $arguments += @("--env", "MCP_WORKSPACE_ROOT=$resolvedWorkspace")
}
$arguments += @("--", "node", $entryPoint)

& $codexCommand.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Codex MCP registration failed."
}

Write-Output "Installed Codex MCP server '$Name'. Open a new Codex chat or refresh MCP tools."
