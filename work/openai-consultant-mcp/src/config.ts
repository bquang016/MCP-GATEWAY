import process from "node:process";
import path from "node:path";
import fs from "node:fs";

// Try to load .env file if available (supported in Node.js 20.6+)
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // Gracefully ignore if .env file is absent; system environment variables will be used.
}

export const MEMORY_FILES = {
  PROJECT_CONTEXT: "PROJECT_CONTEXT.md",
  APPROVED_PLAN: "APPROVED_PLAN.md",
  TASK_STATE: "TASK_STATE.md",
  DECISIONS: "DECISIONS.md",
  HANDOFF: "HANDOFF.md",
} as const;

export type MemoryFileName = (typeof MEMORY_FILES)[keyof typeof MEMORY_FILES];

export const ARCHIVE_FILES = {
  APPROVED_PLAN: "APPROVED_PLAN.md",
  TASK_STATE: "TASK_STATE.md",
  HANDOFF: "HANDOFF.md",
  COMPLETION_SUMMARY: "COMPLETION_SUMMARY.md",
} as const;

export type ArchiveFileName = (typeof ARCHIVE_FILES)[keyof typeof ARCHIVE_FILES];

export interface WorkspaceConfig {
  configured: boolean;
  workspaceRoot?: string;
  memoryDir?: string;
  errorMessage?: string;
}

/**
 * Checks whether a path is a symbolic link (or Windows junction/reparse point) without following it.
 */
export function isSymbolicLinkPath(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Verifies that childRealPath is strictly inside parentRealPath.
 */
export function isRealPathInside(parentRealPath: string, childRealPath: string): boolean {
  const rel = path.relative(parentRealPath, childRealPath);
  return Boolean(rel) && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves and validates the workspace root from environment variable MCP_WORKSPACE_ROOT.
 * Does not infer or fall back to current directory or home directory.
 */
export function getWorkspaceConfig(customRoot?: string): WorkspaceConfig {
  const rawRoot = customRoot ?? process.env.MCP_WORKSPACE_ROOT;
  if (!rawRoot || !rawRoot.trim()) {
    return {
      configured: false,
      errorMessage: "Biến môi trường MCP_WORKSPACE_ROOT chưa được cấu hình.",
    };
  }

  const resolvedRoot = path.resolve(rawRoot.trim());

  try {
    const stats = fs.statSync(resolvedRoot);
    if (!stats.isDirectory()) {
      return {
        configured: false,
        errorMessage: "MCP_WORKSPACE_ROOT không phải là thư mục hợp lệ.",
      };
    }
  } catch {
    return {
      configured: false,
      errorMessage: "Thư mục MCP_WORKSPACE_ROOT không tồn tại hoặc không thể truy cập.",
    };
  }

  const memoryDir = path.join(resolvedRoot, ".ai");

  return {
    configured: true,
    workspaceRoot: resolvedRoot,
    memoryDir,
  };
}

/**
 * Ensures the .ai directory is not a symlink and does not escape workspaceRoot.
 */
export function assertSafeMemoryDir(memoryDir: string, workspaceRoot?: string): void {
  const resolvedMemoryDir = path.resolve(memoryDir);
  if (isSymbolicLinkPath(resolvedMemoryDir)) {
    throw new Error("Phát hiện symlink không được phép trong bộ nhớ nội bộ.");
  }

  if (fs.existsSync(resolvedMemoryDir)) {
    const parentRoot = workspaceRoot
      ? path.resolve(workspaceRoot)
      : path.dirname(resolvedMemoryDir);
    if (fs.existsSync(parentRoot)) {
      const realParent = fs.realpathSync(parentRoot);
      const realMemory = fs.realpathSync(resolvedMemoryDir);
      if (!isRealPathInside(realParent, realMemory)) {
        throw new Error("Phát hiện bộ nhớ nội bộ trỏ ra ngoài phạm vi workspace.");
      }
    }
  }
}

/**
 * Strict path traversal and symlink guard: ensures resolved file target is strictly
 * inside the .ai memory directory and exactly matches one of the 5 allowed file names.
 */
export function resolveMemoryFilePath(memoryDir: string, fileName: MemoryFileName): string {
  const allowedNames = Object.values(MEMORY_FILES) as string[];
  if (!allowedNames.includes(fileName)) {
    throw new Error("Tên file không nằm trong danh sách Project Memory được phép.");
  }

  const resolvedMemoryDir = path.resolve(memoryDir);
  assertSafeMemoryDir(resolvedMemoryDir);

  const targetPath = path.resolve(resolvedMemoryDir, fileName);
  const relative = path.relative(resolvedMemoryDir, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== fileName) {
    throw new Error("Phát hiện truy cập ngoài phạm vi Project Memory hợp lệ.");
  }

  if (isSymbolicLinkPath(targetPath)) {
    throw new Error(`Phát hiện symlink không được phép tại file Project Memory: ${fileName}`);
  }

  if (fs.existsSync(targetPath) && fs.existsSync(resolvedMemoryDir)) {
    const realMemory = fs.realpathSync(resolvedMemoryDir);
    const realTarget = fs.realpathSync(targetPath);
    if (!isRealPathInside(realMemory, realTarget)) {
      throw new Error("Phát hiện bản ghi Project Memory dẫn ra ngoài phạm vi cho phép.");
    }
  }

  return targetPath;
}

/**
 * Validates and resolves the fixed archive root directory: <MCP_WORKSPACE_ROOT>/.ai/archive.
 * Rejects if .ai or .ai/archive is a symlink or escapes .ai.
 */
export function resolveArchiveRootPath(memoryDir: string): string {
  const resolvedMemoryDir = path.resolve(memoryDir);
  assertSafeMemoryDir(resolvedMemoryDir);

  const archiveRoot = path.resolve(resolvedMemoryDir, "archive");
  const relative = path.relative(resolvedMemoryDir, archiveRoot);

  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== "archive") {
    throw new Error("Đường dẫn archive root không hợp lệ.");
  }

  if (isSymbolicLinkPath(archiveRoot)) {
    throw new Error("Phát hiện symlink không được phép trong kho lưu trữ nội bộ.");
  }

  if (fs.existsSync(archiveRoot)) {
    const stat = fs.lstatSync(archiveRoot);
    if (!stat.isDirectory()) {
      throw new Error("Kho lưu trữ nội bộ không hợp lệ.");
    }
    if (fs.existsSync(resolvedMemoryDir)) {
      const realMemory = fs.realpathSync(resolvedMemoryDir);
      const realArchiveRoot = fs.realpathSync(archiveRoot);
      if (!isRealPathInside(realMemory, realArchiveRoot)) {
        throw new Error("Phát hiện kho lưu trữ dẫn ra ngoài phạm vi nội bộ.");
      }
    }
  }

  return archiveRoot;
}

/**
 * Validates a server-generated archive directory name (<timestamp-safe>_<taskId>)
 * and resolves its path strictly inside <MCP_WORKSPACE_ROOT>/.ai/archive.
 */
export function resolveArchiveEntryDirPath(memoryDir: string, archiveId: string): string {
  if (
    typeof archiveId !== "string" ||
    archiveId.length < 1 ||
    archiveId.length > 160 ||
    archiveId.includes("..") ||
    archiveId.includes("/") ||
    archiveId.includes("\\") ||
    !/^[0-9A-Za-z._-]+$/.test(archiveId)
  ) {
    throw new Error("Tên thư mục archiveId không hợp lệ.");
  }

  const archiveRoot = resolveArchiveRootPath(memoryDir);
  const archiveDir = path.resolve(archiveRoot, archiveId);
  const relative = path.relative(archiveRoot, archiveDir);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative !== archiveId ||
    path.dirname(archiveDir) !== archiveRoot
  ) {
    throw new Error("Phát hiện truy cập ngoài phạm vi lưu trữ nội bộ.");
  }

  if (isSymbolicLinkPath(archiveDir)) {
    throw new Error("Phát hiện symlink không được phép tại đích archive.");
  }

  return archiveDir;
}

/**
 * Resolves one of the 4 allowed files inside a validated archive directory.
 */
export function resolveArchiveFilePath(archiveDir: string, fileName: ArchiveFileName): string {
  const allowedNames = Object.values(ARCHIVE_FILES) as string[];
  if (!allowedNames.includes(fileName)) {
    throw new Error("Tên file archive không nằm trong danh sách được phép.");
  }

  const resolvedArchiveDir = path.resolve(archiveDir);
  if (isSymbolicLinkPath(resolvedArchiveDir)) {
    throw new Error("Phát hiện symlink không được phép tại thư mục archive.");
  }

  const targetPath = path.resolve(resolvedArchiveDir, fileName);
  const relative = path.relative(resolvedArchiveDir, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== fileName) {
    throw new Error("Phát hiện truy cập ngoài phạm vi thư mục archive.");
  }

  if (isSymbolicLinkPath(targetPath)) {
    throw new Error(`Phát hiện symlink không được phép tại file archive: ${fileName}`);
  }

  return targetPath;
}

/**
 * Validates that a taskId is 1-100 characters and does not contain
 * path separators (/ or \), "..", Windows-invalid filename characters, or control characters.
 */
export function isValidTaskId(taskId: string): boolean {
  if (typeof taskId !== "string") {
    return false;
  }
  const trimmed = taskId.trim();
  if (trimmed.length < 1 || trimmed.length > 100 || trimmed !== taskId) {
    return false;
  }
  if (
    taskId.includes("/") ||
    taskId.includes("\\") ||
    taskId.includes("..") ||
    taskId.includes("\0") ||
    taskId.includes("\r") ||
    taskId.includes("\n") ||
    /[<>:"|?*]/.test(taskId)
  ) {
    return false;
  }
  return true;
}

/**
 * Validates that a changed file entry is a safe relative project path:
 * - No absolute path (POSIX or Windows)
 * - No ".." or path traversal
 * - Does not need to exist on disk
 */
export function isValidRelativeProjectPath(filePath: string, workspaceRoot?: string): boolean {
  if (typeof filePath !== "string") {
    return false;
  }
  const trimmed = filePath.trim();
  if (trimmed.length === 0 || trimmed !== filePath) {
    return false;
  }
  if (
    filePath.includes("\0") ||
    filePath.includes("\r") ||
    filePath.includes("\n")
  ) {
    return false;
  }
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(filePath) ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    path.posix.isAbsolute(filePath)
  ) {
    return false;
  }
  if (filePath.includes("..")) {
    return false;
  }
  const segments = filePath.split(/[\\/]+/);
  if (segments.some((seg) => seg === ".." || seg === "")) {
    return false;
  }

  const baseRoot = workspaceRoot ? path.resolve(workspaceRoot) : path.resolve(".");
  const resolved = path.resolve(baseRoot, filePath);
  const relative = path.relative(baseRoot, resolved);
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  return true;
}
