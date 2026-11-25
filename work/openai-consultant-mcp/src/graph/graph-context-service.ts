import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_FILES } from "../config.js";
import { ensureGraphArtifactsGitExcluded } from "../memory/project-memory.js";
import { RegistryOptions, getRegistryDataDir, resolveToolWorkspace, writeJsonAtomic } from "../registry/workspace-registry.js";
import { GraphifyLocalProvider, GraphProvider } from "./graphify-local-provider.js";
import {
  ContextBudget, ContextCapsule, ContextStrategy, DEFAULT_CONTEXT_BUDGET,
  ExecutionContextReference, GitWorkspaceState, GraphPreparationMetrics,
  GraphStatus, PrepareContextInput,
} from "./types.js";

interface GraphCacheState {
  schemaVersion: "1.0";
  workspaceId: string;
  commitSha: string | null;
  graphRevision: string | null;
  providerVersion: string | null;
  updatedAt: string;
}

export interface PreparedExecutionContext {
  capsule: ContextCapsule;
  reference: ExecutionContextReference;
  metrics: GraphPreparationMetrics;
}

function runGit(root: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8", windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 64 * 1024,
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

function gitState(root: string, previousCommit?: string | null): GitWorkspaceState {
  const commitSha = runGit(root, ["rev-parse", "HEAD"]);
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyOutput = runGit(root, ["status", "--porcelain", "--untracked-files=normal"]) ?? "";
  const dirtyFiles = dirtyOutput.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, "/"));
  const committedChanges = previousCommit && commitSha && previousCommit !== commitSha
    ? (runGit(root, ["diff", "--name-only", previousCommit, commitSha]) ?? "").split(/\r?\n/u).filter(Boolean)
    : [];
  return { commitSha, branch, dirty: dirtyFiles.length > 0, changedFiles: [...new Set([...committedChanges, ...dirtyFiles])].slice(0, 100) };
}

function safeReadJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T; } catch { return null; }
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

function normalizeBudget(input?: Partial<ContextBudget>): ContextBudget {
  return {
    maxEstimatedTokens: Math.min(8_000, Math.max(500, Math.round(input?.maxEstimatedTokens ?? DEFAULT_CONTEXT_BUDGET.maxEstimatedTokens))),
    maxInitialFiles: Math.min(20, Math.max(1, Math.round(input?.maxInitialFiles ?? DEFAULT_CONTEXT_BUDGET.maxInitialFiles))),
    maxDependencyDepth: Math.min(6, Math.max(1, Math.round(input?.maxDependencyDepth ?? DEFAULT_CONTEXT_BUDGET.maxDependencyDepth))),
  };
}

function safeRelativeList(items: string[], max: number): string[] {
  return [...new Set(items.map((item) => item.replace(/\\/g, "/").trim()).filter((item) => item && !path.isAbsolute(item) && !item.split("/").includes("..")))]
    .filter((item) => !/(^|\/)(?:\.ai|\.git|node_modules|dist|build|\.venv|venv|graphify-out)(?:\/|$)/iu.test(item))
    .filter((item) => !/(^|\/)(?:\.env(?:\..*)?|.*(?:credential|credentials|secret).*|.*\.(?:pem|key|p12|sqlite|db))(?:\/|$)/iu.test(item))
    .slice(0, max);
}

function capCapsule(capsule: ContextCapsule, maxTokens: number): ContextCapsule {
  const capped = { ...capsule };
  const shrinkOrder: Array<keyof ContextCapsule> = ["architecture", "modules", "constraints", "changedFiles", "testCommands", "doNotRead", "relevantTests", "dependencyPaths", "rankedFiles", "targetSymbols"];
  while (estimateTokens(capped) > maxTokens) {
    const field = shrinkOrder.find((key) => Array.isArray(capped[key]) && (capped[key] as unknown[]).length > 0);
    if (!field) break;
    (capped[field] as unknown[]) = (capped[field] as unknown[]).slice(0, -1);
  }
  capped.estimatedTokens = estimateTokens(capped);
  return capped;
}

export class GraphContextService {
  constructor(private readonly provider: GraphProvider = new GraphifyLocalProvider()) {}

  private paths(workspaceId: string, options?: RegistryOptions) {
    const base = path.join(getRegistryDataDir(options?.dataDir), "graph-context", workspaceId);
    return { base, graphDir: path.join(base, "graph"), capsulesDir: path.join(base, "capsules"), statePath: path.join(base, "state.json") };
  }

  status(workspaceBindingId: string, options?: RegistryOptions): { status: GraphStatus; workspaceId: string; displayName: string; rootFingerprint: string } | null {
    const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
    if (!resolved.ok) return null;
    const paths = this.paths(resolved.data.workspaceId, options);
    const cached = safeReadJson<GraphCacheState>(paths.statePath);
    const git = gitState(resolved.data.canonicalRoot, cached?.commitSha);
    return { status: this.provider.getStatus(resolved.data.canonicalRoot, paths.graphDir, git, cached?.graphRevision ?? null), workspaceId: resolved.data.workspaceId, displayName: resolved.data.displayName, rootFingerprint: resolved.data.rootFingerprint };
  }

  prepare(input: PrepareContextInput, options?: RegistryOptions): PreparedExecutionContext {
    const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
    if (!resolved.ok) throw new Error(`[${resolved.errorCode}] ${resolved.message}`);
    const ws = resolved.data;
    const strategy: ContextStrategy = input.contextStrategy ?? "graph_first";
    const budget = normalizeBudget(input.contextBudget);
    const paths = this.paths(ws.workspaceId, options);
    fs.mkdirSync(paths.capsulesDir, { recursive: true });
    ensureGraphArtifactsGitExcluded(ws.canonicalRoot);

    const cached = safeReadJson<GraphCacheState>(paths.statePath);
    const git = gitState(ws.canonicalRoot, cached?.commitSha);
    const projectContextPath = path.join(ws.memoryDir, MEMORY_FILES.PROJECT_CONTEXT);
    const projectContextRevision = fs.existsSync(projectContextPath) ? hashText(fs.readFileSync(projectContextPath, "utf-8")) : "none";
    const initialStatus = this.provider.getStatus(ws.canonicalRoot, paths.graphDir, git, cached?.graphRevision ?? null);
    let buildDurationMs = 0;
    let graphRevision = cached?.graphRevision ?? null;
    let fallbackReason: string | null = strategy === "legacy" ? "LEGACY_REQUESTED" : initialStatus.fallbackReason;
    let query = { text: "", symbols: [] as string[], rankedFiles: [] as string[], dependencyPaths: [] as string[], relevantTests: [] as string[], durationMs: 0, truncated: false };
    let mode: ContextCapsule["mode"] = strategy === "legacy" ? "legacy" : "degraded";
    let cacheHit = false;

    if (strategy === "graph_first" && initialStatus.available) {
      const built = this.provider.buildOrUpdate(ws.canonicalRoot, paths.graphDir, git, cached?.graphRevision ?? null);
      buildDurationMs = built.durationMs;
      if (built.ok) {
        mode = "graph_first";
        graphRevision = built.revision;
        cacheHit = initialStatus.revisionMatched;
        fallbackReason = null;
        writeJsonAtomic(paths.base, "state.json", { schemaVersion: "1.0", workspaceId: ws.workspaceId, commitSha: git.commitSha, graphRevision, providerVersion: initialStatus.providerVersion, updatedAt: new Date().toISOString() } satisfies GraphCacheState);
        const question = [input.objective, ...input.inScope, ...input.plannedFiles, ...input.acceptanceCriteria].join("\n").slice(0, 8_000);
        query = this.provider.query(built.graphPath, question, Math.min(1_500, budget.maxEstimatedTokens), budget.maxDependencyDepth, budget.maxInitialFiles);
        if (!query.text.trim()) { mode = "degraded"; fallbackReason = "GRAPH_QUERY_EMPTY"; }
      } else fallbackReason = built.fallbackReason;
    }

    const rankedFiles = safeRelativeList([...query.rankedFiles, ...input.plannedFiles], budget.maxInitialFiles);
    const relevantTests = safeRelativeList(query.relevantTests, budget.maxInitialFiles);
    const capsuleId = `cap_${crypto.randomBytes(16).toString("hex")}`;
    let capsule: ContextCapsule = {
      schemaVersion: "1.0", capsuleId, revision: 1, taskId: input.taskId, createdAt: new Date().toISOString(),
      gitCommitSha: git.commitSha, gitBranch: git.branch, workingTreeDirty: git.dirty, graphRevision,
      projectContextRevision, strategy, mode,
      architecture: rankedFiles.length
        ? [`Graph-scoped context targets ${rankedFiles.length} ranked file(s) across ${[...new Set(rankedFiles.map((file) => file.split("/")[0]))].length} module area(s).`]
        : [],
      modules: rankedFiles.map((file) => file.split("/")[0]).filter(Boolean).slice(0, 8),
      targetSymbols: query.symbols.slice(0, 20), rankedFiles,
      dependencyPaths: query.dependencyPaths.map((line) => line.replace(/\s+/gu, " ").slice(0, 300)).slice(0, 20), relevantTests,
      testCommands: relevantTests.length ? ["Run the smallest relevant test target first."] : ["Discover and run the repository's existing targeted test command."],
      constraints: input.constraints.map((item) => item.replace(/\s+/gu, " ").slice(0, 300)).slice(0, 20), changedFiles: safeRelativeList(git.changedFiles, 100),
      doNotRead: ["dependency/build/cache/binary directories", "private workflow storage", "secret or credential files"],
      confidence: mode === "graph_first" ? (git.dirty ? "medium" : rankedFiles.length ? "high" : "low") : "low",
      freshness: mode !== "graph_first" ? "unavailable" : git.dirty ? "dirty_worktree" : graphRevision === git.commitSha ? "fresh" : "stale",
      estimatedTokens: 0, contextBudget: budget, broadScanAvoided: mode === "graph_first" && rankedFiles.length > 0, fallbackReason,
      workspaceId: ws.workspaceId, displayName: ws.displayName, rootFingerprint: ws.rootFingerprint, workspaceResolution: ws.workspaceResolution,
    };
    capsule = capCapsule(capsule, Math.min(2_000, budget.maxEstimatedTokens));
    writeJsonAtomic(paths.capsulesDir, `${capsuleId}.json`, capsule);
    const reference: ExecutionContextReference = {
      capsuleId, capsuleRevision: capsule.revision, graphRevision: capsule.graphRevision, mode: capsule.mode,
      rankedFiles: capsule.rankedFiles, targetSymbols: capsule.targetSymbols, relevantTests: capsule.relevantTests,
      contextBudget: capsule.contextBudget, confidence: capsule.confidence, workingTreeDirty: capsule.workingTreeDirty,
      broadScanAvoided: capsule.broadScanAvoided, fallbackReason: capsule.fallbackReason,
    };
    const baseline = Math.max(4_000, capsule.estimatedTokens + rankedFiles.length * 600);
    return { capsule, reference, metrics: { graphAvailable: initialStatus.available, graphRevisionMatched: initialStatus.revisionMatched, graphBuildDurationMs: buildDurationMs, graphQueryDurationMs: query.durationMs, cacheHit, capsuleEstimatedTokens: capsule.estimatedTokens, rankedFileCount: capsule.rankedFiles.length, broadScanAvoided: capsule.broadScanAvoided, fallbackReason, estimatedBaselineTokens: baseline, estimatedSavedTokens: Math.max(0, baseline - capsule.estimatedTokens) } };
  }

  getCapsule(workspaceBindingId: string, capsuleId: string, options?: RegistryOptions): ContextCapsule | null {
    if (!/^cap_[a-f0-9]{32}$/u.test(capsuleId)) return null;
    const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
    if (!resolved.ok) return null;
    return safeReadJson<ContextCapsule>(path.join(this.paths(resolved.data.workspaceId, options).capsulesDir, `${capsuleId}.json`));
  }
}

