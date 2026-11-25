# Graph telemetry schema

Graph telemetry is metadata-only and stored with the gateway's existing local telemetry. It never records prompts, source code, raw graph results, canonical paths, or secrets.

## `graph_context_prepared`

- availability and revision-match booleans
- graph build/query duration in milliseconds
- cache-hit boolean
- capsule token estimate and ranked-file count
- broad-scan-avoided boolean
- fallback reason
- estimated baseline and saved tokens

Token values are labeled `baseline_estimated`; they are not presented as provider billing totals.

## `graph_execution_progress`

- `actualFilesRead`
- `fileBudgetExceeded`

If the execution exceeds `maxInitialFiles`, the queue additionally requires `fileBudgetExceededReason`. The reason remains progress metadata and should not contain source or secrets.

## Summary counters

The existing telemetry summary includes graph context events, cache hits, avoided broad scans, and estimated token savings alongside clarification/rework metrics.
