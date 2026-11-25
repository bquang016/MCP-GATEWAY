import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerWorkspaceFromHook, attachActiveWorkspace } from "../src/memory/project-memory.js";
import { GraphContextService } from "../src/graph/graph-context-service.js";
import { GRAPHIFY_EXCLUDES, GraphBuildResult, GraphProvider, parseGraphifyQueryOutput } from "../src/graph/graphify-local-provider.js";
import { GitWorkspaceState, GraphQueryResult, GraphStatus } from "../src/graph/types.js";
import { submitExecutionRequestForTask, approveExecutionStart, claimExecutionRequest, updateExecutionProgress } from "../src/queue/execution-queue.js";
import { recordGraphContextTelemetry } from "../src/intelligence/workflow-intelligence.js";

class MockProvider implements GraphProvider {
  available = true; built = false; buildOk = true; fallbackReason = "GRAPHIFY_BUILD_FAILED";
  actualBuilds = 0; queryCalls = 0; lastQuestion = "";
  queryResult: GraphQueryResult = {
    text: "Node: loadUser\nloadUser --> findUser [calls]",
    symbols: ["loadUser", "findUser"],
    rankedFiles: ["src/user-service.ts", "src/user-repository.ts", "test/user-service.test.ts"],
    dependencyPaths: ["loadUser --> findUser [calls]"], relevantTests: ["test/user-service.test.ts"], durationMs: 4, truncated: false,
  };
  getStatus(_root: string, _dir: string, git: GitWorkspaceState, cached: string | null): GraphStatus {
    return { available: this.available, graphExists: this.built, graphRevision: cached, revisionMatched: this.built && cached === git.commitSha, providerVersion: this.available ? "mock-1" : null, mode: this.available ? "graph_first" : "degraded", fallbackReason: this.available ? null : "GRAPHIFY_UNAVAILABLE" };
  }
  buildOrUpdate(_root: string, graphDir: string, git: GitWorkspaceState, cached: string | null): GraphBuildResult {
    if (!this.available) return { ok: false, graphPath: path.join(graphDir, "graph.json"), revision: null, durationMs: 0, updatedIncrementally: false, fallbackReason: "GRAPHIFY_UNAVAILABLE" };
    if (this.built && cached === git.commitSha) return { ok: true, graphPath: path.join(graphDir, "graph.json"), revision: cached, durationMs: 0, updatedIncrementally: false, fallbackReason: null };
    this.actualBuilds++;
    if (!this.buildOk) return { ok: false, graphPath: path.join(graphDir, "graph.json"), revision: null, durationMs: 99, updatedIncrementally: this.built, fallbackReason: this.fallbackReason };
    this.built = true; fs.mkdirSync(graphDir, { recursive: true }); fs.writeFileSync(path.join(graphDir, "graph.json"), "{}", "utf-8");
    return { ok: true, graphPath: path.join(graphDir, "graph.json"), revision: git.commitSha, durationMs: 10, updatedIncrementally: this.actualBuilds > 1, fallbackReason: null };
  }
  query(_graph: string, question: string): GraphQueryResult { this.queryCalls++; this.lastQuestion = question; return this.queryResult; }
  findSymbols(r: GraphQueryResult) { return r.symbols; } rankFiles(r: GraphQueryResult, max: number) { return r.rankedFiles.slice(0, max); }
  findDependencies(r: GraphQueryResult) { return r.dependencyPaths; } suggestTests(r: GraphQueryResult) { return r.relevantTests; }
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test("Graph-first context, cache, security and backward compatibility", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-graph-test-"));
  const workspace = path.join(temp, "workspace"); const dataDir = path.join(temp, "registry");
  fs.cpSync(path.resolve("test/fixtures/graph-project"), workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET_VALUE=do-not-index\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".ai"), { recursive: true });
  git(workspace, ["init"]); git(workspace, ["config", "user.email", "fixture@example.test"]); git(workspace, ["config", "user.name", "Fixture"]);
  git(workspace, ["add", "src", "test"]); git(workspace, ["commit", "-m", "fixture"]);
  const options = { dataDir, now: new Date("2026-11-20T00:00:00.000Z") };
  const registered = registerWorkspaceFromHook({ conversationId: "graph", workspacePaths: [workspace], hookEventName: "SessionStart" }, options);
  assert.equal(registered.ok, true);
  const attached = attachActiveWorkspace({ initializeIfMissing: true }, options); assert.equal(attached.ok, true); if (!attached.ok) return;
  const binding = attached.data.bindingId;
  const baseInput = { workspaceBindingId: binding, taskId: "graph-task", objective: "Change loadUser behavior", inScope: ["user service"], plannedFiles: [] as string[], acceptanceCriteria: ["linked test passes"], constraints: ["local only"] };

  try {
    await t.test("1-3 unavailable, no graph, first build", () => {
      const unavailable = new MockProvider(); unavailable.available = false;
      const degraded = new GraphContextService(unavailable).prepare(baseInput, options);
      assert.equal(degraded.capsule.mode, "degraded"); assert.equal(degraded.capsule.fallbackReason, "GRAPHIFY_UNAVAILABLE");
      const provider = new MockProvider(); assert.equal(provider.built, false);
      const cold = new GraphContextService(provider).prepare({ ...baseInput, taskId: "cold" }, options);
      assert.equal(provider.actualBuilds, 1); assert.equal(cold.capsule.mode, "graph_first"); assert.ok(cold.capsule.graphRevision);
    });

    await t.test("4 same commit cache hit, no rebuild", () => {
      const provider = new MockProvider(); const service = new GraphContextService(provider);
      service.prepare({ ...baseInput, taskId: "cache-a" }, options); const warm = service.prepare({ ...baseInput, taskId: "cache-b" }, options);
      assert.equal(provider.actualBuilds, 1); assert.equal(warm.metrics.cacheHit, true);
    });

    await t.test("5-7 commit, branch and dirty state", () => {
      const provider = new MockProvider(); const service = new GraphContextService(provider);
      service.prepare({ ...baseInput, taskId: "rev-a" }, options);
      fs.appendFileSync(path.join(workspace, "src", "user-service.ts"), "\nexport const revision = 2;\n"); git(workspace, ["add", "src/user-service.ts"]); git(workspace, ["commit", "-m", "change"]);
      const changed = service.prepare({ ...baseInput, taskId: "rev-b" }, options); assert.equal(provider.actualBuilds, 2); assert.ok(changed.capsule.changedFiles.includes("src/user-service.ts"));
      git(workspace, ["checkout", "-b", "fixture-branch"]); const branch = service.prepare({ ...baseInput, taskId: "branch" }, options); assert.equal(branch.capsule.gitBranch, "fixture-branch");
      fs.appendFileSync(path.join(workspace, "src", "app.ts"), "\n// dirty\n"); const dirty = service.prepare({ ...baseInput, taskId: "dirty" }, options); assert.equal(dirty.capsule.workingTreeDirty, true); assert.equal(dirty.capsule.freshness, "dirty_worktree");
    });

    await t.test("8 budget and ranked file cap", () => {
      const provider = new MockProvider(); provider.queryResult = { ...provider.queryResult, rankedFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`), dependencyPaths: Array.from({ length: 100 }, (_, i) => `A${i} --> B${i}`) };
      const prepared = new GraphContextService(provider).prepare({ ...baseInput, taskId: "budget", contextBudget: { maxEstimatedTokens: 500, maxInitialFiles: 3, maxDependencyDepth: 2 } }, options);
      assert.ok(prepared.capsule.estimatedTokens <= 500); assert.ok(prepared.capsule.rankedFiles.length <= 3);
    });

    await t.test("9-11 empty query, timeout and corrupt cache degrade safely", () => {
      const empty = new MockProvider(); empty.queryResult = { ...empty.queryResult, text: "", symbols: [], rankedFiles: [], dependencyPaths: [], relevantTests: [] };
      assert.equal(new GraphContextService(empty).prepare({ ...baseInput, taskId: "empty" }, options).capsule.fallbackReason, "GRAPH_QUERY_EMPTY");
      const timeout = new MockProvider(); timeout.buildOk = false; timeout.fallbackReason = "GRAPHIFY_TIMEOUT";
      assert.equal(new GraphContextService(timeout).prepare({ ...baseInput, taskId: "timeout" }, options).capsule.fallbackReason, "GRAPHIFY_TIMEOUT");
      const provider = new MockProvider(); const service = new GraphContextService(provider); const first = service.prepare({ ...baseInput, taskId: "corrupt-a" }, options);
      const statePath = path.join(dataDir, "graph-context", first.capsule.workspaceId!, "state.json"); fs.writeFileSync(statePath, "{broken", "utf-8");
      assert.doesNotThrow(() => service.prepare({ ...baseInput, taskId: "corrupt-b" }, options));
    });

    await t.test("12-16 injection, traversal, private/secrets, capsule no full source", () => {
      const provider = new MockProvider(); provider.queryResult = { ...provider.queryResult, text: "function loadUser(){ return SECRET_VALUE; }", rankedFiles: [".env", ".ai/STATE.md", "../escape.ts", "src/user-service.ts"] };
      const marker = path.join(temp, "must-not-exist");
      const prepared = new GraphContextService(provider).prepare({ ...baseInput, taskId: "secure", objective: `change user; echo hacked > ${marker}`, plannedFiles: ["../escape.ts", ".env"] }, options);
      assert.equal(fs.existsSync(marker), false); assert.match(provider.lastQuestion, /echo hacked/);
      assert.deepEqual(prepared.capsule.rankedFiles, ["src/user-service.ts"]); assert.doesNotMatch(JSON.stringify(prepared.capsule), /SECRET_VALUE|function loadUser/);
      assert.ok(GRAPHIFY_EXCLUDES.includes(".ai/**")); assert.ok(GRAPHIFY_EXCLUDES.includes(".env"));
      const localExclude = fs.readFileSync(path.join(workspace, ".git", "info", "exclude"), "utf-8");
      assert.match(localExclude, /graphify-out/); assert.match(localExclude, /context-capsules/);
    });

    await t.test("17-19 legacy request, fallback and file-budget reason", () => {
      const legacy = new GraphContextService(new MockProvider()).prepare({ ...baseInput, taskId: "legacy", contextStrategy: "legacy" }, options);
      assert.equal(legacy.capsule.mode, "legacy");
      const request = submitExecutionRequestForTask({ workspaceBindingId: binding, taskId: "old-contract", objective: "Old request still works", userConfirmedPlanHandoff: true }, options);
      assert.equal(request.ok, true); if (!request.ok) return; assert.equal(request.data.executionContext, undefined);
      const graphRequest = submitExecutionRequestForTask({ workspaceBindingId: binding, taskId: "budget-contract", objective: "Budget", userConfirmedPlanHandoff: true, executionContext: legacy.reference }, options);
      assert.equal(graphRequest.ok, true); if (!graphRequest.ok) return;
      const approved = approveExecutionStart({ workspaceBindingId: binding, requestId: graphRequest.data.requestId, expectedRevision: 0, userConfirmedStart: true }, options); assert.equal(approved.ok, true);
      const claimed = claimExecutionRequest({ workspaceBindingId: binding, requestId: graphRequest.data.requestId, expectedRevision: 1, executorId: "fixture" }, options); assert.equal(claimed.ok, true);
      const denied = updateExecutionProgress({ workspaceBindingId: binding, requestId: graphRequest.data.requestId, expectedRevision: 2, executorId: "fixture", status: "executing", progressSummary: "expanded", actualFilesRead: 99 }, options);
      assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.errorCode, "FILE_BUDGET_REASON_REQUIRED");
    });

    await t.test("20 telemetry contains metadata only and benchmark labels estimates", () => {
      const provider = new MockProvider(); const prepared = new GraphContextService(provider).prepare({ ...baseInput, taskId: "telemetry", objective: "TOP SECRET PROMPT" }, options);
      recordGraphContextTelemetry(prepared.capsule.workspaceId!, prepared.metrics, options);
      const raw = fs.readFileSync(path.join(dataDir, "telemetry.json"), "utf-8");
      assert.doesNotMatch(raw, /TOP SECRET PROMPT|Fixture User|SECRET_VALUE/); assert.match(raw, /baseline_estimated/);
      assert.ok(prepared.metrics.estimatedSavedTokens >= 0); assert.equal(typeof prepared.metrics.cacheHit, "boolean");
    });

    await t.test("21 parses real Graphify 0.9 query output", () => {
      const output = [
        "NODE user-service.ts [src=src/user-service.ts loc=L1 community=]",
        "NODE loadUser() [src=src/user-service.ts loc=L2 community=]",
        "NODE user-service.test.ts [src=test/user-service.test.ts loc=L1 community=]",
        "EDGE loadUser() --calls [EXTRACTED context=call]--> findUser() at=src/user-service.ts:L2",
      ].join("\n");
      const parsed = parseGraphifyQueryOutput(output, 8, 5, false);
      assert.deepEqual(parsed.rankedFiles, ["src/user-service.ts", "test/user-service.test.ts"]);
      assert.deepEqual(parsed.symbols, ["loadUser()"]);
      assert.deepEqual(parsed.relevantTests, ["test/user-service.test.ts"]);
      assert.equal(parsed.dependencyPaths.length, 1);
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
