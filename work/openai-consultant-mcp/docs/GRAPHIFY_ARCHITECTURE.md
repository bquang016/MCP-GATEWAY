# Graphify local architecture

Version 5.2 adds an optional, local-only code graph in front of execution. It narrows the first source reads without replacing source verification.

## Data flow

1. ChatGPT dispatches an approved task with `contextStrategy=graph_first` and a bounded `contextBudget`.
2. The gateway resolves the bound workspace, records Git commit/branch/dirty state, and checks the graph cache.
3. `GraphifyLocalProvider` builds or incrementally updates a code-only graph when needed. The graph and capsules live in gateway application data, not in the repository.
4. A bounded query produces symbols, dependency paths, related tests, and ranked files.
5. `GraphContextService` sanitizes that output into a Context Capsule. Raw graph output and full source are never placed in the queue or telemetry.
6. Antigravity claims the execution request and receives the capsule automatically. It reads ranked source files to verify behavior before editing.
7. If Graphify is missing, times out, or returns no useful result, the request continues in degraded/legacy mode.

## Boundaries

- `GraphProvider` is the adapter boundary. The initial provider is the Graphify CLI; other local graph engines can implement the same interface.
- Process execution uses argument arrays with `shell=false`, bounded output, and timeouts.
- Known API credentials are removed from the Graphify child-process environment and cloud use is disabled.
- Secret, dependency, build, cache, binary, Git, and private workflow paths are excluded both before extraction and after query ranking.
- Cache keys include workspace identity, Git revision, and Project Memory revision metadata. Dirty worktrees are explicitly marked; they are never described as fully fresh.

## Operational modes

- `graph_first`: graph query succeeded; ranked context is available.
- `degraded`: graph unavailable/failed/empty; execution remains usable.
- `legacy`: caller explicitly opted out.

Graph-first reduces broad initial reads; it does not prohibit reading additional source. Exceeding the initial file budget requires a reason in progress telemetry.
