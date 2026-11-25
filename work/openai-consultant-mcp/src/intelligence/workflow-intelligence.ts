import path from "node:path";
import crypto from "node:crypto";
import {
  RegistryOptions,
  resolveToolWorkspace,
  withRegistryLock,
  readJsonFileOrDefault,
  writeJsonAtomic,
} from "../registry/workspace-registry.js";
import {
  WorkflowResult,
  WorkspaceMetadataFields,
  resumeTask,
  ResumeTaskCompactOutput,
} from "../memory/project-memory.js";
import { GraphPreparationMetrics } from "../graph/types.js";

export type MeasurementKind = "exact" | "estimated" | "baseline_estimated";
export type TelemetryEventType =
  | "session_started"
  | "context_resumed"
  | "checkpoint_created"
  | "handoff_prepared"
  | "review_requested"
  | "review_skipped"
  | "clarification_round"
  | "scope_correction"
  | "rework_event"
  | "api_usage"
  | "graph_context_prepared"
  | "graph_execution_progress";

interface TelemetryEvent {
  eventId: string;
  workspaceId: string;
  eventType: TelemetryEventType;
  measuredAt: string;
  measurementKind: MeasurementKind;
  usedTokens: number;
  baselineTokens: number;
  savedTokens: number;
  graph?: Partial<GraphPreparationMetrics> & { actualFilesRead?: number; fileBudgetExceeded?: boolean };
}

interface TelemetryFile {
  schemaVersion: "1.0";
  events: TelemetryEvent[];
}

const TELEMETRY_FILE = "telemetry.json";
const MAX_EVENTS = 5_000;

function metaFromResolved(ws: ReturnType<typeof resolveToolWorkspace> & { ok: true }): WorkspaceMetadataFields {
  return {
    workspaceId: ws.data.workspaceId,
    displayName: ws.data.displayName,
    rootFingerprint: ws.data.rootFingerprint,
    workspaceResolution: ws.data.workspaceResolution,
  };
}

function intelligenceError<T>(code: string, message: string, meta: WorkspaceMetadataFields): WorkflowResult<T> {
  return { ok: false, errorCode: code, message, ...meta };
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 3));
}

export function recordTelemetryEvent(
  input: {
    workspaceId: string;
    eventType: TelemetryEventType;
    measurementKind: MeasurementKind;
    usedTokens: number;
    baselineTokens: number;
    graph?: Partial<GraphPreparationMetrics> & { actualFilesRead?: number; fileBudgetExceeded?: boolean };
  },
  options?: RegistryOptions
): void {
  withRegistryLock((dataDir) => {
    const file = readJsonFileOrDefault<TelemetryFile>(path.join(dataDir, TELEMETRY_FILE), {
      schemaVersion: "1.0",
      events: [],
    });
    const event: TelemetryEvent = {
      eventId: `evt_${crypto.randomBytes(12).toString("hex")}`,
      workspaceId: input.workspaceId,
      eventType: input.eventType,
      measuredAt: (options?.now ?? new Date()).toISOString(),
      measurementKind: input.measurementKind,
      usedTokens: Math.max(0, Math.round(input.usedTokens)),
      baselineTokens: Math.max(0, Math.round(input.baselineTokens)),
      savedTokens: Math.round(input.baselineTokens - input.usedTokens),
      ...(input.graph ? { graph: input.graph } : {}),
    };
    file.events.push(event);
    if (file.events.length > MAX_EVENTS) file.events = file.events.slice(-MAX_EVENTS);
    writeJsonAtomic(dataDir, TELEMETRY_FILE, file);
  }, options);
}

export function getTelemetrySummary(
  workspaceBindingId: string,
  options?: RegistryOptions
): WorkflowResult<{
  eventCount: number;
  exactUsedTokens: number;
  estimatedUsedTokens: number;
  estimatedBaselineTokens: number;
  estimatedTokensSaved: number;
  clarificationRounds: number;
  scopeCorrections: number;
  reworkEvents: number;
  disclaimer: string;
  graphContextEvents: number;
  graphCacheHits: number;
  broadScansAvoided: number;
}> {
  const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return intelligenceError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const meta = metaFromResolved(resolved);
  const locked = withRegistryLock((dataDir) => {
    const file = readJsonFileOrDefault<TelemetryFile>(path.join(dataDir, TELEMETRY_FILE), { schemaVersion: "1.0", events: [] });
    const events = file.events.filter((event) => event.workspaceId === resolved.data.workspaceId);
    const sum = (selector: (event: TelemetryEvent) => number) => events.reduce((total, event) => total + selector(event), 0);
    return {
      eventCount: events.length,
      exactUsedTokens: sum((event) => event.measurementKind === "exact" ? event.usedTokens : 0),
      estimatedUsedTokens: sum((event) => event.measurementKind !== "exact" ? event.usedTokens : 0),
      estimatedBaselineTokens: sum((event) => event.baselineTokens),
      estimatedTokensSaved: sum((event) => event.savedTokens),
      clarificationRounds: events.filter((event) => event.eventType === "clarification_round").length,
      scopeCorrections: events.filter((event) => event.eventType === "scope_correction").length,
      reworkEvents: events.filter((event) => event.eventType === "rework_event").length,
      graphContextEvents: events.filter((event) => event.eventType === "graph_context_prepared").length,
      graphCacheHits: events.filter((event) => event.graph?.cacheHit).length,
      broadScansAvoided: events.filter((event) => event.graph?.broadScanAvoided).length,
      disclaimer: "ChatGPT/Gemini Web token counts are estimated; only API usage events marked exact are exact.",
    };
  }, options);
  if (!locked.ok) return intelligenceError(locked.errorCode, locked.message, meta);
  return { ok: true, summaryText: "Đã tổng hợp telemetry token và rework cho workspace.", data: { ...locked.data, ...meta } };
}

export function recordGraphContextTelemetry(
  workspaceId: string,
  metrics: GraphPreparationMetrics,
  options?: RegistryOptions
): void {
  recordTelemetryEvent({
    workspaceId,
    eventType: "graph_context_prepared",
    measurementKind: "baseline_estimated",
    usedTokens: metrics.capsuleEstimatedTokens,
    baselineTokens: metrics.estimatedBaselineTokens,
    graph: metrics,
  }, options);
}

export function recordGraphExecutionTelemetry(
  workspaceId: string,
  actualFilesRead: number,
  maxInitialFiles: number | undefined,
  options?: RegistryOptions
): void {
  recordTelemetryEvent({
    workspaceId,
    eventType: "graph_execution_progress",
    measurementKind: "estimated",
    usedTokens: 0,
    baselineTokens: 0,
    graph: {
      actualFilesRead: Math.max(0, Math.round(actualFilesRead)),
      fileBudgetExceeded: maxInitialFiles !== undefined && actualFilesRead > maxInitialFiles,
    },
  }, options);
}

export function assessContextHealth(
  input: {
    workspaceBindingId: string;
    conversationTurns: number;
    estimatedContextTokens?: number;
    repeatedQuestion: boolean;
    contradictedDecision: boolean;
    forgotAcceptanceCriteria: boolean;
  },
  options?: RegistryOptions
): WorkflowResult<{
  recommendation: "continue" | "checkpoint" | "handoff_now";
  riskScore: number;
  reasons: string[];
  factPolicy: { verified: string; historical: string; inferred: string; unknown: string };
  taskId: string | null;
  revision: number;
} & WorkspaceMetadataFields> {
  const resumed = resumeTask(undefined, { detailLevel: "compact", workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resumed.ok) return resumed;
  const task = resumed.data as ResumeTaskCompactOutput;
  const reasons: string[] = [];
  let score = 0;
  if (input.conversationTurns >= 30) { score += 3; reasons.push("Cuộc trò chuyện đã dài (>=30 turns)."); }
  else if (input.conversationTurns >= 20) { score += 2; reasons.push("Cuộc trò chuyện đã qua ngưỡng checkpoint."); }
  if ((input.estimatedContextTokens ?? 0) >= 80_000) { score += 3; reasons.push("Context ước tính lớn."); }
  if (input.repeatedQuestion) { score += 3; reasons.push("Agent lặp lại câu hỏi đã giải quyết."); }
  if (input.contradictedDecision) { score += 4; reasons.push("Agent mâu thuẫn với quyết định trước đó."); }
  if (input.forgotAcceptanceCriteria) { score += 4; reasons.push("Agent quên acceptance criteria."); }
  if (task.truncated) { score += 2; reasons.push("Project Memory compact đã bị truncate."); }
  const recommendation = score >= 4 ? "handoff_now" : score >= 2 ? "checkpoint" : "continue";
  return {
    ok: true,
    summaryText: `Context Guardian: ${recommendation} (riskScore=${score}).`,
    data: {
      recommendation,
      riskScore: score,
      reasons,
      factPolicy: {
        verified: "Chỉ dữ kiện vừa được tool/file/test xác nhận.",
        historical: "Dữ kiện từ checkpoint cũ; phải nêu revision/thời điểm.",
        inferred: "Suy luận; phải ghi rõ chưa được kiểm chứng.",
        unknown: "Không đủ bằng chứng; không được tự điền.",
      },
      taskId: task.taskId,
      revision: task.revision,
      workspaceId: task.workspaceId,
      displayName: task.displayName,
      rootFingerprint: task.rootFingerprint,
      workspaceResolution: task.workspaceResolution,
    },
  };
}

export function routeReview(
  input: {
    workspaceBindingId: string;
    changedFileCount: number;
    changedLineCount: number;
    testsPassed: boolean;
    deterministicChange: boolean;
    touchesAuth: boolean;
    touchesSecurity: boolean;
    touchesPayment: boolean;
    touchesDatabaseMigration: boolean;
    touchesConcurrency: boolean;
    touchesProduction: boolean;
    estimatedReviewTokens?: number;
  },
  options?: RegistryOptions
): WorkflowResult<{
  decision: "required" | "recommended" | "skip";
  reasons: string[];
  estimatedTokensAvoided: number;
} & WorkspaceMetadataFields> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return intelligenceError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const meta = metaFromResolved(resolved);
  const highRisk = [input.touchesAuth, input.touchesSecurity, input.touchesPayment, input.touchesDatabaseMigration, input.touchesConcurrency, input.touchesProduction].some(Boolean);
  const reasons: string[] = [];
  let decision: "required" | "recommended" | "skip";
  if (highRisk) {
    decision = "required";
    reasons.push("Thay đổi chạm vùng rủi ro cao (auth/security/payment/migration/concurrency/production).");
  } else if (input.deterministicChange && input.changedFileCount <= 2 && input.changedLineCount <= 20 && input.testsPassed) {
    decision = "skip";
    reasons.push("Thay đổi nhỏ, deterministic và test đã pass.");
  } else {
    decision = "recommended";
    reasons.push("Thay đổi không thuộc nhóm nhỏ/deterministic hoặc chưa có đủ bằng chứng test.");
  }
  const avoided = decision === "skip" ? Math.max(0, input.estimatedReviewTokens ?? 4_000) : 0;
  recordTelemetryEvent({ workspaceId: resolved.data.workspaceId, eventType: decision === "skip" ? "review_skipped" : "review_requested", measurementKind: "baseline_estimated", usedTokens: decision === "skip" ? 0 : (input.estimatedReviewTokens ?? 4_000), baselineTokens: input.estimatedReviewTokens ?? 4_000 }, options);
  return { ok: true, summaryText: `Review Router: ${decision}.`, data: { decision, reasons, estimatedTokensAvoided: avoided, ...meta } };
}

export function recordContextResumeTelemetry(
  workspaceId: string,
  compactPayload: unknown,
  fullPayload: unknown,
  options?: RegistryOptions
): void {
  const used = estimateTokensFromChars(JSON.stringify(compactPayload).length);
  const baseline = estimateTokensFromChars(JSON.stringify(fullPayload).length * 2);
  recordTelemetryEvent({ workspaceId, eventType: "context_resumed", measurementKind: "baseline_estimated", usedTokens: used, baselineTokens: baseline }, options);
}
