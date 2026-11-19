import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  RegistryOptions,
  getRegistryDataDir,
  resolveToolWorkspace,
  withRegistryLock,
  readJsonFileOrDefault,
  writeJsonAtomic,
} from "../registry/workspace-registry.js";
import { MEMORY_FILES, MemoryFileName, resolveMemoryFilePath } from "../config.js";
import { writeMemoryFileAtomic } from "../memory/safe-write.js";
import type { WorkflowResult, WorkspaceMetadataFields } from "../memory/project-memory.js";

export interface AuditEvent {
  eventId: string;
  at: string;
  workspaceId: string | null;
  taskId: string | null;
  actor: "user" | "chatgpt" | "antigravity" | "gateway";
  action: string;
  outcome: "allowed" | "denied" | "completed" | "failed";
}

interface AuditFile { schemaVersion: "1.0"; events: AuditEvent[] }
const AUDIT_FILE = "audit.json";
const MAX_AUDIT_EVENTS = 10_000;

export function appendAuditEvent(event: Omit<AuditEvent, "eventId" | "at">, options?: RegistryOptions): void {
  withRegistryLock((dataDir) => {
    const file = readJsonFileOrDefault<AuditFile>(path.join(dataDir, AUDIT_FILE), { schemaVersion: "1.0", events: [] });
    file.events.push({ eventId: `audit_${crypto.randomBytes(12).toString("hex")}`, at: (options?.now ?? new Date()).toISOString(), ...event });
    if (file.events.length > MAX_AUDIT_EVENTS) file.events = file.events.slice(-MAX_AUDIT_EVENTS);
    writeJsonAtomic(dataDir, AUDIT_FILE, file);
  }, options);
}

function opError<T>(code: string, message: string, meta: WorkspaceMetadataFields): WorkflowResult<T> {
  return { ok: false, errorCode: code, message, ...meta };
}

function meta(ws: { workspaceId: string; displayName: string; rootFingerprint: string }): WorkspaceMetadataFields {
  return { workspaceId: ws.workspaceId, displayName: ws.displayName, rootFingerprint: ws.rootFingerprint, workspaceResolution: "binding" };
}

const memoryFileNames = Object.values(MEMORY_FILES) as MemoryFileName[];

export function createWorkspaceBackup(
  input: { workspaceBindingId: string; userConfirmedLocalBackup: boolean },
  options?: RegistryOptions
): WorkflowResult<{ backupId: string; files: string[]; createdAt: string } & WorkspaceMetadataFields> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return opError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data; const workspaceMeta = meta(ws);
  if (input.userConfirmedLocalBackup !== true) return opError("USER_CONFIRMATION_REQUIRED", "Cần người dùng xác nhận tạo backup local của Project Memory.", workspaceMeta);
  const now = options?.now ?? new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupId = `${timestamp}_${ws.workspaceId}`;
  const backupRoot = path.join(getRegistryDataDir(options?.dataDir), "backups", ws.workspaceId, backupId);
  fs.mkdirSync(backupRoot, { recursive: true });
  const copied: string[] = [];
  for (const fileName of memoryFileNames) {
    const source = resolveMemoryFilePath(ws.memoryDir, fileName);
    if (fs.existsSync(source) && fs.lstatSync(source).isFile()) {
      fs.copyFileSync(source, path.join(backupRoot, fileName)); copied.push(fileName);
    }
  }
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify({ schemaVersion: "1.0", backupId, workspaceId: ws.workspaceId, rootFingerprint: ws.rootFingerprint, createdAt: now.toISOString(), files: copied }, null, 2) + "\n", "utf-8");
  appendAuditEvent({ workspaceId: ws.workspaceId, taskId: null, actor: "user", action: "workspace_backup_created", outcome: "completed" }, options);
  return { ok: true, summaryText: `Đã tạo backup local '${backupId}' gồm ${copied.length} file.`, data: { backupId, files: copied, createdAt: now.toISOString(), ...workspaceMeta } };
}

export function listWorkspaceBackups(workspaceBindingId: string, options?: RegistryOptions): WorkflowResult<{ backups: Array<{ backupId: string; createdAt: string; files: string[] }> } & WorkspaceMetadataFields> {
  const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return opError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data; const root = path.join(getRegistryDataDir(options?.dataDir), "backups", ws.workspaceId);
  const backups: Array<{ backupId: string; createdAt: string; files: string[] }> = [];
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(entry.name)) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    try { const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); if (manifest.workspaceId === ws.workspaceId) backups.push({ backupId: entry.name, createdAt: manifest.createdAt, files: manifest.files }); } catch { /* ignore corrupt backup */ }
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, summaryText: `Có ${backups.length} backup local cho '${ws.displayName}'.`, data: { backups, ...meta(ws) } };
}

export function restoreWorkspaceBackup(
  input: { workspaceBindingId: string; backupId: string; userConfirmedOverwrite: boolean },
  options?: RegistryOptions
): WorkflowResult<{ restored: true; backupId: string; files: string[] } & WorkspaceMetadataFields> {
  const resolved = resolveToolWorkspace({ workspaceBindingId: input.workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return opError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data; const workspaceMeta = meta(ws);
  if (input.userConfirmedOverwrite !== true) return opError("USER_CONFIRMATION_REQUIRED", "Restore sẽ ghi đè Project Memory hiện tại; cần xác nhận rõ ràng.", workspaceMeta);
  if (!/^[A-Za-z0-9_.-]+$/.test(input.backupId)) return opError("INVALID_BACKUP_ID", "backupId không hợp lệ.", workspaceMeta);
  const backupRoot = path.join(getRegistryDataDir(options?.dataDir), "backups", ws.workspaceId, input.backupId);
  const manifestPath = path.join(backupRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return opError("BACKUP_NOT_FOUND", "Không tìm thấy backup.", workspaceMeta);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  if (manifest.workspaceId !== ws.workspaceId || manifest.rootFingerprint !== ws.rootFingerprint) return opError("BACKUP_WORKSPACE_MISMATCH", "Backup không thuộc workspace hiện tại.", workspaceMeta);
  const restored: string[] = [];
  for (const fileName of memoryFileNames) {
    if (!manifest.files.includes(fileName)) continue;
    const source = path.join(backupRoot, fileName);
    if (fs.existsSync(source)) { writeMemoryFileAtomic(ws.memoryDir, fileName, fs.readFileSync(source, "utf-8")); restored.push(fileName); }
  }
  appendAuditEvent({ workspaceId: ws.workspaceId, taskId: null, actor: "user", action: "workspace_backup_restored", outcome: "completed" }, options);
  return { ok: true, summaryText: `Đã restore backup '${input.backupId}' sau xác nhận HITL.`, data: { restored: true, backupId: input.backupId, files: restored, ...workspaceMeta } };
}

export function getAuditSummary(workspaceBindingId: string, options?: RegistryOptions): WorkflowResult<{ totalEvents: number; byAction: Record<string, number>; recent: AuditEvent[] } & WorkspaceMetadataFields> {
  const resolved = resolveToolWorkspace({ workspaceBindingId, registryOptions: options });
  if (!resolved.ok) return opError(resolved.errorCode, resolved.message, { workspaceId: null, displayName: null, rootFingerprint: null, workspaceResolution: "binding" });
  const ws = resolved.data;
  const file = readJsonFileOrDefault<AuditFile>(path.join(getRegistryDataDir(options?.dataDir), AUDIT_FILE), { schemaVersion: "1.0", events: [] });
  const events = file.events.filter((event) => event.workspaceId === ws.workspaceId);
  const byAction: Record<string, number> = {}; for (const event of events) byAction[event.action] = (byAction[event.action] ?? 0) + 1;
  return { ok: true, summaryText: `Có ${events.length} audit event cho '${ws.displayName}'.`, data: { totalEvents: events.length, byAction, recent: events.slice(-50).reverse(), ...meta(ws) } };
}
