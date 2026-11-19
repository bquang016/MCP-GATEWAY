import path from "node:path";
import {
  RegistryOptions,
  resolveToolWorkspace,
  withRegistryLock,
  readJsonFileOrDefault,
  writeJsonAtomic,
} from "../registry/workspace-registry.js";
import { isValidTaskId, isValidRelativeProjectPath } from "../config.js";
import { WorkflowResult, WorkspaceMetadataFields } from "../memory/project-memory.js";

export type ProjectTaskStatus =
  | "planned"
  | "ready"
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export interface ProjectTaskRecord {
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  taskId: string;
  objective: string;
  inScope: string[];
  outOfScope: string[];
  doNotChange: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  plannedFiles: string[];
  status: ProjectTaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  progressSummary: string;
  blocker: string | null;
}

interface TaskRegistryFile {
  schemaVersion: "1.0";
  tasks: Record<string, ProjectTaskRecord>;
}

const TASK_REGISTRY_FILE = "task-registry.json";

function taskKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`;
}

function makeMeta(ws: { workspaceId: string; displayName: string; rootFingerprint: string }): WorkspaceMetadataFields {
  return { workspaceId: ws.workspaceId, displayName: ws.displayName, rootFingerprint: ws.rootFingerprint, workspaceResolution: "binding" };
}

function taskError<T>(errorCode: string, message: string, meta: WorkspaceMetadataFields, currentRevision?: number): WorkflowResult<T> {
  return { ok: false, errorCode, message, ...meta, ...(currentRevision !== undefined ? { currentRevision } : {}) };
}

function readTasks(dataDir: string): TaskRegistryFile {
  return readJsonFileOrDefault<TaskRegistryFile>(path.join(dataDir, TASK_REGISTRY_FILE), { schemaVersion: "1.0", tasks: {} });
}

function unwrap<T>(locked: ReturnType<typeof withRegistryLock<WorkflowResult<T>>>): WorkflowResult<T> {
  if (!locked.ok) return taskError(locked.errorCode, locked.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  return locked.data;
}

export function registerProjectTask(
  input: {
    workspaceBindingId: string;
    taskId: string;
    objective: string;
    inScope: string[];
    outOfScope: string[];
    doNotChange: string[];
    acceptanceCriteria: string[];
    dependencies: string[];
    plannedFiles: string[];
    userApprovedIntentContract: boolean;
  },
  options?: RegistryOptions
): WorkflowResult<ProjectTaskRecord> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return taskError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data;
  const meta = makeMeta(ws);
  if (input.userApprovedIntentContract !== true) return taskError("USER_CONFIRMATION_REQUIRED", "Cần người dùng duyệt Intent Contract trước khi đăng ký task.", meta);
  if (!isValidTaskId(input.taskId)) return taskError("INVALID_TASK_ID", "taskId không hợp lệ.", meta);
  if (!input.objective.trim() || input.acceptanceCriteria.length === 0) return taskError("INVALID_INTENT_CONTRACT", "Objective và acceptance criteria không được rỗng.", meta);
  for (const file of input.plannedFiles) {
    if (!isValidRelativeProjectPath(file, ws.canonicalRoot)) return taskError("INVALID_PLANNED_FILE", `plannedFiles chứa path không an toàn: ${file}`, meta);
  }
  if (input.dependencies.includes(input.taskId)) return taskError("INVALID_DEPENDENCY", "Task không thể phụ thuộc chính nó.", meta);

  const locked = withRegistryLock((dataDir): WorkflowResult<ProjectTaskRecord> => {
    const registry = readTasks(dataDir);
    const key = taskKey(ws.workspaceId, input.taskId);
    if (registry.tasks[key]) return taskError("TASK_ALREADY_EXISTS", `Task '${input.taskId}' đã tồn tại trong project.`, meta, registry.tasks[key].revision);
    for (const dependency of input.dependencies) {
      if (!registry.tasks[taskKey(ws.workspaceId, dependency)]) return taskError("DEPENDENCY_NOT_FOUND", `Không tìm thấy dependency '${dependency}' trong cùng project.`, meta);
    }
    const now = (options?.now ?? new Date()).toISOString();
    const record: ProjectTaskRecord = {
      workspaceId: ws.workspaceId,
      displayName: ws.displayName,
      rootFingerprint: ws.rootFingerprint,
      taskId: input.taskId,
      objective: input.objective,
      inScope: input.inScope,
      outOfScope: input.outOfScope,
      doNotChange: input.doNotChange,
      acceptanceCriteria: input.acceptanceCriteria,
      dependencies: input.dependencies,
      plannedFiles: [...new Set(input.plannedFiles)],
      status: input.dependencies.length > 0 ? "planned" : "ready",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      progressSummary: "Intent Contract đã được duyệt; chưa bắt đầu thực thi.",
      blocker: null,
    };
    registry.tasks[key] = record;
    writeJsonAtomic(dataDir, TASK_REGISTRY_FILE, registry);
    return { ok: true, summaryText: `Đã đăng ký task '${record.taskId}' trong project '${record.displayName}'.`, data: record };
  }, options);
  return unwrap(locked);
}

export function listProjectTasks(workspaceBindingId: string, options?: RegistryOptions): WorkflowResult<{ tasks: ProjectTaskRecord[] }> {
  const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return taskError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data;
  const locked = withRegistryLock((dataDir): WorkflowResult<{ tasks: ProjectTaskRecord[] }> => {
    const registry = readTasks(dataDir);
    const tasks = Object.values(registry.tasks).filter((task) => task.workspaceId === ws.workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { ok: true, summaryText: `Project '${ws.displayName}' có ${tasks.length} task trong registry.`, data: { tasks } };
  }, options);
  return unwrap(locked);
}

export function activateProjectTask(
  input: { workspaceBindingId: string; taskId: string; expectedRevision: number; userConfirmedActivation: boolean },
  options?: RegistryOptions
): WorkflowResult<ProjectTaskRecord> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return taskError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data;
  const meta = makeMeta(ws);
  if (input.userConfirmedActivation !== true) return taskError("USER_CONFIRMATION_REQUIRED", "Cần người dùng xác nhận kích hoạt task.", meta);
  const locked = withRegistryLock((dataDir): WorkflowResult<ProjectTaskRecord> => {
    const registry = readTasks(dataDir);
    const record = registry.tasks[taskKey(ws.workspaceId, input.taskId)];
    if (!record) return taskError("TASK_NOT_FOUND", `Không tìm thấy task '${input.taskId}'.`, meta);
    if (record.revision !== input.expectedRevision) return taskError("REVISION_CONFLICT", "Task registry đã thay đổi; hãy tải lại.", meta, record.revision);
    if (!["ready", "paused", "blocked", "planned"].includes(record.status)) return taskError("INVALID_TASK_TRANSITION", `Không thể activate task từ '${record.status}'.`, meta, record.revision);
    const incomplete = record.dependencies.filter((dependency) => registry.tasks[taskKey(ws.workspaceId, dependency)]?.status !== "completed");
    if (incomplete.length > 0) return taskError("DEPENDENCIES_INCOMPLETE", `Dependency chưa hoàn thành: ${incomplete.join(", ")}`, meta, record.revision);
    const conflicts = Object.values(registry.tasks).filter((other) =>
      other.workspaceId === ws.workspaceId && other.taskId !== record.taskId && other.status === "active" && other.plannedFiles.some((file) => record.plannedFiles.includes(file))
    );
    if (conflicts.length > 0) return taskError("FILE_CLAIM_CONFLICT", `Task xung đột file với: ${conflicts.map((task) => task.taskId).join(", ")}`, meta, record.revision);
    const now = (options?.now ?? new Date()).toISOString();
    const updated: ProjectTaskRecord = { ...record, status: "active", revision: record.revision + 1, updatedAt: now, blocker: null, progressSummary: "Task đã được người dùng kích hoạt." };
    registry.tasks[taskKey(ws.workspaceId, input.taskId)] = updated;
    writeJsonAtomic(dataDir, TASK_REGISTRY_FILE, registry);
    return { ok: true, summaryText: `Đã activate task '${record.taskId}' và claim ${record.plannedFiles.length} file dự kiến.`, data: updated };
  }, options);
  return unwrap(locked);
}

export function updateProjectTask(
  input: { workspaceBindingId: string; taskId: string; expectedRevision: number; status: ProjectTaskStatus; progressSummary: string; blocker?: string },
  options?: RegistryOptions
): WorkflowResult<ProjectTaskRecord> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return taskError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data;
  const meta = makeMeta(ws);
  const locked = withRegistryLock((dataDir): WorkflowResult<ProjectTaskRecord> => {
    const registry = readTasks(dataDir);
    const key = taskKey(ws.workspaceId, input.taskId);
    const record = registry.tasks[key];
    if (!record) return taskError("TASK_NOT_FOUND", `Không tìm thấy task '${input.taskId}'.`, meta);
    if (record.revision !== input.expectedRevision) return taskError("REVISION_CONFLICT", "Task registry đã thay đổi; hãy tải lại.", meta, record.revision);
    if (record.status === "completed" || record.status === "cancelled") return taskError("INVALID_TASK_TRANSITION", `Task '${input.taskId}' đã terminal.`, meta, record.revision);
    const updated: ProjectTaskRecord = { ...record, status: input.status, revision: record.revision + 1, updatedAt: (options?.now ?? new Date()).toISOString(), progressSummary: input.progressSummary, blocker: input.status === "blocked" ? (input.blocker ?? "Chưa nêu blocker") : null };
    registry.tasks[key] = updated;
    if (updated.status === "completed") {
      for (const dependent of Object.values(registry.tasks)) {
        if (dependent.workspaceId === ws.workspaceId && dependent.status === "planned" && dependent.dependencies.includes(updated.taskId)) {
          const ready = dependent.dependencies.every((dep) => registry.tasks[taskKey(ws.workspaceId, dep)]?.status === "completed");
          if (ready) registry.tasks[taskKey(ws.workspaceId, dependent.taskId)] = { ...dependent, status: "ready", revision: dependent.revision + 1, updatedAt: updated.updatedAt, progressSummary: "Tất cả dependency đã hoàn thành; task sẵn sàng." };
        }
      }
    }
    writeJsonAtomic(dataDir, TASK_REGISTRY_FILE, registry);
    return { ok: true, summaryText: `Đã cập nhật task '${updated.taskId}' sang '${updated.status}'.`, data: updated };
  }, options);
  return unwrap(locked);
}
