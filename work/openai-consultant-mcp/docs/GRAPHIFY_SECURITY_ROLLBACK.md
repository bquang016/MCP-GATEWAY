# Graphify security and rollback

## Security controls

- local code-only extraction with cloud use disabled
- no Graphify API key or external graph database
- no shell interpolation; CLI arguments are passed as an array
- bounded child-process time/output
- sensitive API environment variables removed from the child process
- secret/private/dependency/build/cache/binary paths excluded
- ranked paths revalidated against traversal, absolute paths, private workflow storage, and secret filename patterns
- graph cache/capsules stored outside the repository and locally excluded from Git as defense in depth
- no prompt, source, raw graph, canonical path, or secret in telemetry

## Fast rollback

1. Set `DAGW_GRAPHIFY_ENABLED=0` in the gateway/tunnel environment.
2. Restart the gateway/tunnel.
3. Refresh MCP tools and confirm `graphify_status` reports degraded mode.

No task data migration is required. New dispatches continue through the backward-compatible execution queue without graph context.

To remove the dependency completely, uninstall `graphifyy` with the package manager used for installation. Existing local graph cache is inert and can be removed later through a dedicated maintenance action; do not delete broad application-data directories manually.

## Failure policy

Unavailable CLI, timeout, failed extraction, corrupt cache, or empty query must degrade safely. These conditions must not block HITL controls, terminal permissions, normal Antigravity mode, task dispatch, or source verification.
