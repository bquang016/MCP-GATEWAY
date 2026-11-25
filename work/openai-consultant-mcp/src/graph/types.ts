import { WorkspaceMetadataFields } from "../memory/project-memory.js";

export type ContextStrategy = "graph_first" | "legacy";
export type GraphMode = "graph_first" | "degraded" | "legacy";

export interface ContextBudget {
  maxEstimatedTokens: number;
  maxInitialFiles: number;
  maxDependencyDepth: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxEstimatedTokens: 3_500,
  maxInitialFiles: 8,
  maxDependencyDepth: 2,
};

export interface GitWorkspaceState {
  commitSha: string | null;
  branch: string | null;
  dirty: boolean;
  changedFiles: string[];
}

export interface GraphStatus {
  available: boolean;
  graphExists: boolean;
  graphRevision: string | null;
  revisionMatched: boolean;
  providerVersion: string | null;
  mode: GraphMode;
  fallbackReason: string | null;
}

export interface GraphQueryResult {
  text: string;
  symbols: string[];
  rankedFiles: string[];
  dependencyPaths: string[];
  relevantTests: string[];
  durationMs: number;
  truncated: boolean;
}

export interface ContextCapsule extends WorkspaceMetadataFields {
  schemaVersion: "1.0";
  capsuleId: string;
  revision: number;
  taskId: string;
  createdAt: string;
  gitCommitSha: string | null;
  gitBranch: string | null;
  workingTreeDirty: boolean;
  graphRevision: string | null;
  projectContextRevision: string;
  strategy: ContextStrategy;
  mode: GraphMode;
  architecture: string[];
  modules: string[];
  targetSymbols: string[];
  rankedFiles: string[];
  dependencyPaths: string[];
  relevantTests: string[];
  testCommands: string[];
  constraints: string[];
  changedFiles: string[];
  doNotRead: string[];
  confidence: "high" | "medium" | "low";
  freshness: "fresh" | "dirty_worktree" | "stale" | "unavailable";
  estimatedTokens: number;
  contextBudget: ContextBudget;
  broadScanAvoided: boolean;
  fallbackReason: string | null;
}

export interface ExecutionContextReference {
  capsuleId: string;
  capsuleRevision: number;
  graphRevision: string | null;
  mode: GraphMode;
  rankedFiles: string[];
  targetSymbols: string[];
  relevantTests: string[];
  contextBudget: ContextBudget;
  confidence: ContextCapsule["confidence"];
  workingTreeDirty: boolean;
  broadScanAvoided: boolean;
  fallbackReason: string | null;
}

export interface GraphPreparationMetrics {
  graphAvailable: boolean;
  graphRevisionMatched: boolean;
  graphBuildDurationMs: number;
  graphQueryDurationMs: number;
  cacheHit: boolean;
  capsuleEstimatedTokens: number;
  rankedFileCount: number;
  broadScanAvoided: boolean;
  fallbackReason: string | null;
  estimatedBaselineTokens: number;
  estimatedSavedTokens: number;
}

export interface PrepareContextInput {
  workspaceBindingId: string;
  taskId: string;
  objective: string;
  inScope: string[];
  plannedFiles: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  contextStrategy?: ContextStrategy;
  contextBudget?: Partial<ContextBudget>;
}

