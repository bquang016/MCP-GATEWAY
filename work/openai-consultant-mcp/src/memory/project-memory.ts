import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_FILES,
  MemoryFileName,
  resolveMemoryFilePath,
  resolveArchiveRootPath,
  isSymbolicLinkPath,
} from "../config.js";
import {
  PROJECT_CONTEXT_TEMPLATE,
  APPROVED_PLAN_TEMPLATE,
  TASK_STATE_TEMPLATE,
  DECISIONS_TEMPLATE,
  HANDOFF_TEMPLATE,
} from "./templates.js";
import { writeMemoryFileAtomic } from "./safe-write.js";
import {
  readApprovedPlan,
  readTaskState,
  WorkspaceMetadataFields,
  WorkflowWorkspaceOptions,
  WorkflowResult,
  extractWorkspaceMetadata,
  buildUnresolvedWorkspaceMeta,
  verifyProjectMemoryWorkspaceMatch,
  resumeTask,
  ResumeTaskCompactOutput,
} from "./workflow.js";
import {
  RegistryOptions,
  ResolvedWorkspaceContext,
  resolveToolWorkspace,
  createBindingForActiveWorkspace,
} from "../registry/workspace-registry.js";

export * from "./workflow.js";
export * from "../registry/workspace-registry.js";

export interface MemoryStatusFiles {
  projectContext: boolean;
  approvedPlan: boolean;
  taskState: boolean;
  decisions: boolean;
  handoff: boolean;
}

export interface MemoryStatusResult extends WorkspaceMetadataFields {
  configured: boolean;
  workspaceExists: boolean;
  memoryDirectoryExists: boolean;
  files: MemoryStatusFiles;
  activeTask: boolean;
  activeTaskId: string | null;
  activeRevision: number;
  archiveCount: number;
}

export interface MemoryInitResult extends WorkspaceMetadataFields {
  success: boolean;
  errorCode?: string;
  created: string[];
  alreadyExisted: string[];
  errors: string[];
  errorMessage?: string;
}

const PRIVATE_MEMORY_GIT_EXCLUDE_RULE = "/.ai/";
const PRIVATE_GRAPH_GIT_EXCLUDE_RULES = [
  "/graphify-out/",
  "/.graphify-cache/",
  "/.context-capsules/",
];

function ensureLocalGitExcludeRules(workspaceRoot: string, rules: string[]): boolean {
  const gitMetadataPath = path.join(workspaceRoot, ".git");
  if (!fs.existsSync(gitMetadataPath)) return false;
  const metadataStat = fs.lstatSync(gitMetadataPath);
  if (metadataStat.isSymbolicLink()) throw new Error("Git metadata path must not be a symbolic link.");
  if (!metadataStat.isDirectory()) return false;
  const infoDir = path.join(gitMetadataPath, "info");
  const excludePath = path.join(infoDir, "exclude");
  fs.mkdirSync(infoDir, { recursive: true });
  let current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
  const normalized = new Set(current.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  for (const rule of rules) {
    if (normalized.has(rule)) continue;
    if (current.length > 0 && !current.endsWith("\n")) current += "\n";
    current += `${rule}\n`;
    normalized.add(rule);
  }
  fs.writeFileSync(excludePath, current, "utf-8");
  return true;
}

/**
 * Keeps the private workflow store out of normal Git discovery without
 * changing any tracked repository file. The rule lives only in the local
 * repository metadata and is safe to apply repeatedly.
 */
export function ensurePrivateMemoryGitExcluded(workspaceRoot: string): boolean {
  return ensureLocalGitExcludeRules(workspaceRoot, [PRIVATE_MEMORY_GIT_EXCLUDE_RULE]);
}

export function ensureGraphArtifactsGitExcluded(workspaceRoot: string): boolean {
  return ensureLocalGitExcludeRules(workspaceRoot, PRIVATE_GRAPH_GIT_EXCLUDE_RULES);
}

export interface AttachActiveWorkspaceInput {
  initializeIfMissing: boolean;
}

export interface AttachActiveWorkspaceOutput extends WorkspaceMetadataFields {
  bindingId: string;
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  bindingExpiresAt: string;
  projectMemoryInitialized: boolean;
  created: string[];
  alreadyExisted: string[];
  workspaceResolution: "binding";
}

export interface StartWorkSessionOutput extends WorkspaceMetadataFields {
  sessionReady: true;
  bindingId: string;
  bindingExpiresAt: string;
  projectMemoryInitialized: boolean;
  mode: "new_task" | "resume_existing_task" | "completed_pending_archive";
  requiresUserDecision: boolean;
  userMessage: string;
  task: {
    hasApprovedPlan: boolean;
    taskId: string | null;
    revision: number;
    status: string;
    objective: string;
    currentState: string;
    nextSteps: string[];
    blockers: string[];
    openQuestions: string[];
    doNotRedo: string[];
    recommendedNextAction: string | null;
  };
}

function isRegularFile(memoryDir: string, fileName: MemoryFileName): boolean {
  try {
    const filePath = resolveMemoryFilePath(memoryDir, fileName);
    return (
      fs.existsSync(filePath) &&
      !isSymbolicLinkPath(filePath) &&
      fs.lstatSync(filePath).isFile()
    );
  } catch {
    return false;
  }
}

function countArchivedTasks(memoryDir: string): number {
  try {
    const archiveRoot = resolveArchiveRootPath(memoryDir);
    if (!fs.existsSync(archiveRoot) || isSymbolicLinkPath(archiveRoot)) {
      return 0;
    }
    const stat = fs.lstatSync(archiveRoot);
    if (!stat.isDirectory()) {
      return 0;
    }
    const entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).length;
  } catch {
    return 0;
  }
}

function buildStatusFromResolved(wsContext: ResolvedWorkspaceContext): MemoryStatusResult {
  const meta = extractWorkspaceMetadata(wsContext);
  let memoryDirExists = false;
  try {
    memoryDirExists =
      fs.existsSync(wsContext.memoryDir) &&
      !isSymbolicLinkPath(wsContext.memoryDir) &&
      fs.lstatSync(wsContext.memoryDir).isDirectory();
  } catch {
    memoryDirExists = false;
  }

  let activeTask = false;
  let activeTaskId: string | null = null;
  let activeRevision = 0;
  let archiveCount = 0;

  if (memoryDirExists) {
    try {
      const plan = readApprovedPlan(wsContext.memoryDir);
      const taskState = readTaskState(wsContext.memoryDir);
      activeTaskId = plan.hasApprovedPlan ? plan.taskId : taskState.taskId || null;
      activeTask = Boolean(plan.hasApprovedPlan && activeTaskId);
      activeRevision = taskState.revision;
    } catch {
      activeTask = false;
      activeTaskId = null;
      activeRevision = 0;
    }

    archiveCount = countArchivedTasks(wsContext.memoryDir);
  }

  return {
    configured: true,
    workspaceExists: true,
    memoryDirectoryExists: memoryDirExists,
    files: {
      projectContext:
        memoryDirExists && isRegularFile(wsContext.memoryDir, MEMORY_FILES.PROJECT_CONTEXT),
      approvedPlan:
        memoryDirExists && isRegularFile(wsContext.memoryDir, MEMORY_FILES.APPROVED_PLAN),
      taskState:
        memoryDirExists && isRegularFile(wsContext.memoryDir, MEMORY_FILES.TASK_STATE),
      decisions:
        memoryDirExists && isRegularFile(wsContext.memoryDir, MEMORY_FILES.DECISIONS),
      handoff:
        memoryDirExists && isRegularFile(wsContext.memoryDir, MEMORY_FILES.HANDOFF),
    },
    activeTask,
    activeTaskId,
    activeRevision,
    archiveCount,
    ...meta,
  };
}

/**
 * Returns the current status of Project Memory (.ai directory, five files, active task state, and archive count).
 * Safe when MCP_WORKSPACE_ROOT is not configured or workspace does not exist.
 */
export function getProjectMemoryStatus(
  customRoot?: string,
  options?: WorkflowWorkspaceOptions
): MemoryStatusResult {
  const resolved = resolveToolWorkspace({
    workspaceBindingId: options?.workspaceBindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return {
      configured: false,
      workspaceExists: false,
      memoryDirectoryExists: false,
      files: {
        projectContext: false,
        approvedPlan: false,
        taskState: false,
        decisions: false,
        handoff: false,
      },
      activeTask: false,
      activeTaskId: null,
      activeRevision: 0,
      archiveCount: 0,
      ...buildUnresolvedWorkspaceMeta(options?.workspaceBindingId),
    };
  }

  return buildStatusFromResolved(resolved.data);
}

/**
 * Binding-aware status resolution for MCP tool `project_memory_status`.
 * Returns WORKSPACE_NOT_RESOLVED when neither workspaceBindingId nor MCP_WORKSPACE_ROOT is configured,
 * and never falls back to environment if workspaceBindingId was provided and failed.
 */
export function resolveProjectMemoryStatus(
  options?: WorkflowWorkspaceOptions,
  customRoot?: string
): WorkflowResult<MemoryStatusResult> {
  const resolved = resolveToolWorkspace({
    workspaceBindingId: options?.workspaceBindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      errorCode: resolved.errorCode,
      message: resolved.message,
      ...buildUnresolvedWorkspaceMeta(options?.workspaceBindingId),
    };
  }

  const status = buildStatusFromResolved(resolved.data);
  return {
    ok: true,
    summaryText: JSON.stringify(status, null, 2),
    data: status,
  };
}

/**
 * Initializes Project Memory in <workspaceRoot>/.ai with the five template files.
 * Idempotent: Never overwrites existing files.
 */
export function initializeProjectMemory(
  customRoot?: string,
  options?: WorkflowWorkspaceOptions
): MemoryInitResult {
  const bindingId = options?.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return {
      success: false,
      errorCode: resolved.errorCode,
      created: [],
      alreadyExisted: [],
      errors: [resolved.message],
      errorMessage: resolved.message,
      ...buildUnresolvedWorkspaceMeta(bindingId),
    };
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  const created: string[] = [];
  const alreadyExisted: string[] = [];
  const errors: string[] = [];

  try {
    ensurePrivateMemoryGitExcluded(wsContext.canonicalRoot);
    if (!fs.existsSync(wsContext.memoryDir)) {
      fs.mkdirSync(wsContext.memoryDir, { recursive: true });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "INITIALIZATION_FAILED",
      created,
      alreadyExisted,
      errors: [`Không thể chuẩn bị bộ nhớ nội bộ: ${message}`],
      errorMessage: "Không thể chuẩn bị bộ nhớ nội bộ trong workspace.",
      ...meta,
    };
  }

  // Workspace mismatch protection if .ai already contains an active task from another workspace
  try {
    const existingPlan = readApprovedPlan(wsContext.memoryDir);
    const existingTaskState = readTaskState(wsContext.memoryDir);
    const mismatchError = verifyProjectMemoryWorkspaceMatch(
      wsContext,
      existingPlan,
      existingTaskState
    );
    if (mismatchError) {
      return {
        success: false,
        errorCode: mismatchError.errorCode,
        created,
        alreadyExisted,
        errors: [mismatchError.message],
        errorMessage: mismatchError.message,
        ...meta,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "WORKSPACE_MISMATCH",
      created,
      alreadyExisted,
      errors: [message],
      errorMessage: message,
      ...meta,
    };
  }

  const templateMap: Array<{ name: MemoryFileName; template: string }> = [
    { name: MEMORY_FILES.PROJECT_CONTEXT, template: PROJECT_CONTEXT_TEMPLATE },
    { name: MEMORY_FILES.APPROVED_PLAN, template: APPROVED_PLAN_TEMPLATE },
    { name: MEMORY_FILES.TASK_STATE, template: TASK_STATE_TEMPLATE },
    { name: MEMORY_FILES.DECISIONS, template: DECISIONS_TEMPLATE },
    { name: MEMORY_FILES.HANDOFF, template: HANDOFF_TEMPLATE },
  ];

  for (const item of templateMap) {
    try {
      const targetPath = resolveMemoryFilePath(wsContext.memoryDir, item.name);
      if (fs.existsSync(targetPath)) {
        alreadyExisted.push(item.name);
      } else {
        writeMemoryFileAtomic(wsContext.memoryDir, item.name, item.template);
        created.push(item.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Lỗi khi xử lý ${item.name}: ${message}`);
    }
  }

  return {
    success: errors.length === 0,
    ...(errors.length > 0 ? { errorCode: "INITIALIZATION_FAILED" } : {}),
    created,
    alreadyExisted,
    errors,
    ...meta,
  };
}

/**
 * Tool: attach_active_workspace
 * Attaches to the currently active workspace in the global registry, creates a session binding,
 * and optionally initializes .ai without overwriting existing files.
 * Never returns canonicalRoot.
 */
export function attachActiveWorkspace(
  input: AttachActiveWorkspaceInput,
  registryOptions?: RegistryOptions
): WorkflowResult<AttachActiveWorkspaceOutput> {
  const bindResult = createBindingForActiveWorkspace(registryOptions);
  if (!bindResult.ok) {
    return {
      ok: false,
      errorCode: bindResult.errorCode,
      message: bindResult.message,
      workspaceId: null,
      displayName: null,
      rootFingerprint: null,
      workspaceResolution: "binding",
    };
  }

  const { binding, workspace } = bindResult.data;
  let created: string[] = [];
  let alreadyExisted: string[] = [];

  if (input.initializeIfMissing === true) {
    const initRes = initializeProjectMemory(workspace.canonicalRoot);
    if (!initRes.success) {
      return {
        ok: false,
        errorCode: initRes.errorCode || "INITIALIZATION_FAILED",
        message:
          initRes.errorMessage ||
          "Không thể khởi tạo Project Memory cho active workspace.",
        workspaceId: workspace.workspaceId,
        displayName: workspace.displayName,
        rootFingerprint: workspace.rootFingerprint,
        workspaceResolution: "binding",
      };
    }
    created = initRes.created;
    alreadyExisted = initRes.alreadyExisted;
  }

  const status = getProjectMemoryStatus(workspace.canonicalRoot);
  const projectMemoryInitialized = Boolean(
    status.memoryDirectoryExists &&
      status.files.projectContext &&
      status.files.approvedPlan &&
      status.files.taskState &&
      status.files.decisions &&
      status.files.handoff
  );

  const output: AttachActiveWorkspaceOutput = {
    bindingId: binding.bindingId,
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    rootFingerprint: workspace.rootFingerprint,
    bindingExpiresAt: binding.expiresAt,
    projectMemoryInitialized,
    created,
    alreadyExisted,
    workspaceResolution: "binding",
  };

  return {
    ok: true,
    summaryText: `Đã attach thành công vào project '${workspace.displayName}' (${workspace.workspaceId}) với bindingId=${binding.bindingId}. Hãy thông báo rõ tên project '${workspace.displayName}' cho người dùng.`,
    data: output,
  };
}

/**
 * High-level Phase 1.5 bootstrap facade.
 * One call attaches the current Antigravity workspace, safely initializes
 * Project Memory, and restores compact task context. It intentionally performs
 * no source-code changes, terminal commands, plan approval, or task archival.
 */
export function startWorkSession(
  registryOptions?: RegistryOptions
): WorkflowResult<StartWorkSessionOutput> {
  const attached = attachActiveWorkspace(
    { initializeIfMissing: true },
    registryOptions
  );
  if (!attached.ok) {
    return attached;
  }

  const resumed = resumeTask(undefined, {
    detailLevel: "compact",
    workspaceBindingId: attached.data.bindingId,
    registryOptions,
  });
  if (!resumed.ok) {
    return resumed;
  }

  const context = resumed.data as ResumeTaskCompactOutput;
  const mode = !context.hasApprovedPlan
    ? "new_task"
    : context.status === "completed"
      ? "completed_pending_archive"
      : "resume_existing_task";
  const requiresUserDecision = mode === "completed_pending_archive";
  const userMessage =
    mode === "new_task"
      ? `Đã sẵn sàng làm việc với dự án '${attached.data.displayName}'. Hiện chưa có nhiệm vụ đang hoạt động.`
      : mode === "completed_pending_archive"
        ? `Dự án '${attached.data.displayName}' có task '${context.taskId}' đã hoàn thành nhưng đang chờ người dùng duyệt archive.`
        : `Đã khôi phục task '${context.taskId}' trong dự án '${attached.data.displayName}'.`;

  return {
    ok: true,
    summaryText: userMessage,
    data: {
      sessionReady: true,
      bindingId: attached.data.bindingId,
      bindingExpiresAt: attached.data.bindingExpiresAt,
      projectMemoryInitialized: attached.data.projectMemoryInitialized,
      mode,
      requiresUserDecision,
      userMessage,
      task: {
        hasApprovedPlan: context.hasApprovedPlan,
        taskId: context.taskId,
        revision: context.revision,
        status: context.status,
        objective: context.objective,
        currentState: context.currentState,
        nextSteps: context.nextSteps,
        blockers: context.blockers,
        openQuestions: context.openQuestions,
        doNotRedo: context.doNotRedo,
        recommendedNextAction: context.recommendedNextAction,
      },
      workspaceId: attached.data.workspaceId,
      displayName: attached.data.displayName,
      rootFingerprint: attached.data.rootFingerprint,
      workspaceResolution: "binding",
    },
  };
}
