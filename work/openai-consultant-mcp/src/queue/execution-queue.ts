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

export const EXECUTION_QUEUE_SCHEMA_VERSION = "1.0";
export const EXECUTION_QUEUE_FILE = "execution-queue.json";

export type ExecutionStatus =
  | "pending_user_start"
  | "queued"
  | "executing"
  | "blocked"
  | "review"
  | "completed"
  | "cancelled";

export interface ExecutionRequest {
  requestId: string;
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  taskId: string;
  objective: string;
  status: ExecutionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  userApprovedPlanHandoff: true;
  userApprovedExecutionAt: string | null;
  executorId: string | null;
  executionLeaseExpiresAt: string | null;
  progressSummary: string;
  blocker: string | null;
}

interface QueueFile {
  schemaVersion: string;
  requests: Record<string, ExecutionRequest>;
}

export interface QueueOptions extends RegistryOptions {
  executionLeaseMs?: number;
}

function queueError<T>(
  errorCode: string,
  message: string,
  meta: WorkspaceMetadataFields,
  currentRevision?: number
): WorkflowResult<T> {
  return { ok: false, errorCode, message, ...meta, ...(currentRevision !== undefined ? { currentRevision } : {}) };
}

function readQueue(dataDir: string): QueueFile {
  return readJsonFileOrDefault<QueueFile>(path.join(dataDir, EXECUTION_QUEUE_FILE), {
    schemaVersion: EXECUTION_QUEUE_SCHEMA_VERSION,
    requests: {},
  });
}

function publicRequest(request: ExecutionRequest): ExecutionRequest {
  return { ...request };
}

function unwrapLocked<T>(
  locked: ReturnType<typeof withRegistryLock<WorkflowResult<T>>>
): WorkflowResult<T> {
  if (!locked.ok) {
    return queueError(locked.errorCode, locked.message, {
      workspaceId: null,
      displayName: null,
      rootFingerprint: null,
      workspaceResolution: "binding",
    });
  }
  return locked.data;
}

function resolveBoundContext(bindingId: string, options?: QueueOptions) {
  return resolveToolWorkspace({
    workspaceBindingId: bindingId,
    registryOptions: options,
  });
}

export function submitExecutionRequest(
  input: { workspaceBindingId: string; userConfirmedPlanHandoff: boolean },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  const resolved = resolveBoundContext(input.workspaceBindingId, options);
  if (!resolved.ok) {
    return queueError(resolved.errorCode, resolved.message, {
      workspaceId: null,
      displayName: null,
      rootFingerprint: null,
      workspaceResolution: "binding",
    });
  }
  const ws = resolved.data;
  const meta: WorkspaceMetadataFields = {
    workspaceId: ws.workspaceId,
    displayName: ws.displayName,
    rootFingerprint: ws.rootFingerprint,
    workspaceResolution: "binding",
  };
  if (input.userConfirmedPlanHandoff !== true) {
    return queueError(
      "USER_CONFIRMATION_REQUIRED",
      "Cần người dùng xác nhận gửi kế hoạch đã duyệt sang Antigravity.",
      meta
    );
  }

  const resumed = resumeTask(undefined, {
    detailLevel: "compact",
    workspaceBindingId: input.workspaceBindingId,
    registryOptions: options,
  });
  if (!resumed.ok) return resumed;
  const task = resumed.data as ResumeTaskCompactOutput;
  if (!task.hasApprovedPlan || !task.taskId) {
    return queueError("NO_APPROVED_PLAN", "Chưa có approved plan để gửi thực thi.", meta);
  }
  const taskId = task.taskId;

  const locked = withRegistryLock((dataDir): WorkflowResult<ExecutionRequest> => {
    const queue = readQueue(dataDir);
    const existing = Object.values(queue.requests).find(
      (r) => r.workspaceId === ws.workspaceId && r.taskId === taskId && !["completed", "cancelled"].includes(r.status)
    );
    if (existing) {
      return queueError(
        "EXECUTION_REQUEST_ALREADY_EXISTS",
        `Task '${task.taskId}' đã có execution request '${existing.requestId}' ở trạng thái '${existing.status}'.`,
        meta,
        existing.revision
      );
    }
    const now = (options?.now ?? new Date()).toISOString();
    const request: ExecutionRequest = {
      requestId: `exec_${crypto.randomBytes(16).toString("hex")}`,
      workspaceId: ws.workspaceId,
      displayName: ws.displayName,
      rootFingerprint: ws.rootFingerprint,
      taskId,
      objective: task.objective,
      status: "pending_user_start",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      userApprovedPlanHandoff: true,
      userApprovedExecutionAt: null,
      executorId: null,
      executionLeaseExpiresAt: null,
      progressSummary: "Đang chờ người dùng phê duyệt Start trong Antigravity.",
      blocker: null,
    };
    queue.requests[request.requestId] = request;
    writeJsonAtomic(dataDir, EXECUTION_QUEUE_FILE, queue);
    return { ok: true, summaryText: `Đã gửi task '${request.taskId}' sang Antigravity; đang chờ HITL Start.`, data: publicRequest(request) };
  }, options);
  return unwrapLocked(locked);
}

/**
 * Phase 5.1 multi-task dispatch path. It deliberately does not read the legacy
 * single-slot APPROVED_PLAN/TASK_STATE files, so a completed unarchived task
 * cannot block a newly approved work item.
 */
export function submitExecutionRequestForTask(
  input: {
    workspaceBindingId: string;
    taskId: string;
    objective: string;
    userConfirmedPlanHandoff: boolean;
  },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  const resolved = resolveBoundContext(input.workspaceBindingId, options);
  if (!resolved.ok) {
    return queueError(resolved.errorCode, resolved.message, {
      workspaceId: null,
      displayName: null,
      rootFingerprint: null,
      workspaceResolution: "binding",
    });
  }
  const ws = resolved.data;
  const meta: WorkspaceMetadataFields = {
    workspaceId: ws.workspaceId,
    displayName: ws.displayName,
    rootFingerprint: ws.rootFingerprint,
    workspaceResolution: "binding",
  };
  if (input.userConfirmedPlanHandoff !== true) {
    return queueError("USER_CONFIRMATION_REQUIRED", "Cần người dùng duyệt kế hoạch và xác nhận gửi sang Antigravity.", meta);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.taskId)) {
    return queueError("INVALID_TASK_ID", "taskId không hợp lệ.", meta);
  }

  const locked = withRegistryLock((dataDir): WorkflowResult<ExecutionRequest> => {
    const queue = readQueue(dataDir);
    const existing = Object.values(queue.requests).find(
      (request) => request.workspaceId === ws.workspaceId && request.taskId === input.taskId
    );
    if (existing) {
      return existing.objective === input.objective
        ? { ok: true, summaryText: `Task '${input.taskId}' đã được dispatch trước đó.`, data: publicRequest(existing) }
        : queueError("TASK_ID_COLLISION", `taskId '${input.taskId}' đã được dùng cho objective khác.`, meta, existing.revision);
    }

    const now = (options?.now ?? new Date()).toISOString();
    const request: ExecutionRequest = {
      requestId: `exec_${crypto.randomBytes(16).toString("hex")}`,
      workspaceId: ws.workspaceId,
      displayName: ws.displayName,
      rootFingerprint: ws.rootFingerprint,
      taskId: input.taskId,
      objective: input.objective,
      status: "pending_user_start",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      userApprovedPlanHandoff: true,
      userApprovedExecutionAt: null,
      executorId: null,
      executionLeaseExpiresAt: null,
      progressSummary: "Đang chờ người dùng phê duyệt Start trong Antigravity.",
      blocker: null,
    };
    queue.requests[request.requestId] = request;
    writeJsonAtomic(dataDir, EXECUTION_QUEUE_FILE, queue);
    return { ok: true, summaryText: `Đã dispatch task độc lập '${request.taskId}' sang Antigravity; đang chờ HITL Start.`, data: publicRequest(request) };
  }, options);
  return unwrapLocked(locked);
}

export function listExecutionRequests(
  workspaceBindingId: string,
  options?: QueueOptions
): WorkflowResult<{ requests: ExecutionRequest[] }> {
  const resolved = resolveBoundContext(workspaceBindingId, options);
  if (!resolved.ok) {
    return queueError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  }
  const ws = resolved.data;
  const locked = withRegistryLock((dataDir): WorkflowResult<{ requests: ExecutionRequest[] }> => {
    const queue = readQueue(dataDir);
    const requests = Object.values(queue.requests)
      .filter((r) => r.workspaceId === ws.workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicRequest);
    return {
      ok: true,
      summaryText: `Có ${requests.length} execution request cho dự án '${ws.displayName}'.`,
      data: { requests },
    };
  }, options);
  return unwrapLocked(locked);
}

/** Read-only hook/sidecar view keyed by the already-verified workspaceId. */
export function listActionableExecutionRequestsForWorkspace(
  workspaceId: string,
  options?: QueueOptions
): WorkflowResult<{ requests: ExecutionRequest[] }> {
  const locked = withRegistryLock((dataDir): WorkflowResult<{ requests: ExecutionRequest[] }> => {
    const queue = readQueue(dataDir);
    const actionable = new Set<ExecutionStatus>([
      "pending_user_start",
      "queued",
      "executing",
      "blocked",
      "review",
    ]);
    const requests = Object.values(queue.requests)
      .filter((request) => request.workspaceId === workspaceId && actionable.has(request.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicRequest);
    return {
      ok: true,
      summaryText: `Có ${requests.length} execution request cần chú ý.`,
      data: { requests },
    };
  }, options);
  return unwrapLocked(locked);
}

function mutateRequest(
  workspaceBindingId: string,
  requestId: string,
  options: QueueOptions | undefined,
  mutate: (request: ExecutionRequest, now: Date) => WorkflowResult<ExecutionRequest>
): WorkflowResult<ExecutionRequest> {
  const resolved = resolveBoundContext(workspaceBindingId, options);
  if (!resolved.ok) {
    return queueError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  }
  const ws = resolved.data;
  const meta: WorkspaceMetadataFields = { workspaceId: ws.workspaceId, displayName: ws.displayName, rootFingerprint: ws.rootFingerprint, workspaceResolution: "binding" };
  const locked = withRegistryLock((dataDir): WorkflowResult<ExecutionRequest> => {
    const queue = readQueue(dataDir);
    const request = queue.requests[requestId];
    if (!request || request.workspaceId !== ws.workspaceId) {
      return queueError("EXECUTION_REQUEST_NOT_FOUND", `Không tìm thấy execution request '${requestId}' trong workspace hiện tại.`, meta);
    }
    const result = mutate(request, options?.now ?? new Date());
    if (result.ok) {
      queue.requests[requestId] = result.data;
      writeJsonAtomic(dataDir, EXECUTION_QUEUE_FILE, queue);
    }
    return result;
  }, options);
  return unwrapLocked(locked);
}

export function approveExecutionStart(
  input: { workspaceBindingId: string; requestId: string; userConfirmedStart: boolean; expectedRevision: number },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  return mutateRequest(input.workspaceBindingId, input.requestId, options, (request, now) => {
    const meta: WorkspaceMetadataFields = { workspaceId: request.workspaceId, displayName: request.displayName, rootFingerprint: request.rootFingerprint, workspaceResolution: "binding" };
    if (input.userConfirmedStart !== true) return queueError("USER_CONFIRMATION_REQUIRED", "Người dùng phải xác nhận Start trong Antigravity.", meta, request.revision);
    if (input.expectedRevision !== request.revision) return queueError("REVISION_CONFLICT", "Execution request đã thay đổi; hãy tải lại trạng thái.", meta, request.revision);
    if (request.status !== "pending_user_start") return queueError("INVALID_EXECUTION_TRANSITION", `Không thể approve Start từ trạng thái '${request.status}'.`, meta, request.revision);
    const updated = { ...request, status: "queued" as const, revision: request.revision + 1, updatedAt: now.toISOString(), userApprovedExecutionAt: now.toISOString(), progressSummary: "Người dùng đã duyệt Start; sẵn sàng để Antigravity claim." };
    return { ok: true, summaryText: `Đã duyệt Start cho task '${request.taskId}'.`, data: updated };
  });
}

export function claimExecutionRequest(
  input: { workspaceBindingId: string; requestId: string; executorId: string; expectedRevision: number },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  return mutateRequest(input.workspaceBindingId, input.requestId, options, (request, now) => {
    const meta: WorkspaceMetadataFields = { workspaceId: request.workspaceId, displayName: request.displayName, rootFingerprint: request.rootFingerprint, workspaceResolution: "binding" };
    if (input.expectedRevision !== request.revision) return queueError("REVISION_CONFLICT", "Execution request đã thay đổi; không claim bằng revision cũ.", meta, request.revision);
    if (request.status !== "queued") return queueError("INVALID_EXECUTION_TRANSITION", `Chỉ request 'queued' mới được claim; hiện tại là '${request.status}'.`, meta, request.revision);
    const leaseMs = options?.executionLeaseMs ?? 15 * 60 * 1000;
    const updated = { ...request, status: "executing" as const, revision: request.revision + 1, updatedAt: now.toISOString(), executorId: input.executorId, executionLeaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(), progressSummary: `Đã được Antigravity executor '${input.executorId}' claim.` };
    return { ok: true, summaryText: `Antigravity đã claim task '${request.taskId}'.`, data: updated };
  });
}

export function updateExecutionProgress(
  input: { workspaceBindingId: string; requestId: string; executorId: string; expectedRevision: number; status: "executing" | "blocked" | "review" | "completed"; progressSummary: string; blocker?: string },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  return mutateRequest(input.workspaceBindingId, input.requestId, options, (request, now) => {
    const meta: WorkspaceMetadataFields = { workspaceId: request.workspaceId, displayName: request.displayName, rootFingerprint: request.rootFingerprint, workspaceResolution: "binding" };
    if (input.expectedRevision !== request.revision) return queueError("REVISION_CONFLICT", "Execution request đã thay đổi; không cập nhật bằng revision cũ.", meta, request.revision);
    if (request.executorId !== input.executorId) return queueError("EXECUTOR_MISMATCH", "Chỉ executor đã claim mới được cập nhật tiến độ.", meta, request.revision);
    if (!["executing", "blocked", "review"].includes(request.status)) return queueError("INVALID_EXECUTION_TRANSITION", `Không thể cập nhật từ trạng thái '${request.status}'.`, meta, request.revision);
    const updated = { ...request, status: input.status, revision: request.revision + 1, updatedAt: now.toISOString(), progressSummary: input.progressSummary, blocker: input.status === "blocked" ? (input.blocker ?? "Chưa nêu blocker") : null, executionLeaseExpiresAt: input.status === "executing" ? new Date(now.getTime() + (options?.executionLeaseMs ?? 15 * 60 * 1000)).toISOString() : null };
    return { ok: true, summaryText: `Đã cập nhật execution '${request.requestId}' sang '${input.status}'.`, data: updated };
  });
}

export function cancelExecutionRequest(
  input: { workspaceBindingId: string; requestId: string; expectedRevision: number; userConfirmedCancel: boolean },
  options?: QueueOptions
): WorkflowResult<ExecutionRequest> {
  return mutateRequest(input.workspaceBindingId, input.requestId, options, (request, now) => {
    const meta: WorkspaceMetadataFields = { workspaceId: request.workspaceId, displayName: request.displayName, rootFingerprint: request.rootFingerprint, workspaceResolution: "binding" };
    if (input.userConfirmedCancel !== true) return queueError("USER_CONFIRMATION_REQUIRED", "Cần người dùng xác nhận hủy execution request.", meta, request.revision);
    if (input.expectedRevision !== request.revision) return queueError("REVISION_CONFLICT", "Execution request đã thay đổi; không hủy bằng revision cũ.", meta, request.revision);
    if (["completed", "cancelled"].includes(request.status)) return queueError("INVALID_EXECUTION_TRANSITION", `Request đã ở trạng thái '${request.status}'.`, meta, request.revision);
    const updated = { ...request, status: "cancelled" as const, revision: request.revision + 1, updatedAt: now.toISOString(), executionLeaseExpiresAt: null, progressSummary: "Đã hủy theo xác nhận của người dùng." };
    return { ok: true, summaryText: `Đã hủy execution request cho task '${request.taskId}'.`, data: updated };
  });
}
