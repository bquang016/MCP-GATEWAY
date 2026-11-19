import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";

export const REGISTRY_SCHEMA_VERSION = "1.0";
export const DEFAULT_LEASE_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
export const DEFAULT_BINDING_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_LOCK_MS = 10_000;

export interface WorkspaceRecord {
  workspaceId: string;
  displayName: string;
  canonicalRoot: string;
  rootFingerprint: string;
  source: "antigravity";
  conversationId: string;
  lastSeenAt: string;
  leaseExpiresAt: string;
  status: "active" | "expired";
}

export interface PublicWorkspaceInfo {
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  status: "active" | "expired";
  lastSeenAt: string;
  leaseExpiresAt: string;
  isActive: boolean;
}

export interface WorkspaceBindingRecord {
  bindingId: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface PublicBindingInfo {
  bindingId: string;
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  workspaceStatus: "active" | "expired";
  isActiveWorkspace: boolean;
}

interface RegistryFileSchema {
  schemaVersion: string;
  workspaces: Record<string, WorkspaceRecord>;
}

interface ActiveWorkspaceFileSchema {
  schemaVersion: string;
  activeWorkspaceId: string | null;
  updatedAt: string | null;
}

interface BindingsFileSchema {
  schemaVersion: string;
  bindings: Record<string, WorkspaceBindingRecord>;
}

export interface CanonicalWorkspaceIdentity {
  workspaceId: string;
  displayName: string;
  canonicalRoot: string;
  normalizedCompareKey: string;
  rootFingerprint: string;
}

export interface RegistryOptions {
  dataDir?: string;
  now?: Date;
  leaseDurationMs?: number;
  bindingTtlMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface RegistryError {
  ok: false;
  errorCode:
    | "NO_ACTIVE_WORKSPACE"
    | "WORKSPACE_NOT_RESOLVED"
    | "BINDING_NOT_FOUND"
    | "BINDING_EXPIRED"
    | "WORKSPACE_MISMATCH"
    | "REGISTRY_LOCK_TIMEOUT"
    | "INVALID_HOOK_PAYLOAD";
  message: string;
}

export interface RegistrySuccess<T> {
  ok: true;
  data: T;
}

export type RegistryResult<T> = RegistrySuccess<T> | RegistryError;

/**
 * Resolves the global registry directory.
 * Defaults to %APPDATA%\dual-agent-workflow-gateway\ on Windows,
 * and allows override via DAGW_DATA_DIR or options.dataDir.
 */
export function getRegistryDataDir(customDataDir?: string): string {
  const override = customDataDir ?? process.env.DAGW_DATA_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }

  const appData =
    process.env.APPDATA ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config"));

  return path.resolve(appData, "dual-agent-workflow-gateway");
}

/**
 * Normalizes a canonical path for case-insensitive comparison on Windows.
 */
export function normalizePathForComparison(canonicalPath: string): string {
  const isWinPath =
    process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(canonicalPath);
  const slashNormalized = canonicalPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWinPath ? slashNormalized.toLowerCase() : slashNormalized;
}

/**
 * Checks if two paths refer to the same canonical directory (case-insensitive on Windows).
 */
export function areCanonicalPathsEqual(pathA: string, pathB: string): boolean {
  return normalizePathForComparison(pathA) === normalizePathForComparison(pathB);
}

/**
 * Verifies that rawPath exists, is a directory (and not a broken link),
 * resolves its canonical realpath, and computes deterministic workspaceId and rootFingerprint.
 */
export function canonicalizeWorkspaceRoot(rawPath: string): CanonicalWorkspaceIdentity {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("Đường dẫn workspace rỗng hoặc không hợp lệ.");
  }

  const resolved = path.resolve(rawPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error("Đường dẫn workspace không tồn tại.");
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Đường dẫn workspace không phải là thư mục.");
  }

  const realRoot =
    typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);

  // Strip trailing slash except root drive (e.g. C:\ or /)
  const cleanedRoot =
    realRoot.length > 3 && /[\\/]$/.test(realRoot)
      ? realRoot.replace(/[\\/]+$/, "")
      : realRoot;

  const normalizedCompareKey = normalizePathForComparison(cleanedRoot);

  const workspaceHash = crypto
    .createHash("sha256")
    .update(`dagw:workspace:v1:${normalizedCompareKey}`)
    .digest("hex")
    .slice(0, 32);

  const fingerprintHash = crypto
    .createHash("sha256")
    .update(`dagw:fingerprint:v1:${normalizedCompareKey}`)
    .digest("hex")
    .slice(0, 12);

  const baseName = path.basename(cleanedRoot) || cleanedRoot;

  return {
    workspaceId: `ws_${workspaceHash}`,
    displayName: baseName,
    canonicalRoot: cleanedRoot,
    normalizedCompareKey,
    rootFingerprint: `fp_${fingerprintHash}`,
  };
}

function sleepSync(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback
    }
  }
}

export function writeJsonAtomic(dirPath: string, fileName: string, data: unknown): void {
  const resolvedDir = path.resolve(dirPath);
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const targetPath = path.resolve(resolvedDir, fileName);
  const tempName = `.tmp-${fileName}-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`;
  const tempPath = path.resolve(resolvedDir, tempName);

  const content = JSON.stringify(data, null, 2) + "\n";
  let fd: number | undefined;

  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content, { encoding: "utf-8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(tempPath, targetPath);
        return;
      } catch (err: unknown) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if ((code === "EPERM" || code === "EACCES") && attempt < maxAttempts) {
          sleepSync(10 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore
    }
    throw err;
  }
}

export function readJsonFileOrDefault<T>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    return defaultValue;
  }
  return JSON.parse(raw) as T;
}

/**
 * Executes a callback under an exclusive inter-process file lock (<dataDir>/locks/registry.lock).
 * Supports retry, timeout, and automatic stale-lock recovery.
 */
export function withRegistryLock<T>(
  fn: (dataDir: string) => T,
  options?: RegistryOptions
): RegistryResult<T> {
  const dataDir = getRegistryDataDir(options?.dataDir);
  const locksDir = path.join(dataDir, "locks");
  const lockFilePath = path.join(locksDir, "registry.lock");

  const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

  if (!fs.existsSync(locksDir)) {
    fs.mkdirSync(locksDir, { recursive: true });
  }

  const startTime = Date.now();
  let acquired = false;
  const lockToken = crypto.randomUUID();

  while (!acquired) {
    try {
      const fd = fs.openSync(lockFilePath, "wx", 0o600);
      try {
        const lockMetadata = JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          token: lockToken,
        });
        fs.writeFileSync(fd, lockMetadata, { encoding: "utf-8" });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      // Check if existing lock is stale
      try {
        if (fs.existsSync(lockFilePath)) {
          const stat = fs.statSync(lockFilePath);
          let lockCreatedAt = stat.mtimeMs;
          try {
            const rawLock = fs.readFileSync(lockFilePath, "utf-8");
            const parsedLock = JSON.parse(rawLock) as { createdAt?: number };
            if (typeof parsedLock.createdAt === "number") {
              lockCreatedAt = parsedLock.createdAt;
            }
          } catch {
            // Use mtimeMs if lock file content is empty or being written
          }

          if (Date.now() - lockCreatedAt > staleLockMs) {
            try {
              fs.unlinkSync(lockFilePath);
              continue;
            } catch {
              // Another process may have already recovered it
            }
          }
        }
      } catch {
        // Ignore transient stat error if lock was just released
      }

      if (Date.now() - startTime >= lockTimeoutMs) {
        return {
          ok: false,
          errorCode: "REGISTRY_LOCK_TIMEOUT",
          message: `Không thể lấy khóa registry trong ${lockTimeoutMs}ms.`,
        };
      }

      sleepSync(15);
    }
  }

  try {
    const result = fn(dataDir);
    return {
      ok: true,
      data: result,
    };
  } finally {
    try {
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

function loadRegistryState(dataDir: string): {
  registry: RegistryFileSchema;
  active: ActiveWorkspaceFileSchema;
  bindings: BindingsFileSchema;
} {
  const registryPath = path.join(dataDir, "registry.json");
  const activePath = path.join(dataDir, "active-workspace.json");
  const bindingsPath = path.join(dataDir, "bindings.json");

  const registry = readJsonFileOrDefault<RegistryFileSchema>(registryPath, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    workspaces: {},
  });

  const active = readJsonFileOrDefault<ActiveWorkspaceFileSchema>(activePath, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    activeWorkspaceId: null,
    updatedAt: null,
  });

  const bindings = readJsonFileOrDefault<BindingsFileSchema>(bindingsPath, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    bindings: {},
  });

  return { registry, active, bindings };
}

function isLeaseActive(leaseExpiresAt: string, now: Date): boolean {
  const expiresMs = Date.parse(leaseExpiresAt);
  return !Number.isNaN(expiresMs) && expiresMs > now.getTime();
}

export interface HookRegisterPayload {
  conversationId?: unknown;
  workspacePaths?: unknown;
  cwd?: unknown;
  hookEventName?: unknown;
}

/**
 * Registers or refreshes a workspace lease from an Antigravity SessionStart / PreInvocation hook payload.
 * Priority: workspacePaths[0] -> cwd. Never uses process.cwd().
 */
export function registerWorkspaceFromHook(
  payload: unknown,
  options?: RegistryOptions
): RegistryResult<PublicWorkspaceInfo> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: "Hook payload phải là một JSON object.",
    };
  }

  const record = payload as HookRegisterPayload;

  let candidatePath: string | null = null;
  if (Array.isArray(record.workspacePaths) && record.workspacePaths.length > 0) {
    const first = record.workspacePaths[0];
    if (typeof first === "string" && first.trim().length > 0) {
      candidatePath = first.trim();
    }
  }

  if (!candidatePath && typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    candidatePath = record.cwd.trim();
  }

  if (!candidatePath) {
    return {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: "Hook payload không chứa workspacePaths[0] hoặc cwd hợp lệ.",
    };
  }

  if (
    record.hookEventName !== undefined &&
    record.hookEventName !== "SessionStart" &&
    record.hookEventName !== "PreInvocation"
  ) {
    return {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: `hookEventName không được hỗ trợ trong Phase 1: ${String(record.hookEventName)}`,
    };
  }

  let identity: CanonicalWorkspaceIdentity;
  try {
    identity = canonicalizeWorkspaceRoot(candidatePath);
  } catch (err: unknown) {
    return {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message:
        err instanceof Error
          ? err.message
          : "Không thể xác minh hoặc canonicalize đường dẫn workspace.",
    };
  }

  const now = options?.now ?? new Date();
  const leaseDurationMs = options?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  const conversationId =
    typeof record.conversationId === "string" && record.conversationId.trim().length > 0
      ? record.conversationId.trim()
      : "unknown";

  const lockResult = withRegistryLock((dataDir) => {
    const { registry, active } = loadRegistryState(dataDir);

    const wsRecord: WorkspaceRecord = {
      workspaceId: identity.workspaceId,
      displayName: identity.displayName,
      canonicalRoot: identity.canonicalRoot,
      rootFingerprint: identity.rootFingerprint,
      source: "antigravity",
      conversationId,
      lastSeenAt: nowIso,
      leaseExpiresAt,
      status: "active",
    };

    registry.workspaces[identity.workspaceId] = wsRecord;
    active.activeWorkspaceId = identity.workspaceId;
    active.updatedAt = nowIso;

    writeJsonAtomic(dataDir, "registry.json", registry);
    writeJsonAtomic(dataDir, "active-workspace.json", active);

    const publicInfo: PublicWorkspaceInfo = {
      workspaceId: wsRecord.workspaceId,
      displayName: wsRecord.displayName,
      rootFingerprint: wsRecord.rootFingerprint,
      status: "active",
      lastSeenAt: wsRecord.lastSeenAt,
      leaseExpiresAt: wsRecord.leaseExpiresAt,
      isActive: true,
    };

    return publicInfo;
  }, options);

  return lockResult;
}

/**
 * Lists all registered workspaces without exposing canonicalRoot.
 */
export function listRegisteredWorkspaces(
  options?: RegistryOptions
): RegistryResult<{
  activeWorkspaceId: string | null;
  workspaces: PublicWorkspaceInfo[];
}> {
  const now = options?.now ?? new Date();

  return withRegistryLock((dataDir) => {
    const { registry, active } = loadRegistryState(dataDir);
    const activeId = active.activeWorkspaceId;

    const list: PublicWorkspaceInfo[] = Object.values(registry.workspaces)
      .map((ws) => {
        const leaseValid = isLeaseActive(ws.leaseExpiresAt, now);
        const status: "active" | "expired" = leaseValid ? "active" : "expired";
        const isActive = Boolean(leaseValid && activeId === ws.workspaceId);

        return {
          workspaceId: ws.workspaceId,
          displayName: ws.displayName,
          rootFingerprint: ws.rootFingerprint,
          status,
          lastSeenAt: ws.lastSeenAt,
          leaseExpiresAt: ws.leaseExpiresAt,
          isActive,
        };
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

    const effectiveActiveId = list.find((w) => w.isActive)?.workspaceId ?? null;

    return {
      activeWorkspaceId: effectiveActiveId,
      workspaces: list,
    };
  }, options);
}

/**
 * Creates a binding to the currently active workspace if its lease is valid.
 */
export function createBindingForActiveWorkspace(
  options?: RegistryOptions
): RegistryResult<{
  binding: WorkspaceBindingRecord;
  workspace: WorkspaceRecord;
}> {
  const now = options?.now ?? new Date();
  const bindingTtlMs = options?.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;

  const locked = withRegistryLock((dataDir): RegistryResult<{
    binding: WorkspaceBindingRecord;
    workspace: WorkspaceRecord;
  }> => {
    const { registry, active, bindings } = loadRegistryState(dataDir);
    const activeId = active.activeWorkspaceId;

    if (!activeId || !registry.workspaces[activeId]) {
      return {
        ok: false,
        errorCode: "NO_ACTIVE_WORKSPACE",
        message: "Chưa có active workspace nào được đăng ký từ Antigravity.",
      };
    }

    const ws = registry.workspaces[activeId];
    if (!isLeaseActive(ws.leaseExpiresAt, now)) {
      ws.status = "expired";
      writeJsonAtomic(dataDir, "registry.json", registry);
      return {
        ok: false,
        errorCode: "NO_ACTIVE_WORKSPACE",
        message: `Lease của active workspace '${ws.displayName}' (${ws.workspaceId}) đã hết hạn.`,
      };
    }

    // Verify canonicalRoot still exists on disk and matches workspaceId
    try {
      const verifiedIdentity = canonicalizeWorkspaceRoot(ws.canonicalRoot);
      if (verifiedIdentity.workspaceId !== ws.workspaceId) {
        return {
          ok: false,
          errorCode: "WORKSPACE_MISMATCH",
          message: "Đường dẫn canonical của workspace không còn khớp với workspaceId đã đăng ký.",
        };
      }
    } catch {
      return {
        ok: false,
        errorCode: "NO_ACTIVE_WORKSPACE",
        message: "Thư mục của active workspace không còn tồn tại trên hệ thống.",
      };
    }

    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + bindingTtlMs).toISOString();
    const bindingId = `bind_${crypto.randomBytes(16).toString("hex")}`;

    const bindingRecord: WorkspaceBindingRecord = {
      bindingId,
      workspaceId: ws.workspaceId,
      createdAt: nowIso,
      expiresAt,
      lastUsedAt: nowIso,
    };

    bindings.bindings[bindingId] = bindingRecord;
    writeJsonAtomic(dataDir, "bindings.json", bindings);

    return {
      ok: true,
      data: {
        binding: bindingRecord,
        workspace: ws,
      },
    };
  }, options);

  if (!locked.ok) {
    return locked;
  }
  return locked.data;
}

/**
 * Inspects an existing binding without exposing canonicalRoot.
 */
export function getWorkspaceBindingInfo(
  bindingId: string,
  options?: RegistryOptions
): RegistryResult<PublicBindingInfo> {
  if (typeof bindingId !== "string" || !bindingId.trim()) {
    return {
      ok: false,
      errorCode: "BINDING_NOT_FOUND",
      message: "bindingId không hợp lệ.",
    };
  }

  const now = options?.now ?? new Date();

  const locked = withRegistryLock((dataDir): RegistryResult<PublicBindingInfo> => {
    const { registry, active, bindings } = loadRegistryState(dataDir);
    const binding = bindings.bindings[bindingId.trim()];

    if (!binding) {
      return {
        ok: false,
        errorCode: "BINDING_NOT_FOUND",
        message: `Không tìm thấy workspace binding '${bindingId}'.`,
      };
    }

    if (!isLeaseActive(binding.expiresAt, now)) {
      return {
        ok: false,
        errorCode: "BINDING_EXPIRED",
        message: `Workspace binding '${bindingId}' đã hết hạn vào lúc ${binding.expiresAt}.`,
      };
    }

    const ws = registry.workspaces[binding.workspaceId];
    if (!ws) {
      return {
        ok: false,
        errorCode: "WORKSPACE_MISMATCH",
        message: `Workspace '${binding.workspaceId}' gắn với binding không còn trong registry.`,
      };
    }

    const wsLeaseValid = isLeaseActive(ws.leaseExpiresAt, now);

    return {
      ok: true,
      data: {
        bindingId: binding.bindingId,
        workspaceId: ws.workspaceId,
        displayName: ws.displayName,
        rootFingerprint: ws.rootFingerprint,
        createdAt: binding.createdAt,
        expiresAt: binding.expiresAt,
        lastUsedAt: binding.lastUsedAt,
        workspaceStatus: wsLeaseValid ? "active" : "expired",
        isActiveWorkspace: Boolean(
          wsLeaseValid && active.activeWorkspaceId === ws.workspaceId
        ),
      },
    };
  }, options);

  if (!locked.ok) {
    return locked;
  }
  return locked.data;
}

/**
 * Deletes a binding from bindings.json without deleting the workspace registry or Project Memory.
 */
export function detachWorkspaceBinding(
  bindingId: string,
  options?: RegistryOptions
): RegistryResult<{
  detached: true;
  bindingId: string;
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
}> {
  if (typeof bindingId !== "string" || !bindingId.trim()) {
    return {
      ok: false,
      errorCode: "BINDING_NOT_FOUND",
      message: "bindingId không hợp lệ.",
    };
  }

  const locked = withRegistryLock((dataDir): RegistryResult<{
    detached: true;
    bindingId: string;
    workspaceId: string;
    displayName: string;
    rootFingerprint: string;
  }> => {
    const { registry, bindings } = loadRegistryState(dataDir);
    const trimmedId = bindingId.trim();
    const existing = bindings.bindings[trimmedId];

    if (!existing) {
      return {
        ok: false,
        errorCode: "BINDING_NOT_FOUND",
        message: `Không tìm thấy workspace binding '${trimmedId}'.`,
      };
    }

    const ws = registry.workspaces[existing.workspaceId];
    delete bindings.bindings[trimmedId];
    writeJsonAtomic(dataDir, "bindings.json", bindings);

    return {
      ok: true,
      data: {
        detached: true,
        bindingId: trimmedId,
        workspaceId: existing.workspaceId,
        displayName: ws?.displayName ?? "unknown",
        rootFingerprint: ws?.rootFingerprint ?? "unknown",
      },
    };
  }, options);

  if (!locked.ok) {
    return locked;
  }
  return locked.data;
}

export interface ResolvedWorkspaceContext {
  canonicalRoot: string;
  memoryDir: string;
  workspaceId: string;
  displayName: string;
  rootFingerprint: string;
  workspaceResolution: "binding" | "environment";
  bindingId?: string;
}

/**
 * Resolves the workspace for a Project Memory tool call:
 * 1. If workspaceBindingId is provided: resolves strictly via binding (never falls back to environment on failure).
 * 2. If workspaceBindingId is not provided: falls back to customRoot or MCP_WORKSPACE_ROOT.
 * 3. If neither is available: returns WORKSPACE_NOT_RESOLVED.
 * Never uses process.cwd().
 */
export function resolveToolWorkspace(params?: {
  workspaceBindingId?: string;
  customRoot?: string;
  registryOptions?: RegistryOptions;
}): RegistryResult<ResolvedWorkspaceContext> {
  const bindingId = params?.workspaceBindingId;
  const regOpts = params?.registryOptions;
  const now = regOpts?.now ?? new Date();

  if (bindingId !== undefined) {
    if (typeof bindingId !== "string" || bindingId.trim().length === 0) {
      return {
        ok: false,
        errorCode: "BINDING_NOT_FOUND",
        message: "workspaceBindingId không hợp lệ.",
      };
    }

    const trimmedBindingId = bindingId.trim();

    const locked = withRegistryLock((dataDir): RegistryResult<ResolvedWorkspaceContext> => {
      const { registry, bindings } = loadRegistryState(dataDir);
      const binding = bindings.bindings[trimmedBindingId];

      if (!binding) {
        return {
          ok: false,
          errorCode: "BINDING_NOT_FOUND",
          message: `Không tìm thấy workspace binding '${trimmedBindingId}'.`,
        };
      }

      if (!isLeaseActive(binding.expiresAt, now)) {
        return {
          ok: false,
          errorCode: "BINDING_EXPIRED",
          message: `Workspace binding '${trimmedBindingId}' đã hết hạn.`,
        };
      }

      const ws = registry.workspaces[binding.workspaceId];
      if (!ws) {
        return {
          ok: false,
          errorCode: "WORKSPACE_MISMATCH",
          message: `Workspace '${binding.workspaceId}' của binding không tồn tại trong registry.`,
        };
      }

      let verifiedIdentity: CanonicalWorkspaceIdentity;
      try {
        verifiedIdentity = canonicalizeWorkspaceRoot(ws.canonicalRoot);
      } catch {
        return {
          ok: false,
          errorCode: "WORKSPACE_MISMATCH",
          message: "Thư mục workspace gắn với binding không còn tồn tại hoặc không thể truy cập.",
        };
      }

      if (
        verifiedIdentity.workspaceId !== ws.workspaceId ||
        verifiedIdentity.workspaceId !== binding.workspaceId
      ) {
        return {
          ok: false,
          errorCode: "WORKSPACE_MISMATCH",
          message: "Phát hiện không khớp giữa workspace của binding và thư mục thực tế.",
        };
      }

      binding.lastUsedAt = now.toISOString();
      writeJsonAtomic(dataDir, "bindings.json", bindings);

      return {
        ok: true,
        data: {
          canonicalRoot: verifiedIdentity.canonicalRoot,
          memoryDir: path.join(verifiedIdentity.canonicalRoot, ".ai"),
          workspaceId: verifiedIdentity.workspaceId,
          displayName: verifiedIdentity.displayName,
          rootFingerprint: verifiedIdentity.rootFingerprint,
          workspaceResolution: "binding",
          bindingId: binding.bindingId,
        },
      };
    }, regOpts);

    if (!locked.ok) {
      return locked;
    }
    return locked.data;
  }

  // Fallback to customRoot (unit tests) or MCP_WORKSPACE_ROOT environment variable
  const rawEnvRoot = params?.customRoot ?? process.env.MCP_WORKSPACE_ROOT;
  if (!rawEnvRoot || !rawEnvRoot.trim()) {
    return {
      ok: false,
      errorCode: "WORKSPACE_NOT_RESOLVED",
      message:
        "Không xác định được workspace: chưa cung cấp workspaceBindingId và MCP_WORKSPACE_ROOT chưa được cấu hình.",
    };
  }

  try {
    const identity = canonicalizeWorkspaceRoot(rawEnvRoot.trim());
    return {
      ok: true,
      data: {
        canonicalRoot: identity.canonicalRoot,
        memoryDir: path.join(identity.canonicalRoot, ".ai"),
        workspaceId: identity.workspaceId,
        displayName: identity.displayName,
        rootFingerprint: identity.rootFingerprint,
        workspaceResolution: "environment",
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      errorCode: "WORKSPACE_NOT_RESOLVED",
      message:
        err instanceof Error
          ? err.message
          : "Thư mục MCP_WORKSPACE_ROOT không tồn tại hoặc không hợp lệ.",
    };
  }
}

