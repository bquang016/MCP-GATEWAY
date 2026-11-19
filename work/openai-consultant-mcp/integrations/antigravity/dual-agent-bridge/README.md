# Dual-Agent Workflow Bridge (Antigravity Plugin — Phase 5)

## Overview

`dual-agent-bridge` is the Antigravity integration for the complete **Phase 1–5** Dual-Agent Workflow Gateway.

It registers and refreshes the currently open Antigravity workspace in the local Dual-Agent Workflow Gateway registry (`%APPDATA%\dual-agent-workflow-gateway\` or `DAGW_DATA_DIR`) so ChatGPT Web can attach to the active workspace via `attach_active_workspace` without changing `MCP_WORKSPACE_ROOT` per project.

## Lifecycle Hooks (`hooks.json`)

- **`SessionStart`**: Registers the active workspace with an 8-hour lease. It injects Dual-Agent instructions only when an actionable execution request already exists; otherwise stdout is `{}` and the chat remains in Normal mode.
- **`PreInvocation` heartbeat**: Refreshes the workspace lease before a user invocation, including restored chats where `SessionStart` is not emitted. Heartbeats are debounced per workspace for five minutes, so ordinary prompts normally return immediately without spawning the gateway CLI.

The bundled `rules/AGENTS.md` keeps ordinary Antigravity chats in fast Normal mode. Dual-Agent mode is enabled only by a real queued request or an explicit user request, then requires a separate user-approved Start and an exclusive claim.

There is no MCP polling and no global `PreToolUse` override. The lightweight heartbeat never calls workflow tools or reads task context. Antigravity's native terminal/sandbox permission system remains authoritative, avoiding extra prompts and tool calls in Normal mode.

Phase 5 adds a localhost-only dashboard, metadata-only audit trail, backup/restore with HITL, token-savings telemetry, multi-task coordination, and context/review intelligence. Queue delivery remains hook-driven while an Antigravity chat is active; optional per-user Windows Startup launchers keep the tunnel and dashboard available in the background without administrator rights.

## Path Resolution (No Hard-Coded Machine Paths)

`scripts/session-start.js` resolves the gateway CLI (`dist/cli.js`) in the following order:

1. `DAGW_CLI_PATH` environment variable (if set).
2. `bridge-config.json` in the plugin root (generated at install time by `scripts/install-plugin.js`).
3. Relative repository path `../../../dist/cli.js` (when run directly from `integrations/antigravity/dual-agent-bridge/`).

## Installation (When Ready to Enable)

To install or update it in a target plugins directory (such as `~/.gemini/config/plugins/dual-agent-bridge`), build the gateway first and run the installer script:

```powershell
npm run build
node ./integrations/antigravity/dual-agent-bridge/scripts/install-plugin.js --target "$HOME/.gemini/config/plugins/dual-agent-bridge"
```

## Optional Local Dashboard

Start interactively:

```powershell
npm run dashboard
```

Install hidden startup only after explicit confirmation:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/install-dashboard-startup.ps1 -ConfirmInstall
```

Install the tunnel launcher with a DPAPI-protected runtime key:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/install-tunnel-startup.ps1 -ConfirmInstall -UseClipboard
```

The dashboard binds only to `127.0.0.1`, contains no prompts or source code, and reports queue/HITL state, tasks, quality signals, audit metadata, and estimated token savings.

