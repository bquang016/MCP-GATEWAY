# Antigravity graph-first integration

The Dual-Agent plugin keeps Normal mode unchanged. Graphify is used only for tasks that arrive through the Dual-Agent execution queue.

## Executor flow

1. Start the Dual-Agent session and inspect the actionable queue.
2. Present the queued objective and obtain the existing HITL Start approval.
3. Claim the request once.
4. Use the attached Context Capsule before broad search. Start with target symbols, ranked files, dependency paths, and related tests.
5. Read the selected source and tests to verify actual behavior.
6. Edit code and run the smallest relevant test/build commands under Antigravity's native terminal permissions.
7. Report `actualFilesRead`. If it exceeds the capsule's `maxInitialFiles`, also report `fileBudgetExceededReason`.
8. Continue the existing review, completion, handoff, and archive flow. Graphify does not bypass any HITL gate.

## Failure behavior

If the capsule reports `degraded` or `legacy`, use normal targeted source discovery. Do not wait indefinitely for Graphify, and do not infer code behavior from a missing/stale graph.

If the working tree is dirty, treat graph results as a locator for committed structure only. Verify changed files directly before editing.

## User experience

The user does not need to remember Graphify tools. `dispatch_execution_task` prepares graph context automatically and claim hydrates the capsule. `graphify_status` is intended for diagnostics only.
