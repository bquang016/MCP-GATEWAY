import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { registerWorkspaceFromHook, attachActiveWorkspace } from "../src/memory/project-memory.js";
import { createWorkspaceBackup, listWorkspaceBackups, restoreWorkspaceBackup, getAuditSummary } from "../src/operations/audit-backup.js";
import { startDashboard, readDashboardSummary, getDashboardHtml } from "../src/dashboard.js";

test("Phase 5 operations: backup/restore HITL, audit và local dashboard", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-ops-test-"));
  const workspace = path.join(root, "project"); const dataDir = path.join(root, "data"); fs.mkdirSync(workspace);
  const options = { dataDir, now: new Date("2026-11-12T07:00:00.000Z") };
  const oldDataDir = process.env.DAGW_DATA_DIR;
  try {
    registerWorkspaceFromHook({ conversationId: "ops", workspacePaths: [workspace], hookEventName: "SessionStart" }, options);
    const attached = attachActiveWorkspace({ initializeIfMissing: true }, options); assert.equal(attached.ok, true); if (!attached.ok) return;
    const bindingId = attached.data.bindingId;
    const contextPath = path.join(workspace, ".ai", "PROJECT_CONTEXT.md"); fs.writeFileSync(contextPath, "ORIGINAL\n", "utf-8");

    await t.test("backup cần xác nhận và restore ghi đè cần HITL", () => {
      const denied = createWorkspaceBackup({ workspaceBindingId: bindingId, userConfirmedLocalBackup: false }, options); assert.equal(denied.ok, false);
      const backup = createWorkspaceBackup({ workspaceBindingId: bindingId, userConfirmedLocalBackup: true }, options); assert.equal(backup.ok, true); if (!backup.ok) return;
      fs.writeFileSync(contextPath, "CHANGED\n", "utf-8");
      const restoreDenied = restoreWorkspaceBackup({ workspaceBindingId: bindingId, backupId: backup.data.backupId, userConfirmedOverwrite: false }, options); assert.equal(restoreDenied.ok, false);
      const restored = restoreWorkspaceBackup({ workspaceBindingId: bindingId, backupId: backup.data.backupId, userConfirmedOverwrite: true }, options); assert.equal(restored.ok, true);
      assert.equal(fs.readFileSync(contextPath, "utf-8"), "ORIGINAL\n");
      const listed = listWorkspaceBackups(bindingId, options); assert.equal(listed.ok, true); if (listed.ok) assert.equal(listed.data.backups.length, 1);
      const audit = getAuditSummary(bindingId, options); assert.equal(audit.ok, true); if (audit.ok) assert.equal(audit.data.totalEvents, 2);
    });

    await t.test("dashboard chỉ bind localhost và không lộ canonical path", async () => {
      process.env.DAGW_DATA_DIR = dataDir;
      const server = startDashboard(0); await once(server, "listening");
      try {
        const address = server.address(); assert.ok(address && typeof address === "object"); if (!address || typeof address !== "object") return;
        assert.equal(address.address, "127.0.0.1");
        const summary = readDashboardSummary(dataDir); const summaryText = JSON.stringify(summary); assert.equal(summary.service.bind, "127.0.0.1"); assert.equal(summary.workspaces.length, 1);
        assert.equal(summaryText.includes(workspace), false); assert.equal(summaryText.includes("canonicalRoot"), false);
        const dashboardHtml = getDashboardHtml();
        assert.match(dashboardHtml, /Token tiết kiệm/);
        assert.match(dashboardHtml, /Dual-Agent Workflow/);
        assert.match(dashboardHtml, /data-view="overview"/);
        assert.match(dashboardHtml, /data-view="projects"/);
        assert.match(dashboardHtml, /data-view="activity"/);
        assert.match(dashboardHtml, /data-theme="light"/);
        assert.match(dashboardHtml, /localStorage\.setItem\('dagw-theme'/);
        assert.match(dashboardHtml, /@media\(max-width:620px\)/);
        assert.match(dashboardHtml, /Không prompt, code hoặc secret/);
        assert.match(dashboardHtml, /setInterval\(load,15000\)/);
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    });
  } finally {
    if (oldDataDir === undefined) delete process.env.DAGW_DATA_DIR; else process.env.DAGW_DATA_DIR = oldDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
