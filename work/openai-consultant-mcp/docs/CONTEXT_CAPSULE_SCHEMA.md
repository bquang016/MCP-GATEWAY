# Context Capsule schema 1.0

A Context Capsule is a compact execution map. It contains metadata and graph-derived hints, never full source or raw graph output.

## Identity and freshness

- `capsuleId`, `revision`, `taskId`, `createdAt`
- workspace-safe identifiers (no canonical path)
- `gitCommitSha`, `gitBranch`, `workingTreeDirty`
- `graphRevision`, `projectContextRevision`
- `strategy`, `mode`, `freshness`, `confidence`, `fallbackReason`

## Scoped context

- `architecture`: short synthesized scope statements
- `modules`: bounded module names
- `targetSymbols`: bounded symbol names
- `rankedFiles`: safe relative file paths, capped by `maxInitialFiles`
- `dependencyPaths`: bounded graph relationship summaries
- `relevantTests`, `testCommands`
- `constraints`, `changedFiles`, `doNotRead`

## Budget and behavior

- `estimatedTokens`
- `contextBudget.maxEstimatedTokens`
- `contextBudget.maxInitialFiles`
- `contextBudget.maxDependencyDepth`
- `broadScanAvoided`

The capsule is a starting map. Executors must verify the actual source and tests before changing code. If additional files are required, they may be read, but the executor reports the total and explains budget overruns.

The execution queue stores only a compact reference: capsule/revision IDs, graph revision, mode, ranked files, target symbols, relevant tests, budget, freshness signals, and fallback reason.
