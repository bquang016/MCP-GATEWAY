# Graphify local setup

Graphify is optional. Without it, the gateway remains functional in degraded mode.

Official project and package documentation: https://github.com/Graphify-Labs/graphify

## Requirements

- Python 3.11+
- Graphify CLI package `graphifyy`
- No cloud database or API key is required for the code-only workflow

## Install

Recommended on Windows, macOS, and Linux with `uv`:

```text
uv tool install graphifyy
graphify --version
```

Alternative with `pipx`:

```text
pipx install graphifyy
graphify --version
```

If the executable is not on `PATH`, set `GRAPHIFY_COMMAND` to the absolute executable path in the process that starts the gateway. Do not put secrets in this variable.

Restart the gateway/tunnel after installation, refresh MCP tools, and call `graphify_status`. The first dispatched task can take longer because it performs a cold extraction; later tasks on the same Git revision use the cache.

## Configuration

Graph-first is the default for new dispatches. Optional environment variables:

- `DAGW_GRAPHIFY_ENABLED=0`: immediately disable Graphify and use degraded/legacy context.
- `GRAPHIFY_COMMAND=<executable>`: override the CLI executable.

Context budgets are supplied per dispatch:

```json
{
  "contextStrategy": "graph_first",
  "contextBudget": {
    "maxEstimatedTokens": 3500,
    "maxInitialFiles": 8,
    "maxDependencyDepth": 2
  }
}
```

## Update or uninstall

```text
uv tool upgrade graphifyy
uv tool uninstall graphifyy
```

For `pipx`, use `pipx upgrade graphifyy` or `pipx uninstall graphifyy`.

Uninstalling is safe: restart the gateway and it automatically degrades to the legacy-compatible path.
