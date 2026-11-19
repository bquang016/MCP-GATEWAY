import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { MemoryFileName, resolveMemoryFilePath } from "../config.js";

/**
 * Safely and atomically writes UTF-8 content to a fixed Project Memory file inside .ai.
 * - Generates temporary file strictly inside .ai (never controlled by MCP client).
 * - Flushes content completely (fsync) and closes handle before replacing target.
 * - Cleans up temporary file on any error.
 */
export function writeMemoryFileAtomic(
  memoryDir: string,
  fileName: MemoryFileName,
  content: string,
  options?: {
    beforeReplace?: (targetPath: string) => void;
  }
): string {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const targetPath = resolveMemoryFilePath(resolvedMemoryDir, fileName);

  if (!fs.existsSync(resolvedMemoryDir)) {
    fs.mkdirSync(resolvedMemoryDir, { recursive: true });
  }

  const tempFileName = `.tmp-${fileName}-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`;
  const tempPath = path.resolve(resolvedMemoryDir, tempFileName);
  const relativeTemp = path.relative(resolvedMemoryDir, tempPath);

  if (
    relativeTemp.startsWith("..") ||
    path.isAbsolute(relativeTemp) ||
    path.dirname(tempPath) !== resolvedMemoryDir
  ) {
    throw new Error("Không thể tạo temporary file ngoài bộ nhớ nội bộ.");
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content, { encoding: "utf-8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (options?.beforeReplace) {
      options.beforeReplace(targetPath);
    }

    replaceFileWindowsSafe(tempPath, targetPath);
    return targetPath;
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error during cleanup
      }
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore unlink error during cleanup
    }
    throw err;
  }
}

/**
 * Performs atomic file replacement compatible with Windows and POSIX.
 * Retries briefly if Windows temporarily holds a lock (EPERM / EACCES).
 */
function replaceFileWindowsSafe(tempPath: string, targetPath: string): void {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === "EPERM" || code === "EACCES") && attempt < maxAttempts) {
        // Brief synchronous wait (~10ms) using SharedArrayBuffer/Atomics before retry
        try {
          const sab = new SharedArrayBuffer(4);
          const int32 = new Int32Array(sab);
          Atomics.wait(int32, 0, 0, 10 * attempt);
        } catch {
          // Ignore if Atomics.wait is unavailable
        }
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

