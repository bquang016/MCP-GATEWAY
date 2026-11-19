import fs from "node:fs";
import {
  MEMORY_FILES,
  ARCHIVE_FILES,
  MemoryFileName,
  ArchiveFileName,
  resolveMemoryFilePath,
  resolveArchiveRootPath,
  resolveArchiveEntryDirPath,
  resolveArchiveFilePath,
  isValidTaskId,
  isValidRelativeProjectPath,
  isSymbolicLinkPath,
  assertSafeMemoryDir,
} from "../config.js";
import {
  APPROVED_PLAN_TEMPLATE,
  TASK_STATE_TEMPLATE,
  HANDOFF_TEMPLATE,
} from "./templates.js";
import { writeMemoryFileAtomic } from "./safe-write.js";
import {
  RegistryOptions,
  ResolvedWorkspaceContext,
  resolveToolWorkspace,
} from "../registry/workspace-registry.js";

export const SCHEMA_VERSION = "1.0";
export const DEFAULT_MAX_FILE_CHARS = 20_000;
export const DEFAULT_MAX_TOTAL_CHARS = 60_000;

export const DEFAULT_MAX_COMPACT_TOTAL_CHARS = 16_000;
export const DEFAULT_MAX_COMPACT_STRING_CHARS = 1_200;
export const DEFAULT_MAX_COMPACT_ITEM_CHARS = 400;
export const DEFAULT_MAX_COMPACT_ARRAY_ITEMS = 20;

export const TASK_STATUS_VALUES = [
  "planned",
  "in_progress",
  "blocked",
  "review",
  "completed",
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TEST_STATUS_VALUES = ["passed", "failed", "not_run"] as const;
export type TestRunStatus = (typeof TEST_STATUS_VALUES)[number];

export const HANDOFF_REASON_VALUES = [
  "context_switch",
  "end_session",
  "manual",
] as const;
export type HandoffReason = (typeof HANDOFF_REASON_VALUES)[number];

export const RESUME_DETAIL_LEVELS = ["compact", "full"] as const;
export type ResumeDetailLevel = (typeof RESUME_DETAIL_LEVELS)[number];

export interface WorkspaceMetadataFields {
  workspaceId: string | null;
  displayName: string | null;
  rootFingerprint: string | null;
  workspaceResolution: "binding" | "environment";
}

export interface WorkflowWorkspaceOptions {
  workspaceBindingId?: string;
  registryOptions?: RegistryOptions;
}

export interface SaveApprovedPlanInput {
  taskId: string;
  objective: string;
  planSteps: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  approvedByUser: boolean;
  workspaceBindingId?: string;
}

export interface SaveApprovedPlanOutput extends WorkspaceMetadataFields {
  saved: boolean;
  schemaVersion: string;
  taskId: string;
  approved: boolean;
  approvedAt: string;
}

export interface TaskTestEntry {
  command: string;
  status: TestRunStatus;
  result: string;
}

export interface CheckpointTaskInput {
  taskId: string;
  expectedRevision: number;
  status: TaskStatus;
  objective: string;
  acceptanceCriteria: string[];
  completed: string[];
  currentState: string;
  nextSteps: string[];
  changedFiles: string[];
  tests: TaskTestEntry[];
  blockers: string[];
  openQuestions: string[];
  workspaceBindingId?: string;
}

export interface CheckpointTaskOutput extends WorkspaceMetadataFields {
  taskId: string;
  previousRevision: number;
  revision: number;
  status: TaskStatus;
  updatedAt: string;
}

export interface ResumeTaskCompactOutput extends WorkspaceMetadataFields {
  hasApprovedPlan: boolean;
  taskId: string | null;
  revision: number;
  status: string;
  objective: string;
  acceptanceCriteria: string[];
  completed: string[];
  currentState: string;
  nextSteps: string[];
  changedFiles: string[];
  tests: string[];
  blockers: string[];
  openQuestions: string[];
  handoffNextAction: string | null;
  doNotRedo: string[];
  recommendedNextAction: string | null;
  truncated: boolean;
  truncatedFields: string[];
}

export interface ResumeTaskFullOutput extends WorkspaceMetadataFields {
  hasApprovedPlan: boolean;
  taskId: string | null;
  revision: number;
  status: string;
  projectContext: string;
  approvedPlan: string;
  taskState: string;
  handoff: string;
  decisions: string;
  recommendedNextAction: string | null;
  truncated?: boolean;
  truncatedFiles?: string[];
}

export type ResumeTaskOutput = ResumeTaskCompactOutput | ResumeTaskFullOutput;

export interface PrepareHandoffInput {
  expectedRevision: number;
  reason: HandoffReason;
  nextExactAction: string;
  doNotRedo: string[];
  workspaceBindingId?: string;
}

export interface PrepareHandoffOutput extends WorkspaceMetadataFields {
  taskId: string;
  basedOnRevision: number;
  handoffUpdated: true;
  updatedAt: string;
}

export interface ArchiveCompletedTaskInput {
  taskId: string;
  expectedRevision: number;
  userConfirmed: boolean;
  completionSummary: string;
  workspaceBindingId?: string;
}

export interface ArchiveCompletedTaskOutput extends WorkspaceMetadataFields {
  archived: true;
  taskId: string;
  archivedRevision: number;
  archiveId: string;
  resetCurrentTask: true;
  completedAt: string;
}

export interface WorkflowErrorResult extends WorkspaceMetadataFields {
  ok: false;
  errorCode: string;
  message: string;
  currentRevision?: number;
}

export interface WorkflowSuccessResult<T> {
  ok: true;
  data: T;
  summaryText: string;
}

export type WorkflowResult<T> = WorkflowSuccessResult<T> | WorkflowErrorResult;

export interface ParsedApprovedPlan {
  fileExists: boolean;
  isTemplateOrEmpty: boolean;
  hasApprovedPlan: boolean;
  taskId: string | null;
  workspaceId: string | null;
  objective: string;
  acceptanceCriteria: string[];
  approvedAt: string | null;
  rawContent: string;
}

export interface ParsedTaskState {
  fileExists: boolean;
  revision: number;
  taskId: string | null;
  workspaceId: string | null;
  status: string;
  objective: string;
  updatedAt: string | null;
  acceptanceCriteria: string[];
  completed: string[];
  currentState: string;
  nextSteps: string[];
  changedFiles: string[];
  tests: string[];
  failedTests: string[];
  blockers: string[];
  openQuestions: string[];
  rawContent: string;
}

export interface ParsedHandoff {
  fileExists: boolean;
  workspaceId: string | null;
  nextExactAction: string | null;
  doNotRedo: string[];
  rawContent: string;
}

export function extractWorkspaceMetadata(
  resolved: ResolvedWorkspaceContext
): WorkspaceMetadataFields {
  return {
    workspaceId: resolved.workspaceId,
    displayName: resolved.displayName,
    rootFingerprint: resolved.rootFingerprint,
    workspaceResolution: resolved.workspaceResolution,
  };
}

export function buildUnresolvedWorkspaceMeta(
  workspaceBindingId?: string
): WorkspaceMetadataFields {
  return {
    workspaceId: null,
    displayName: null,
    rootFingerprint: null,
    workspaceResolution: workspaceBindingId !== undefined ? "binding" : "environment",
  };
}

function makeWorkflowError(
  errorCode: string,
  message: string,
  meta: WorkspaceMetadataFields,
  currentRevision?: number
): WorkflowErrorResult {
  return {
    ok: false,
    errorCode,
    message,
    ...meta,
    ...(currentRevision !== undefined ? { currentRevision } : {}),
  };
}

/**
 * Verifies that any existing task in APPROVED_PLAN.md or TASK_STATE.md belongs
 * to the resolved workspaceId (Workspace Mismatch Protection).
 */
export function verifyProjectMemoryWorkspaceMatch(
  resolved: ResolvedWorkspaceContext,
  approvedPlan?: ParsedApprovedPlan,
  taskState?: ParsedTaskState
): WorkflowErrorResult | null {
  const meta = extractWorkspaceMetadata(resolved);

  try {
    assertSafeMemoryDir(resolved.memoryDir, resolved.canonicalRoot);
  } catch (err: unknown) {
    return makeWorkflowError(
      "WORKSPACE_MISMATCH",
      err instanceof Error
        ? err.message
        : "Project Memory không thuộc về workspace đã gắn.",
      meta
    );
  }

  if (
    approvedPlan?.hasApprovedPlan &&
    approvedPlan.workspaceId !== null &&
    approvedPlan.workspaceId !== resolved.workspaceId
  ) {
    return makeWorkflowError(
      "WORKSPACE_MISMATCH",
      `APPROVED_PLAN.md thuộc về workspace '${approvedPlan.workspaceId}', không khớp với workspace hiện tại ('${resolved.workspaceId}').`,
      meta
    );
  }

  if (
    taskState &&
    taskState.workspaceId !== null &&
    taskState.workspaceId !== resolved.workspaceId
  ) {
    return makeWorkflowError(
      "WORKSPACE_MISMATCH",
      `TASK_STATE.md thuộc về workspace '${taskState.workspaceId}', không khớp với workspace hiện tại ('${resolved.workspaceId}').`,
      meta
    );
  }

  return null;
}

/**
 * Normalizes a structured text field into a single safe line so raw Markdown
 * headers or section breaks cannot be injected.
 */
function sanitizeInlineText(input: string): string {
  const singleLine = input.replace(/[\r\n]+/g, " ").trim();
  if (singleLine.startsWith("#")) {
    return `\\${singleLine}`;
  }
  return singleLine;
}

function renderBulletList(items: string[]): string {
  if (items.length === 0) {
    return "_None_";
  }
  return items.map((item) => `- ${sanitizeInlineText(item)}`).join("\n");
}

function renderTestList(tests: TaskTestEntry[]): string {
  if (tests.length === 0) {
    return "_None_";
  }
  return tests
    .map(
      (t) =>
        `- [${t.status}] ${sanitizeInlineText(t.command)} — ${sanitizeInlineText(t.result)}`
    )
    .join("\n");
}

function extractHeaderValue(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m");
  const match = content.match(regex);
  return match ? match[1].trim() : "";
}

function extractSectionMap(content: string): Map<string, string[]> {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection !== null) {
      sections.get(currentSection)!.push(line);
    }
  }

  return sections;
}

function extractSectionBullets(sections: Map<string, string[]>, name: string): string[] {
  const lines = sections.get(name);
  if (!lines) {
    return [];
  }
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }
  return items;
}

function extractSectionText(sections: Map<string, string[]>, name: string): string {
  const lines = sections.get(name);
  if (!lines) {
    return "";
  }
  const text = lines.join("\n").trim();
  if (text === "_None_") {
    return "";
  }
  return text;
}

/**
 * Reads and parses .ai/APPROVED_PLAN.md if it exists.
 */
export function readApprovedPlan(memoryDir: string): ParsedApprovedPlan {
  const planPath = resolveMemoryFilePath(memoryDir, MEMORY_FILES.APPROVED_PLAN);
  if (!fs.existsSync(planPath)) {
    return {
      fileExists: false,
      isTemplateOrEmpty: true,
      hasApprovedPlan: false,
      taskId: null,
      workspaceId: null,
      objective: "",
      acceptanceCriteria: [],
      approvedAt: null,
      rawContent: "",
    };
  }

  const rawContent = fs.readFileSync(planPath, "utf-8");
  const normalized = rawContent.replace(/\r\n/g, "\n").trim();
  const normalizedTemplate = APPROVED_PLAN_TEMPLATE.replace(/\r\n/g, "\n").trim();

  if (normalized === "" || normalized === normalizedTemplate) {
    return {
      fileExists: true,
      isTemplateOrEmpty: true,
      hasApprovedPlan: false,
      taskId: null,
      workspaceId: null,
      objective: "",
      acceptanceCriteria: [],
      approvedAt: null,
      rawContent,
    };
  }

  const taskIdRaw = extractHeaderValue(normalized, "Task ID");
  const workspaceIdRaw = extractHeaderValue(normalized, "Workspace ID");
  const approvedRaw = extractHeaderValue(normalized, "Approved");
  const approvedAtRaw = extractHeaderValue(normalized, "Approved at");
  const sections = extractSectionMap(normalized);
  const objective = extractSectionText(sections, "Objective");
  const acceptanceCriteria = extractSectionBullets(sections, "Acceptance Criteria");
  const planSteps = sections.get("Plan Steps")?.filter((l) => l.trim().length > 0) ?? [];

  const isApproved = approvedRaw === "true";
  const taskId = taskIdRaw.length > 0 ? taskIdRaw : null;
  const workspaceId = workspaceIdRaw.length > 0 ? workspaceIdRaw : null;

  if (!isApproved && taskId === null && objective === "" && planSteps.length === 0) {
    return {
      fileExists: true,
      isTemplateOrEmpty: true,
      hasApprovedPlan: false,
      taskId: null,
      workspaceId: null,
      objective: "",
      acceptanceCriteria: [],
      approvedAt: null,
      rawContent,
    };
  }

  return {
    fileExists: true,
    isTemplateOrEmpty: false,
    hasApprovedPlan: isApproved && taskId !== null,
    taskId,
    workspaceId,
    objective,
    acceptanceCriteria,
    approvedAt: approvedAtRaw || null,
    rawContent,
  };
}

/**
 * Reads and parses .ai/TASK_STATE.md if it exists.
 * Revision starts at 0 when TASK_STATE.md is absent or is still an initial template.
 */
export function readTaskState(memoryDir: string): ParsedTaskState {
  const taskStatePath = resolveMemoryFilePath(memoryDir, MEMORY_FILES.TASK_STATE);
  if (!fs.existsSync(taskStatePath)) {
    return {
      fileExists: false,
      revision: 0,
      taskId: null,
      workspaceId: null,
      status: "",
      objective: "",
      updatedAt: null,
      acceptanceCriteria: [],
      completed: [],
      currentState: "",
      nextSteps: [],
      changedFiles: [],
      tests: [],
      failedTests: [],
      blockers: [],
      openQuestions: [],
      rawContent: "",
    };
  }

  const rawContent = fs.readFileSync(taskStatePath, "utf-8");
  const normalized = rawContent.replace(/\r\n/g, "\n");

  const revisionRaw = extractHeaderValue(normalized, "Revision");
  let revision = 0;
  if (/^\d+$/.test(revisionRaw)) {
    revision = Number.parseInt(revisionRaw, 10);
  }

  const taskIdRaw = extractHeaderValue(normalized, "Task ID");
  const workspaceIdRaw = extractHeaderValue(normalized, "Workspace ID");
  const statusRaw = extractHeaderValue(normalized, "Status");
  const objectiveRaw = extractHeaderValue(normalized, "Objective");
  const updatedAtRaw = extractHeaderValue(normalized, "Updated at");

  const sections = extractSectionMap(normalized);
  const acceptanceCriteria = extractSectionBullets(sections, "Acceptance Criteria");
  const completed = extractSectionBullets(sections, "Completed");
  const currentState = extractSectionText(sections, "Current State");
  const nextSteps = extractSectionBullets(sections, "Next Steps");
  const changedFiles = extractSectionBullets(sections, "Changed Files");
  const tests = extractSectionBullets(sections, "Tests");
  const failedTests = tests.filter((t) => t.startsWith("[failed]"));
  const blockers = extractSectionBullets(sections, "Blockers");
  const openQuestions = extractSectionBullets(sections, "Open Questions");

  return {
    fileExists: true,
    revision,
    taskId: taskIdRaw.length > 0 ? taskIdRaw : null,
    workspaceId: workspaceIdRaw.length > 0 ? workspaceIdRaw : null,
    status: statusRaw,
    objective: objectiveRaw,
    updatedAt: updatedAtRaw || null,
    acceptanceCriteria,
    completed,
    currentState,
    nextSteps,
    changedFiles,
    tests,
    failedTests,
    blockers,
    openQuestions,
    rawContent,
  };
}

/**
 * Reads and parses .ai/HANDOFF.md if it exists.
 */
export function readHandoff(memoryDir: string): ParsedHandoff {
  const handoffPath = resolveMemoryFilePath(memoryDir, MEMORY_FILES.HANDOFF);
  if (!fs.existsSync(handoffPath)) {
    return {
      fileExists: false,
      workspaceId: null,
      nextExactAction: null,
      doNotRedo: [],
      rawContent: "",
    };
  }

  const rawContent = fs.readFileSync(handoffPath, "utf-8");
  const normalized = rawContent.replace(/\r\n/g, "\n");
  const workspaceIdRaw = extractHeaderValue(normalized, "Workspace ID");
  const sections = extractSectionMap(normalized);
  const nextExactActionText = extractSectionText(sections, "Next Exact Action");
  const doNotRedo = extractSectionBullets(sections, "Do Not Redo");

  return {
    fileExists: true,
    workspaceId: workspaceIdRaw.length > 0 ? workspaceIdRaw : null,
    nextExactAction: nextExactActionText.length > 0 ? nextExactActionText : null,
    doNotRedo,
    rawContent,
  };
}

/**
 * Tool: save_approved_plan
 */
export function saveApprovedPlan(
  input: SaveApprovedPlanInput,
  customRoot?: string,
  options?: WorkflowWorkspaceOptions
): WorkflowResult<SaveApprovedPlanOutput> {
  const bindingId = options?.workspaceBindingId ?? input.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return makeWorkflowError(
      resolved.errorCode,
      resolved.message,
      buildUnresolvedWorkspaceMeta(bindingId)
    );
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  if (input.approvedByUser !== true) {
    return makeWorkflowError(
      "PLAN_NOT_APPROVED",
      "Chỉ được lưu kế hoạch khi approvedByUser đúng bằng true.",
      meta
    );
  }

  if (!isValidTaskId(input.taskId)) {
    return makeWorkflowError(
      "INVALID_TASK_ID",
      "taskId không hợp lệ (phải từ 1-100 ký tự, không chứa path separator '/' hoặc '\\' hoặc '..').",
      meta
    );
  }

  if (
    typeof input.objective !== "string" ||
    input.objective.trim().length < 1 ||
    input.objective.length > 2000
  ) {
    return makeWorkflowError(
      "INVALID_OBJECTIVE",
      "objective phải là chuỗi từ 1 đến 2000 ký tự.",
      meta
    );
  }

  if (
    !Array.isArray(input.planSteps) ||
    input.planSteps.length < 1 ||
    input.planSteps.length > 50 ||
    input.planSteps.some(
      (step) => typeof step !== "string" || step.trim().length < 1 || step.length > 2000
    )
  ) {
    return makeWorkflowError(
      "INVALID_PLAN_STEPS",
      "planSteps phải gồm 1-50 phần tử, mỗi phần tử từ 1-2000 ký tự.",
      meta
    );
  }

  if (
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length < 1 ||
    input.acceptanceCriteria.length > 50 ||
    input.acceptanceCriteria.some(
      (item) => typeof item !== "string" || item.trim().length < 1 || item.length > 2000
    )
  ) {
    return makeWorkflowError(
      "INVALID_ACCEPTANCE_CRITERIA",
      "acceptanceCriteria phải gồm 1-50 phần tử hợp lệ.",
      meta
    );
  }

  if (
    !Array.isArray(input.constraints) ||
    input.constraints.length > 30 ||
    input.constraints.some(
      (item) => typeof item !== "string" || item.trim().length < 1 || item.length > 2000
    )
  ) {
    return makeWorkflowError(
      "INVALID_CONSTRAINTS",
      "constraints chỉ được phép chứa từ 0-30 phần tử hợp lệ.",
      meta
    );
  }

  const existingPlan = readApprovedPlan(wsContext.memoryDir);
  const existingTaskState = readTaskState(wsContext.memoryDir);

  const mismatchError = verifyProjectMemoryWorkspaceMatch(
    wsContext,
    existingPlan,
    existingTaskState
  );
  if (mismatchError) {
    return mismatchError;
  }

  if (!existingPlan.isTemplateOrEmpty || existingPlan.hasApprovedPlan) {
    return makeWorkflowError(
      "PLAN_ALREADY_EXISTS",
      "APPROVED_PLAN.md đã chứa kế hoạch được duyệt. Không được phép ghi đè trong milestone này.",
      meta
    );
  }

  const approvedAt = new Date().toISOString();
  const renderedSteps = input.planSteps
    .map((step, index) => `${index + 1}. ${sanitizeInlineText(step)}`)
    .join("\n");
  const renderedCriteria = renderBulletList(input.acceptanceCriteria);
  const renderedConstraints = renderBulletList(input.constraints);

  const markdown = `# Approved Plan

- **Schema Version**: ${SCHEMA_VERSION}
- **Workspace ID**: ${wsContext.workspaceId}
- **Task ID**: ${input.taskId}
- **Approved**: true
- **Approved at**: ${approvedAt}

## Objective
${sanitizeInlineText(input.objective)}

## Plan Steps
${renderedSteps}

## Acceptance Criteria
${renderedCriteria}

## Constraints
${renderedConstraints}
`;

  writeMemoryFileAtomic(wsContext.memoryDir, MEMORY_FILES.APPROVED_PLAN, markdown, {
    beforeReplace: () => {
      const recheck = readApprovedPlan(wsContext.memoryDir);
      if (!recheck.isTemplateOrEmpty || recheck.hasApprovedPlan) {
        const conflictErr = new Error("PLAN_ALREADY_EXISTS");
        (conflictErr as NodeJS.ErrnoException).code = "PLAN_ALREADY_EXISTS";
        throw conflictErr;
      }
    },
  });

  // Ensure TASK_STATE.md exists with initial revision 0 if .ai was initialized partially
  const taskStatePath = resolveMemoryFilePath(wsContext.memoryDir, MEMORY_FILES.TASK_STATE);
  if (!fs.existsSync(taskStatePath)) {
    writeMemoryFileAtomic(wsContext.memoryDir, MEMORY_FILES.TASK_STATE, TASK_STATE_TEMPLATE);
  }

  return {
    ok: true,
    summaryText: `Đã lưu kế hoạch đã duyệt cho task ${input.taskId} vào Project Memory (workspace: ${wsContext.displayName}).`,
    data: {
      saved: true,
      schemaVersion: SCHEMA_VERSION,
      taskId: input.taskId,
      approved: true,
      approvedAt,
      ...meta,
    },
  };
}

/**
 * Tool: checkpoint_task
 */
export function checkpointTask(
  input: CheckpointTaskInput,
  customRoot?: string,
  options?: WorkflowWorkspaceOptions
): WorkflowResult<CheckpointTaskOutput> {
  const bindingId = options?.workspaceBindingId ?? input.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return makeWorkflowError(
      resolved.errorCode,
      resolved.message,
      buildUnresolvedWorkspaceMeta(bindingId)
    );
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  if (!isValidTaskId(input.taskId)) {
    return makeWorkflowError("INVALID_TASK_ID", "taskId không hợp lệ.", meta);
  }

  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return makeWorkflowError(
      "INVALID_EXPECTED_REVISION",
      "expectedRevision phải là số nguyên >= 0.",
      meta
    );
  }

  if (!TASK_STATUS_VALUES.includes(input.status)) {
    return makeWorkflowError("INVALID_STATUS", "status không hợp lệ.", meta);
  }

  if (typeof input.objective !== "string" || input.objective.trim().length === 0) {
    return makeWorkflowError(
      "INVALID_OBJECTIVE",
      "objective không được để trống.",
      meta
    );
  }

  if (typeof input.currentState !== "string" || input.currentState.trim().length === 0) {
    return makeWorkflowError(
      "INVALID_CURRENT_STATE",
      "currentState không được để trống.",
      meta
    );
  }

  if (!Array.isArray(input.changedFiles)) {
    return makeWorkflowError(
      "INVALID_CHANGED_FILES",
      "changedFiles phải là danh sách đường dẫn tương đối.",
      meta
    );
  }

  for (const filePath of input.changedFiles) {
    if (!isValidRelativeProjectPath(filePath, wsContext.canonicalRoot)) {
      return makeWorkflowError(
        "INVALID_CHANGED_FILES",
        `Đường dẫn trong changedFiles không hợp lệ (chỉ chấp nhận relative path, không chứa '..' hoặc absolute path): ${filePath}`,
        meta
      );
    }
  }

  if (!Array.isArray(input.tests)) {
    return makeWorkflowError(
      "INVALID_TESTS",
      "tests phải là danh sách kết quả kiểm thử.",
      meta
    );
  }

  for (const testEntry of input.tests) {
    if (
      !testEntry ||
      typeof testEntry.command !== "string" ||
      testEntry.command.trim().length === 0 ||
      !TEST_STATUS_VALUES.includes(testEntry.status) ||
      typeof testEntry.result !== "string"
    ) {
      return makeWorkflowError(
        "INVALID_TESTS",
        "Mỗi phần tử trong tests phải có command, status (passed|failed|not_run) và result.",
        meta
      );
    }
  }

  const approvedPlan = readApprovedPlan(wsContext.memoryDir);
  const currentTaskState = readTaskState(wsContext.memoryDir);

  const mismatchError = verifyProjectMemoryWorkspaceMatch(
    wsContext,
    approvedPlan,
    currentTaskState
  );
  if (mismatchError) {
    return mismatchError;
  }

  // Verify approved plan exists
  if (!approvedPlan.hasApprovedPlan || !approvedPlan.taskId) {
    return makeWorkflowError(
      "NO_APPROVED_PLAN",
      "Chưa có approved plan trong Project Memory. Không thể checkpoint task.",
      meta
    );
  }

  // Verify taskId matches approved plan
  if (input.taskId !== approvedPlan.taskId) {
    return makeWorkflowError(
      "TASK_ID_MISMATCH",
      `taskId '${input.taskId}' không khớp với taskId trong APPROVED_PLAN.md ('${approvedPlan.taskId}').`,
      meta
    );
  }

  if (currentTaskState.taskId !== null && currentTaskState.taskId !== input.taskId) {
    return makeWorkflowError(
      "TASK_ID_MISMATCH",
      `taskId '${input.taskId}' không khớp với taskId trong TASK_STATE.md ('${currentTaskState.taskId}').`,
      meta
    );
  }

  // Verify expectedRevision matches current TASK_STATE revision
  const currentRevision = currentTaskState.revision;

  if (input.expectedRevision !== currentRevision) {
    return makeWorkflowError(
      "REVISION_CONFLICT",
      `Xung đột revision: expectedRevision=${input.expectedRevision} nhưng currentRevision=${currentRevision}.`,
      meta,
      currentRevision
    );
  }

  const newRevision = currentRevision + 1;
  const updatedAt = new Date().toISOString();

  const markdown = `# Task State

- **Schema Version**: ${SCHEMA_VERSION}
- **Workspace ID**: ${wsContext.workspaceId}
- **Task ID**: ${input.taskId}
- **Revision**: ${newRevision}
- **Status**: ${input.status}
- **Objective**: ${sanitizeInlineText(input.objective)}
- **Updated at**: ${updatedAt}

## Acceptance Criteria
${renderBulletList(input.acceptanceCriteria)}

## Completed
${renderBulletList(input.completed)}

## Current State
${sanitizeInlineText(input.currentState)}

## Next Steps
${renderBulletList(input.nextSteps)}

## Changed Files
${renderBulletList(input.changedFiles)}

## Tests
${renderTestList(input.tests)}

## Blockers
${renderBulletList(input.blockers)}

## Open Questions
${renderBulletList(input.openQuestions)}
`;

  writeMemoryFileAtomic(wsContext.memoryDir, MEMORY_FILES.TASK_STATE, markdown);

  return {
    ok: true,
    summaryText: `Đã cập nhật TASK_STATE.md cho task ${input.taskId} lên revision ${newRevision} (workspace: ${wsContext.displayName}).`,
    data: {
      taskId: input.taskId,
      previousRevision: currentRevision,
      revision: newRevision,
      status: input.status,
      updatedAt,
      ...meta,
    },
  };
}

export interface ResumeTaskOptions extends WorkflowWorkspaceOptions {
  detailLevel?: ResumeDetailLevel;
  maxFileChars?: number;
  maxTotalChars?: number;
  maxCompactTotalChars?: number;
  maxCompactStringChars?: number;
  maxCompactItemChars?: number;
  maxCompactArrayItems?: number;
}

function truncateStringField(
  value: string,
  maxChars: number,
  fieldName: string,
  truncatedFields: Set<string>
): string {
  if (value.length > maxChars) {
    truncatedFields.add(fieldName);
    return value.slice(0, maxChars);
  }
  return value;
}

function truncateNullableStringField(
  value: string | null,
  maxChars: number,
  fieldName: string,
  truncatedFields: Set<string>
): string | null {
  if (value === null) {
    return null;
  }
  if (value.length > maxChars) {
    truncatedFields.add(fieldName);
    return value.slice(0, maxChars);
  }
  return value;
}

function truncateStringArrayField(
  items: string[],
  maxItems: number,
  maxItemChars: number,
  fieldName: string,
  truncatedFields: Set<string>
): string[] {
  let result = items;
  if (result.length > maxItems) {
    truncatedFields.add(fieldName);
    result = result.slice(0, maxItems);
  }
  return result.map((item) => {
    if (item.length > maxItemChars) {
      truncatedFields.add(fieldName);
      return item.slice(0, maxItemChars);
    }
    return item;
  });
}

/**
 * Tool: resume_task (Read-only)
 * Supports detailLevel: "compact" (default) or "full".
 * - "compact": returns structured workflow state without raw Markdown of the 5 files, bounded to ~16,000 chars.
 * - "full": returns raw Markdown of the 5 fixed files in .ai, bounded to 20,000 chars/file and 60,000 chars total.
 */
export function resumeTask(
  customRoot?: string,
  options?: ResumeTaskOptions
): WorkflowResult<ResumeTaskOutput> {
  const bindingId = options?.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return makeWorkflowError(
      resolved.errorCode,
      resolved.message,
      buildUnresolvedWorkspaceMeta(bindingId)
    );
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  const detailLevel: ResumeDetailLevel = options?.detailLevel ?? "compact";
  if (!RESUME_DETAIL_LEVELS.includes(detailLevel)) {
    return makeWorkflowError(
      "INVALID_DETAIL_LEVEL",
      "detailLevel chỉ chấp nhận 'compact' hoặc 'full'.",
      meta
    );
  }

  try {
    assertSafeMemoryDir(wsContext.memoryDir, wsContext.canonicalRoot);
  } catch (err: unknown) {
    return makeWorkflowError(
      "INVALID_MEMORY_PATH",
      err instanceof Error ? err.message : "Đường dẫn Project Memory không hợp lệ.",
      meta
    );
  }

  let approvedPlanInfo: ParsedApprovedPlan;
  let taskStateInfo: ParsedTaskState;
  let handoffInfo: ParsedHandoff;

  try {
    approvedPlanInfo = readApprovedPlan(wsContext.memoryDir);
    taskStateInfo = readTaskState(wsContext.memoryDir);
    handoffInfo = readHandoff(wsContext.memoryDir);
  } catch (err: unknown) {
    return makeWorkflowError(
      "INVALID_MEMORY_PATH",
      err instanceof Error ? err.message : "Không thể đọc Project Memory an toàn.",
      meta
    );
  }

  const mismatchError = verifyProjectMemoryWorkspaceMatch(
    wsContext,
    approvedPlanInfo,
    taskStateInfo
  );
  if (mismatchError) {
    return mismatchError;
  }

  const hasApprovedPlan = approvedPlanInfo.hasApprovedPlan;
  const taskId = hasApprovedPlan
    ? approvedPlanInfo.taskId
    : taskStateInfo.taskId || null;
  const revision = taskStateInfo.revision;
  const status = taskStateInfo.status || "not_started";
  const rawRecommendedNextAction =
    taskStateInfo.nextSteps.length > 0 ? taskStateInfo.nextSteps[0] : null;

  if (detailLevel === "compact") {
    const maxCompactTotalChars =
      options?.maxCompactTotalChars ?? DEFAULT_MAX_COMPACT_TOTAL_CHARS;
    const maxStringChars =
      options?.maxCompactStringChars ?? DEFAULT_MAX_COMPACT_STRING_CHARS;
    const maxItemChars =
      options?.maxCompactItemChars ?? DEFAULT_MAX_COMPACT_ITEM_CHARS;
    const maxArrayItems =
      options?.maxCompactArrayItems ?? DEFAULT_MAX_COMPACT_ARRAY_ITEMS;

    const truncatedFieldsSet = new Set<string>();

    const rawObjective = taskStateInfo.objective || approvedPlanInfo.objective || "";
    const rawAcceptanceCriteria =
      taskStateInfo.acceptanceCriteria.length > 0
        ? taskStateInfo.acceptanceCriteria
        : approvedPlanInfo.acceptanceCriteria;

    const compactOutput: ResumeTaskCompactOutput = {
      hasApprovedPlan,
      taskId,
      revision,
      status,
      objective: truncateStringField(
        rawObjective,
        maxStringChars,
        "objective",
        truncatedFieldsSet
      ),
      acceptanceCriteria: truncateStringArrayField(
        rawAcceptanceCriteria,
        maxArrayItems,
        maxItemChars,
        "acceptanceCriteria",
        truncatedFieldsSet
      ),
      completed: truncateStringArrayField(
        taskStateInfo.completed,
        maxArrayItems,
        maxItemChars,
        "completed",
        truncatedFieldsSet
      ),
      currentState: truncateStringField(
        taskStateInfo.currentState,
        maxStringChars,
        "currentState",
        truncatedFieldsSet
      ),
      nextSteps: truncateStringArrayField(
        taskStateInfo.nextSteps,
        maxArrayItems,
        maxItemChars,
        "nextSteps",
        truncatedFieldsSet
      ),
      changedFiles: truncateStringArrayField(
        taskStateInfo.changedFiles,
        maxArrayItems,
        maxItemChars,
        "changedFiles",
        truncatedFieldsSet
      ),
      tests: truncateStringArrayField(
        taskStateInfo.tests,
        maxArrayItems,
        maxItemChars,
        "tests",
        truncatedFieldsSet
      ),
      blockers: truncateStringArrayField(
        taskStateInfo.blockers,
        maxArrayItems,
        maxItemChars,
        "blockers",
        truncatedFieldsSet
      ),
      openQuestions: truncateStringArrayField(
        taskStateInfo.openQuestions,
        maxArrayItems,
        maxItemChars,
        "openQuestions",
        truncatedFieldsSet
      ),
      handoffNextAction: truncateNullableStringField(
        handoffInfo.nextExactAction,
        maxStringChars,
        "handoffNextAction",
        truncatedFieldsSet
      ),
      doNotRedo: truncateStringArrayField(
        handoffInfo.doNotRedo,
        maxArrayItems,
        maxItemChars,
        "doNotRedo",
        truncatedFieldsSet
      ),
      recommendedNextAction: truncateNullableStringField(
        rawRecommendedNextAction,
        maxStringChars,
        "recommendedNextAction",
        truncatedFieldsSet
      ),
      truncated: false,
      truncatedFields: [],
      ...meta,
    };

    const syncTruncationMeta = () => {
      compactOutput.truncatedFields = Array.from(truncatedFieldsSet);
      compactOutput.truncated = compactOutput.truncatedFields.length > 0;
    };
    syncTruncationMeta();

    // Enforce total structured response limit (~16,000 chars)
    const arrayTrimPriority: Array<
      keyof Pick<
        ResumeTaskCompactOutput,
        | "changedFiles"
        | "completed"
        | "tests"
        | "openQuestions"
        | "doNotRedo"
        | "acceptanceCriteria"
        | "blockers"
        | "nextSteps"
      >
    > = [
      "changedFiles",
      "completed",
      "tests",
      "openQuestions",
      "doNotRedo",
      "acceptanceCriteria",
      "blockers",
      "nextSteps",
    ];

    for (const field of arrayTrimPriority) {
      while (
        JSON.stringify(compactOutput).length > maxCompactTotalChars &&
        compactOutput[field].length > 0
      ) {
        compactOutput[field].pop();
        truncatedFieldsSet.add(field);
        syncTruncationMeta();
      }
    }

    const stringTrimPriority: Array<"currentState" | "objective" | "handoffNextAction"> = [
      "currentState",
      "objective",
      "handoffNextAction",
    ];

    for (const field of stringTrimPriority) {
      const currentVal = compactOutput[field];
      if (
        typeof currentVal === "string" &&
        currentVal.length > 0 &&
        JSON.stringify(compactOutput).length > maxCompactTotalChars
      ) {
        const excess = JSON.stringify(compactOutput).length - maxCompactTotalChars;
        const nextLen = Math.max(0, currentVal.length - excess - 32);
        compactOutput[field] = currentVal.slice(0, nextLen);
        truncatedFieldsSet.add(field);
        syncTruncationMeta();
      }
    }

    return {
      ok: true,
      summaryText: `Khôi phục ngữ cảnh (compact) thành công (workspace=${wsContext.displayName}, taskId=${taskId ?? "none"}, revision=${revision}).`,
      data: compactOutput,
    };
  }

  // Full mode
  const maxFileChars = options?.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const readSafe = (fileName: MemoryFileName): string => {
    try {
      const filePath = resolveMemoryFilePath(wsContext.memoryDir, fileName);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return fs.readFileSync(filePath, "utf-8");
      }
      return "";
    } catch {
      return "";
    }
  };

  const rawContents: Record<MemoryFileName, string> = {
    [MEMORY_FILES.PROJECT_CONTEXT]: readSafe(MEMORY_FILES.PROJECT_CONTEXT),
    [MEMORY_FILES.APPROVED_PLAN]: readSafe(MEMORY_FILES.APPROVED_PLAN),
    [MEMORY_FILES.TASK_STATE]: readSafe(MEMORY_FILES.TASK_STATE),
    [MEMORY_FILES.HANDOFF]: readSafe(MEMORY_FILES.HANDOFF),
    [MEMORY_FILES.DECISIONS]: readSafe(MEMORY_FILES.DECISIONS),
  };

  const truncatedSet = new Set<string>();
  const processedContents: Record<MemoryFileName, string> = { ...rawContents };

  const orderedFiles: MemoryFileName[] = [
    MEMORY_FILES.PROJECT_CONTEXT,
    MEMORY_FILES.APPROVED_PLAN,
    MEMORY_FILES.TASK_STATE,
    MEMORY_FILES.HANDOFF,
    MEMORY_FILES.DECISIONS,
  ];

  // Stage 1: Per-file limit (default 20,000 chars per file)
  for (const fileName of orderedFiles) {
    if (processedContents[fileName].length > maxFileChars) {
      processedContents[fileName] = processedContents[fileName].slice(0, maxFileChars);
      truncatedSet.add(fileName);
    }
  }

  // Stage 2: Total response limit (default 60,000 chars across all returned content)
  const budgetPriorityOrder: MemoryFileName[] = [
    MEMORY_FILES.APPROVED_PLAN,
    MEMORY_FILES.TASK_STATE,
    MEMORY_FILES.HANDOFF,
    MEMORY_FILES.PROJECT_CONTEXT,
    MEMORY_FILES.DECISIONS,
  ];

  let remainingBudget = maxTotalChars;
  for (const fileName of budgetPriorityOrder) {
    const current = processedContents[fileName];
    if (current.length > remainingBudget) {
      processedContents[fileName] = current.slice(0, Math.max(0, remainingBudget));
      remainingBudget = 0;
      truncatedSet.add(fileName);
    } else {
      remainingBudget -= current.length;
    }
  }

  const truncatedFiles = orderedFiles.filter((name) => truncatedSet.has(name));

  const output: ResumeTaskFullOutput = {
    hasApprovedPlan,
    taskId,
    revision,
    status,
    projectContext: processedContents[MEMORY_FILES.PROJECT_CONTEXT],
    approvedPlan: processedContents[MEMORY_FILES.APPROVED_PLAN],
    taskState: processedContents[MEMORY_FILES.TASK_STATE],
    handoff: processedContents[MEMORY_FILES.HANDOFF],
    decisions: processedContents[MEMORY_FILES.DECISIONS],
    recommendedNextAction: rawRecommendedNextAction,
    ...(truncatedFiles.length > 0
      ? {
          truncated: true,
          truncatedFiles,
        }
      : {}),
    ...meta,
  };

  return {
    ok: true,
    summaryText: `Khôi phục ngữ cảnh (full) thành công (workspace=${wsContext.displayName}, taskId=${taskId ?? "none"}, revision=${revision}).`,
    data: output,
  };
}

/**
 * Tool: prepare_handoff
 */
export function prepareHandoff(
  input: PrepareHandoffInput,
  customRoot?: string,
  options?: WorkflowWorkspaceOptions
): WorkflowResult<PrepareHandoffOutput> {
  const bindingId = options?.workspaceBindingId ?? input.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return makeWorkflowError(
      resolved.errorCode,
      resolved.message,
      buildUnresolvedWorkspaceMeta(bindingId)
    );
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return makeWorkflowError(
      "INVALID_EXPECTED_REVISION",
      "expectedRevision phải là số nguyên >= 0.",
      meta
    );
  }

  if (!HANDOFF_REASON_VALUES.includes(input.reason)) {
    return makeWorkflowError(
      "INVALID_REASON",
      "reason phải là một trong: context_switch | end_session | manual.",
      meta
    );
  }

  if (
    typeof input.nextExactAction !== "string" ||
    input.nextExactAction.trim().length < 1 ||
    input.nextExactAction.length > 2000
  ) {
    return makeWorkflowError(
      "INVALID_NEXT_EXACT_ACTION",
      "nextExactAction phải là chuỗi từ 1 đến 2000 ký tự.",
      meta
    );
  }

  if (
    !Array.isArray(input.doNotRedo) ||
    input.doNotRedo.length > 30 ||
    input.doNotRedo.some(
      (item) => typeof item !== "string" || item.trim().length < 1 || item.length > 2000
    )
  ) {
    return makeWorkflowError(
      "INVALID_DO_NOT_REDO",
      "doNotRedo chỉ được phép chứa tối đa 30 phần tử hợp lệ.",
      meta
    );
  }

  const approvedPlan = readApprovedPlan(wsContext.memoryDir);
  const taskState = readTaskState(wsContext.memoryDir);

  const mismatchError = verifyProjectMemoryWorkspaceMatch(
    wsContext,
    approvedPlan,
    taskState
  );
  if (mismatchError) {
    return mismatchError;
  }

  if (!approvedPlan.hasApprovedPlan || !approvedPlan.taskId) {
    return makeWorkflowError(
      "NO_APPROVED_PLAN",
      "Chưa có approved plan trong Project Memory. Không thể tạo handoff.",
      meta
    );
  }

  const currentRevision = taskState.revision;

  if (input.expectedRevision !== currentRevision) {
    return makeWorkflowError(
      "REVISION_CONFLICT",
      `Xung đột revision khi tạo handoff: expectedRevision=${input.expectedRevision} nhưng currentRevision=${currentRevision}.`,
      meta,
      currentRevision
    );
  }

  const taskId = approvedPlan.taskId;
  const objective = taskState.objective || approvedPlan.objective;
  const currentImplementationState =
    taskState.currentState ||
    (taskState.status ? `Status: ${taskState.status}` : "Planned (no checkpoint recorded yet)");
  const updatedAt = new Date().toISOString();

  const testsPerformedSection =
    taskState.tests.length > 0
      ? taskState.tests.map((t) => `- ${sanitizeInlineText(t)}`).join("\n")
      : "_None_";

  const knownFailuresSection =
    taskState.failedTests.length > 0
      ? taskState.failedTests.map((t) => `- ${sanitizeInlineText(t)}`).join("\n")
      : "_None_";

  const markdown = `# Handoff State

- **Schema Version**: ${SCHEMA_VERSION}
- **Workspace ID**: ${wsContext.workspaceId}
- **Task ID**: ${taskId}
- **Based on Revision**: ${currentRevision}
- **Reason**: ${input.reason}
- **Objective**: ${sanitizeInlineText(objective)}
- **Current Implementation State**: ${sanitizeInlineText(currentImplementationState)}
- **Updated at**: ${updatedAt}

## Completed
${renderBulletList(taskState.completed)}

## Important Decisions
- See the decision record in Project Memory for recorded architecture and workflow decisions.

## Changed Files
${renderBulletList(taskState.changedFiles)}

## Tests Performed
${testsPerformedSection}

## Known Failures
${knownFailuresSection}

## Next Exact Action
${sanitizeInlineText(input.nextExactAction)}

## Do Not Redo
${renderBulletList(input.doNotRedo)}

## Blockers
${renderBulletList(taskState.blockers)}

## Open Questions
${renderBulletList(taskState.openQuestions)}
`;

  writeMemoryFileAtomic(wsContext.memoryDir, MEMORY_FILES.HANDOFF, markdown);

  return {
    ok: true,
    summaryText: `Đã cập nhật handoff nội bộ cho task ${taskId} (dựa trên revision ${currentRevision}, workspace: ${wsContext.displayName}).`,
    data: {
      taskId,
      basedOnRevision: currentRevision,
      handoffUpdated: true,
      updatedAt,
      ...meta,
    },
  };
}

export interface ArchiveTaskOptions extends WorkflowWorkspaceOptions {
  now?: Date;
  afterArchiveBeforeReset?: () => void;
}

function writeExclusiveFileUtf8(filePath: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(fd, content, { encoding: "utf-8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
    throw err;
  }
}

/**
 * Tool: archive_completed_task
 * Safely archives APPROVED_PLAN.md, TASK_STATE.md, HANDOFF.md, and COMPLETION_SUMMARY.md
 * into .ai/archive/<timestamp-safe>_<taskId>/, verifies all 4 files, and only then resets
 * current task files to empty templates while preserving PROJECT_CONTEXT.md and DECISIONS.md.
 */
export function archiveCompletedTask(
  input: ArchiveCompletedTaskInput,
  customRoot?: string,
  options?: ArchiveTaskOptions
): WorkflowResult<ArchiveCompletedTaskOutput> {
  const bindingId = options?.workspaceBindingId ?? input.workspaceBindingId;
  const resolved = resolveToolWorkspace({
    workspaceBindingId: bindingId,
    customRoot,
    registryOptions: options?.registryOptions,
  });

  if (!resolved.ok) {
    return makeWorkflowError(
      resolved.errorCode,
      resolved.message,
      buildUnresolvedWorkspaceMeta(bindingId)
    );
  }

  const wsContext = resolved.data;
  const meta = extractWorkspaceMetadata(wsContext);

  // Validate symlink/path safety on .ai and .ai/archive upfront
  let archiveRootPath: string;
  try {
    assertSafeMemoryDir(wsContext.memoryDir, wsContext.canonicalRoot);
    archiveRootPath = resolveArchiveRootPath(wsContext.memoryDir);
  } catch (err: unknown) {
    console.error("Archive path/symlink check failed:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      err instanceof Error
        ? err.message
        : "Phát hiện cấu trúc hoặc symlink không an toàn trong Project Memory.",
      meta
    );
  }

  // Precondition 6: userConfirmed === true
  if (input.userConfirmed !== true) {
    return makeWorkflowError(
      "USER_CONFIRMATION_REQUIRED",
      "Chỉ được phép archive task sau khi user xác nhận (userConfirmed: true).",
      meta
    );
  }

  if (!isValidTaskId(input.taskId)) {
    return makeWorkflowError("TASK_ID_MISMATCH", "taskId không hợp lệ.", meta);
  }

  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return makeWorkflowError(
      "REVISION_CONFLICT",
      "expectedRevision phải là số nguyên >= 0.",
      meta
    );
  }

  if (
    typeof input.completionSummary !== "string" ||
    input.completionSummary.trim().length < 1 ||
    input.completionSummary.length > 4000
  ) {
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      "completionSummary phải là chuỗi từ 1 đến 4000 ký tự.",
      meta
    );
  }

  let approvedPlan: ParsedApprovedPlan;
  let taskState: ParsedTaskState;
  try {
    approvedPlan = readApprovedPlan(wsContext.memoryDir);
    taskState = readTaskState(wsContext.memoryDir);
    // Also verify HANDOFF.md, PROJECT_CONTEXT.md, DECISIONS.md are not symlinks
    resolveMemoryFilePath(wsContext.memoryDir, MEMORY_FILES.HANDOFF);
    resolveMemoryFilePath(wsContext.memoryDir, MEMORY_FILES.PROJECT_CONTEXT);
    resolveMemoryFilePath(wsContext.memoryDir, MEMORY_FILES.DECISIONS);
  } catch (err: unknown) {
    console.error("Error reading project memory before archive:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      "Không thể đọc các file Project Memory một cách an toàn.",
      meta
    );
  }

  // Workspace mismatch protection
  const mismatchError = verifyProjectMemoryWorkspaceMatch(
    wsContext,
    approvedPlan,
    taskState
  );
  if (mismatchError) {
    return mismatchError;
  }

  // Precondition 1: Approved plan must exist
  if (!approvedPlan.hasApprovedPlan || !approvedPlan.taskId) {
    return makeWorkflowError(
      "NO_APPROVED_PLAN",
      "Chưa có approved plan trong Project Memory. Không thể archive.",
      meta
    );
  }

  // Precondition 2 & 3: taskId matches APPROVED_PLAN and TASK_STATE
  if (input.taskId !== approvedPlan.taskId) {
    return makeWorkflowError(
      "TASK_ID_MISMATCH",
      `taskId '${input.taskId}' không khớp với APPROVED_PLAN.md ('${approvedPlan.taskId}').`,
      meta
    );
  }

  if (taskState.taskId !== null && taskState.taskId !== input.taskId) {
    return makeWorkflowError(
      "TASK_ID_MISMATCH",
      `taskId '${input.taskId}' không khớp với TASK_STATE.md ('${taskState.taskId}').`,
      meta
    );
  }

  // Precondition 4: expectedRevision matches current TASK_STATE revision
  const currentRevision = taskState.revision;
  if (input.expectedRevision !== currentRevision) {
    return makeWorkflowError(
      "REVISION_CONFLICT",
      `Xung đột revision khi archive: expectedRevision=${input.expectedRevision} nhưng currentRevision=${currentRevision}.`,
      meta,
      currentRevision
    );
  }

  // Precondition 5: TASK_STATE status must be "completed"
  if (taskState.status !== "completed") {
    return makeWorkflowError(
      "TASK_NOT_COMPLETED",
      `Chỉ được archive khi TASK_STATE có status='completed' (hiện tại: '${taskState.status || "not_started"}').`,
      meta
    );
  }

  if (taskState.taskId !== input.taskId) {
    return makeWorkflowError(
      "TASK_ID_MISMATCH",
      "TASK_STATE.md chưa có taskId khớp với kế hoạch hiện tại.",
      meta
    );
  }

  const now = options?.now ?? new Date();
  const completedAt = now.toISOString();
  const timestampSafe = completedAt.replace(/[:.]/g, "-");
  const archiveId = `${timestampSafe}_${input.taskId}`;

  let archiveDir: string;
  try {
    if (!fs.existsSync(archiveRootPath)) {
      fs.mkdirSync(archiveRootPath, { recursive: true });
    }
    archiveDir = resolveArchiveEntryDirPath(wsContext.memoryDir, archiveId);
  } catch (err: unknown) {
    console.error("Failed resolving archive directory:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      err instanceof Error ? err.message : "Không thể khởi tạo đường dẫn archive an toàn.",
      meta
    );
  }

  // Check if archive destination already exists (directory, file, or symlink)
  try {
    fs.lstatSync(archiveDir);
    return makeWorkflowError(
      "ARCHIVE_ALREADY_EXISTS",
      `Thư mục archive '${archiveId}' đã tồn tại. Từ chối ghi đè.`,
      meta
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") {
      console.error("Error inspecting archive destination:", err);
      return makeWorkflowError(
        "ARCHIVE_FAILED",
        "Không thể kiểm tra trạng thái thư mục đích archive.",
        meta
      );
    }
  }

  // Step 2: Create archive directory using exclusive creation (recursive: false)
  try {
    fs.mkdirSync(archiveDir, { recursive: false });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return makeWorkflowError(
        "ARCHIVE_ALREADY_EXISTS",
        `Thư mục archive '${archiveId}' đã tồn tại. Từ chối ghi đè.`,
        meta
      );
    }
    console.error("Error creating archive directory:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      "Không thể tạo thư mục archive mới.",
      meta
    );
  }

  // Steps 3, 4, 5: Copy APPROVED_PLAN.md, TASK_STATE.md, HANDOFF.md, create COMPLETION_SUMMARY.md, and verify all 4 files
  try {
    const srcApprovedPlan = resolveMemoryFilePath(
      wsContext.memoryDir,
      MEMORY_FILES.APPROVED_PLAN
    );
    const srcTaskState = resolveMemoryFilePath(
      wsContext.memoryDir,
      MEMORY_FILES.TASK_STATE
    );
    const srcHandoff = resolveMemoryFilePath(wsContext.memoryDir, MEMORY_FILES.HANDOFF);

    // Ensure HANDOFF.md exists in .ai before copying
    if (!fs.existsSync(srcHandoff)) {
      writeMemoryFileAtomic(wsContext.memoryDir, MEMORY_FILES.HANDOFF, HANDOFF_TEMPLATE);
    }

    const destApprovedPlan = resolveArchiveFilePath(
      archiveDir,
      ARCHIVE_FILES.APPROVED_PLAN
    );
    const destTaskState = resolveArchiveFilePath(archiveDir, ARCHIVE_FILES.TASK_STATE);
    const destHandoff = resolveArchiveFilePath(archiveDir, ARCHIVE_FILES.HANDOFF);
    const destSummary = resolveArchiveFilePath(
      archiveDir,
      ARCHIVE_FILES.COMPLETION_SUMMARY
    );

    fs.copyFileSync(srcApprovedPlan, destApprovedPlan, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(srcTaskState, destTaskState, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(srcHandoff, destHandoff, fs.constants.COPYFILE_EXCL);

    const completionSummaryMarkdown = `# Completion Summary

- **Schema Version**: ${SCHEMA_VERSION}
- **Workspace ID**: ${wsContext.workspaceId}
- **Task ID**: ${input.taskId}
- **Archived Revision**: ${currentRevision}
- **Archive ID**: ${archiveId}
- **Status**: completed
- **Objective**: ${sanitizeInlineText(taskState.objective || approvedPlan.objective)}
- **User Confirmed**: true
- **Completed at**: ${completedAt}

## Completion Summary
${sanitizeInlineText(input.completionSummary)}
`;

    writeExclusiveFileUtf8(destSummary, completionSummaryMarkdown);

    // Step 5: Verify all 4 archive files exist, are regular files (not symlinks), and are readable
    const requiredArchiveFiles: ArchiveFileName[] = [
      ARCHIVE_FILES.APPROVED_PLAN,
      ARCHIVE_FILES.TASK_STATE,
      ARCHIVE_FILES.HANDOFF,
      ARCHIVE_FILES.COMPLETION_SUMMARY,
    ];

    for (const archiveFileName of requiredArchiveFiles) {
      const archivedFilePath = resolveArchiveFilePath(archiveDir, archiveFileName);
      if (!fs.existsSync(archivedFilePath) || isSymbolicLinkPath(archivedFilePath)) {
        throw new Error(`File archive ${archiveFileName} không tồn tại hoặc là symlink.`);
      }
      const stat = fs.lstatSync(archivedFilePath);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error(`File archive ${archiveFileName} rỗng hoặc không hợp lệ.`);
      }
      const verifiedContent = fs.readFileSync(archivedFilePath, "utf-8");
      if (verifiedContent.trim().length === 0) {
        throw new Error(`Không thể đọc nội dung hợp lệ từ ${archiveFileName}.`);
      }
    }
  } catch (err: unknown) {
    console.error("Archive creation/verification failed before reset:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      "Lỗi trong quá trình lưu trữ hoặc xác minh file archive. Trạng thái task hiện tại không bị thay đổi.",
      meta
    );
  }

  // Step 6: Only after archive is verified, reset APPROVED_PLAN.md, TASK_STATE.md, HANDOFF.md
  try {
    if (options?.afterArchiveBeforeReset) {
      options.afterArchiveBeforeReset();
    }
    writeMemoryFileAtomic(
      wsContext.memoryDir,
      MEMORY_FILES.APPROVED_PLAN,
      APPROVED_PLAN_TEMPLATE
    );
    writeMemoryFileAtomic(
      wsContext.memoryDir,
      MEMORY_FILES.TASK_STATE,
      TASK_STATE_TEMPLATE
    );
    writeMemoryFileAtomic(
      wsContext.memoryDir,
      MEMORY_FILES.HANDOFF,
      HANDOFF_TEMPLATE
    );
  } catch (err: unknown) {
    // Step 8: Partial reset failure - keep archive evidence intact, log to stderr, return ARCHIVE_FAILED
    console.error("Partial reset failure after archive creation:", err);
    return makeWorkflowError(
      "ARCHIVE_FAILED",
      "Archive đã được tạo an toàn nhưng xảy ra lỗi khi reset các file task hiện tại. Bản lưu archive được giữ nguyên để phục hồi.",
      meta
    );
  }

  return {
    ok: true,
    summaryText: `Đã archive task ${input.taskId} (revision ${currentRevision}) trong Project Memory và reset trạng thái task hiện tại (workspace: ${wsContext.displayName}).`,
    data: {
      archived: true,
      taskId: input.taskId,
      archivedRevision: currentRevision,
      archiveId,
      resetCurrentTask: true,
      completedAt,
      ...meta,
    },
  };
}
