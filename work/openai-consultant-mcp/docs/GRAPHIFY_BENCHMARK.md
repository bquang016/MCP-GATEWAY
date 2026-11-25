# Graph-first benchmark

## Method

The automated fixture models a small service/repository/test dependency chain and exercises cold build, warm cache, revision change, branch change, dirty worktree, bounded query, degraded fallback, and security filters.

CI/provider-failure tests use a deterministic mock. A local smoke run was also executed with the official `graphifyy` 0.9.113 CLI on Windows. Token counts are estimates based on serialized capsule size; they are not API billing measurements.

## Comparison

| Path | Initial source targeting | Graph build | Expected context behavior |
|---|---:|---:|---|
| Legacy broad scan | Unbounded by graph | None | Baseline estimate starts at 4,000 tokens |
| Graph-first cold | Up to 8 ranked files by default | One extraction | Capsule capped at 2,000 tokens and task budget |
| Graph-first warm | Same bounded ranking | Cache hit; no rebuild | Same cap, lower preparation latency |

Local CLI smoke result on the four-file fixture:

- cold code-only build: 1,310 ms
- scoped query: 828 ms
- warm same-revision build check: 0 ms (cache hit)
- ranked files: 4; symbols: 3

These timing values are fixture/machine observations, not a general performance guarantee.

The fixture verifies `estimatedSavedTokens >= 0`, cache reuse on the same commit, rebuild after a commit change, and no full-source leakage into capsules or telemetry. Actual savings depend on repository size and task specificity.

## Production measurement

Use `workflow_telemetry_summary` after representative tasks and compare:

- graph cache-hit rate
- broad scans avoided
- capsule token estimate versus estimated baseline
- actual files read versus initial file budget
- clarification and rework events

Do not interpret estimated values as exact ChatGPT/Gemini Web token usage.
