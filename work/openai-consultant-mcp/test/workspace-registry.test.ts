import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  MEMORY_FILES,
} from "../src/config.js";
import {
  registerWorkspaceFromHook,
  listRegisteredWorkspaces,
  getWorkspaceBindingInfo,
  detachWorkspaceBinding,
  canonicalizeWorkspaceRoot,
  withRegistryLock,
  attachActiveWorkspace,
  resolveProjectMemoryStatus,
  initializeProjectMemory,
  saveApprovedPlan,
  checkpointTask,
  resumeTask,
  prepareHandoff,
  archiveCompletedTask,
} from "../src/memory/project-memory.js";
import { executeRegisterWorkspaceFromStdin } from "../src/cli.js";

test("Phase 1: Dynamic Workspace Registry, Bindings, CLI & Plugin Artifact Tests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-phase1-test-"));
  const registryDir = path.join(tempRoot, "registry-data");
  const wsAlpha = path.join(tempRoot, "project-alpha");
  const wsBeta = path.join(tempRoot, "project-beta");
  const wsEnvFallback = path.join(tempRoot, "project-env-fallback");

  fs.mkdirSync(wsAlpha, { recursive: true });
  fs.mkdirSync(wsBeta, { recursive: true });
  fs.mkdirSync(wsEnvFallback, { recursive: true });

  const originalEnvRoot = process.env.MCP_WORKSPACE_ROOT;
  const originalDataDir = process.env.DAGW_DATA_DIR;
  process.env.DAGW_DATA_DIR = registryDir;

  try {
    await t.test("1. Register workspace từ workspacePaths[0] (ưu tiên hơn cwd) và không tạo .ai", () => {
      const now = new Date("2026-11-10T10:00:00.000Z");
      const res = registerWorkspaceFromHook(
        {
          conversationId: "conv-alpha-1",
          workspacePaths: [wsAlpha, wsBeta],
          cwd: wsBeta,
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );

      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.data.displayName, "project-alpha");
        assert.ok(res.data.workspaceId.startsWith("ws_"));
        assert.ok(res.data.rootFingerprint.startsWith("fp_"));
        assert.equal(res.data.status, "active");
        assert.equal(res.data.isActive, true);
        assert.equal(res.data.lastSeenAt, "2026-11-10T10:00:00.000Z");
        assert.equal(res.data.leaseExpiresAt, "2026-11-10T18:00:00.000Z");
        assert.equal("canonicalRoot" in res.data, false);
      }

      // Hook registration must NOT create or modify .ai
      assert.equal(fs.existsSync(path.join(wsAlpha, ".ai")), false);
    });

    await t.test("2. Fallback sang cwd khi workspacePaths rỗng", () => {
      const now = new Date("2026-11-10T10:05:00.000Z");
      const res = registerWorkspaceFromHook(
        {
          conversationId: "conv-beta-1",
          workspacePaths: [],
          cwd: wsBeta,
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );

      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.data.displayName, "project-beta");
        assert.equal(res.data.isActive, true);
      }
    });

    await t.test("3. Chặn path không tồn tại, file thường, hoặc payload thiếu cả workspacePaths và cwd (không dùng process.cwd())", () => {
      const nonExistent = path.join(tempRoot, "does-not-exist-dir");
      const badRes1 = registerWorkspaceFromHook(
        {
          conversationId: "conv-bad-1",
          workspacePaths: [nonExistent],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir }
      );
      assert.equal(badRes1.ok, false);
      if (!badRes1.ok) {
        assert.equal(badRes1.errorCode, "INVALID_HOOK_PAYLOAD");
      }

      const regularFile = path.join(tempRoot, "not-a-dir.txt");
      fs.writeFileSync(regularFile, "hello", "utf-8");
      const badRes2 = registerWorkspaceFromHook(
        {
          conversationId: "conv-bad-2",
          workspacePaths: [regularFile],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir }
      );
      assert.equal(badRes2.ok, false);
      if (!badRes2.ok) {
        assert.equal(badRes2.errorCode, "INVALID_HOOK_PAYLOAD");
      }

      // Empty workspacePaths and missing cwd must NOT fallback to process.cwd()
      const badRes3 = registerWorkspaceFromHook(
        {
          conversationId: "conv-bad-3",
          workspacePaths: [],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir }
      );
      assert.equal(badRes3.ok, false);
      if (!badRes3.ok) {
        assert.equal(badRes3.errorCode, "INVALID_HOOK_PAYLOAD");
      }
    });

    await t.test("4 & 5. Workspace ID ổn định và Windows case-insensitive normalization", () => {
      const id1 = canonicalizeWorkspaceRoot(wsAlpha);
      const id2 = canonicalizeWorkspaceRoot(`${wsAlpha}${path.sep}`);
      assert.equal(id1.workspaceId, id2.workspaceId);
      assert.equal(id1.rootFingerprint, id2.rootFingerprint);

      if (process.platform === "win32") {
        const upperVariant = wsAlpha.toUpperCase();
        const lowerVariant = wsAlpha.toLowerCase();
        const idUpper = canonicalizeWorkspaceRoot(upperVariant);
        const idLower = canonicalizeWorkspaceRoot(lowerVariant);
        assert.equal(idUpper.workspaceId, idLower.workspaceId);
        assert.equal(idUpper.rootFingerprint, idLower.rootFingerprint);
      }
    });

    await t.test("6 & 7. Active workspace là workspace đăng ký gần nhất và PreInvocation refresh lease", () => {
      const t1 = new Date("2026-11-10T11:00:00.000Z");
      const regAlpha = registerWorkspaceFromHook(
        {
          conversationId: "conv-alpha-2",
          workspacePaths: [wsAlpha],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now: t1 }
      );
      assert.equal(regAlpha.ok, true);

      const list1 = listRegisteredWorkspaces({ dataDir: registryDir, now: t1 });
      assert.equal(list1.ok, true);
      if (list1.ok && regAlpha.ok) {
        assert.equal(list1.data.activeWorkspaceId, regAlpha.data.workspaceId);
        const activeEntry = list1.data.workspaces.find((w) => w.isActive);
        assert.equal(activeEntry?.displayName, "project-alpha");
        assert.equal(activeEntry?.leaseExpiresAt, "2026-11-10T19:00:00.000Z");
      }

      // PreInvocation refreshes lease by 8 hours from t2
      const t2 = new Date("2026-11-10T14:30:00.000Z");
      const refreshAlpha = registerWorkspaceFromHook(
        {
          conversationId: "conv-alpha-2",
          workspacePaths: [wsAlpha],
          hookEventName: "PreInvocation",
        },
        { dataDir: registryDir, now: t2 }
      );
      assert.equal(refreshAlpha.ok, true);
      if (refreshAlpha.ok) {
        assert.equal(refreshAlpha.data.lastSeenAt, "2026-11-10T14:30:00.000Z");
        assert.equal(refreshAlpha.data.leaseExpiresAt, "2026-11-10T22:30:00.000Z");
      }
    });

    await t.test("8. Expired workspace không attach được (NO_ACTIVE_WORKSPACE)", () => {
      // At 2026-11-11T00:00:00.000Z (after 22:30 lease expiry), attach must fail with NO_ACTIVE_WORKSPACE
      const afterLeaseExpiry = new Date("2026-11-11T00:00:00.000Z");
      const attachExpired = attachActiveWorkspace(
        { initializeIfMissing: false },
        { dataDir: registryDir, now: afterLeaseExpiry }
      );
      assert.equal(attachExpired.ok, false);
      if (!attachExpired.ok) {
        assert.equal(attachExpired.errorCode, "NO_ACTIVE_WORKSPACE");
      }
    });

    let bindingAlphaId = "";
    let alphaWorkspaceId = "";

    await t.test("9 & 12. attach_active_workspace tạo binding và initializeIfMissing tạo .ai nhưng không ghi đè file hiện có", () => {
      const now = new Date("2026-11-10T15:00:00.000Z");
      // Re-register wsAlpha with fresh lease
      const regRes = registerWorkspaceFromHook(
        {
          conversationId: "conv-alpha-3",
          workspacePaths: [wsAlpha],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );
      assert.equal(regRes.ok, true);

      // Pre-populate custom PROJECT_CONTEXT.md in wsAlpha/.ai to verify initializeIfMissing does not overwrite it
      const alphaAiDir = path.join(wsAlpha, ".ai");
      fs.mkdirSync(alphaAiDir, { recursive: true });
      const customContext = "# Alpha Project Context\nDo not overwrite me!";
      fs.writeFileSync(
        path.join(alphaAiDir, MEMORY_FILES.PROJECT_CONTEXT),
        customContext,
        "utf-8"
      );

      const attachRes = attachActiveWorkspace(
        { initializeIfMissing: true },
        { dataDir: registryDir, now }
      );
      assert.equal(attachRes.ok, true);
      if (attachRes.ok) {
        bindingAlphaId = attachRes.data.bindingId;
        alphaWorkspaceId = attachRes.data.workspaceId;
        assert.ok(bindingAlphaId.startsWith("bind_"));
        assert.equal(attachRes.data.displayName, "project-alpha");
        assert.equal(attachRes.data.projectMemoryInitialized, true);
        assert.equal(attachRes.data.created.length, 4);
        assert.deepEqual(attachRes.data.alreadyExisted, [MEMORY_FILES.PROJECT_CONTEXT]);
        assert.equal("canonicalRoot" in attachRes.data, false);
      }

      // Verify custom PROJECT_CONTEXT.md was preserved
      assert.equal(
        fs.readFileSync(path.join(alphaAiDir, MEMORY_FILES.PROJECT_CONTEXT), "utf-8"),
        customContext
      );
    });

    await t.test("10 & 13. Binding không tự chuyển khi active workspace đổi; tool dùng binding đọc/ghi đúng Project Memory của workspace cũ", () => {
      const now = new Date("2026-11-10T15:10:00.000Z");
      // Switch active workspace in Antigravity to wsBeta
      const regBeta = registerWorkspaceFromHook(
        {
          conversationId: "conv-beta-2",
          workspacePaths: [wsBeta],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );
      assert.equal(regBeta.ok, true);

      // Initialize wsBeta separately so both workspaces have .ai
      initializeProjectMemory(wsBeta);

      // Save approved plan using bindingAlphaId -> MUST write to wsAlpha, NOT wsBeta!
      const saveRes = saveApprovedPlan(
        {
          taskId: "ALPHA-TASK-01",
          objective: "Implement feature in project-alpha while beta is active",
          planSteps: ["Step A1", "Step A2"],
          acceptanceCriteria: ["Alpha tests pass"],
          constraints: ["Stay pinned to project-alpha"],
          approvedByUser: true,
          workspaceBindingId: bindingAlphaId,
        },
        undefined,
        { registryOptions: { dataDir: registryDir, now } }
      );
      assert.equal(saveRes.ok, true);
      if (saveRes.ok) {
        assert.equal(saveRes.data.workspaceId, alphaWorkspaceId);
        assert.equal(saveRes.data.displayName, "project-alpha");
        assert.equal(saveRes.data.workspaceResolution, "binding");
      }

      // Checkpoint task on bindingAlphaId
      const cpRes = checkpointTask(
        {
          taskId: "ALPHA-TASK-01",
          expectedRevision: 0,
          status: "completed",
          objective: "Implement feature in project-alpha while beta is active",
          acceptanceCriteria: ["Alpha tests pass"],
          completed: ["Step A1", "Step A2"],
          currentState: "Completed in project-alpha",
          nextSteps: [],
          changedFiles: ["src/alpha.ts"],
          tests: [{ command: "npm test", status: "passed", result: "OK" }],
          blockers: [],
          openQuestions: [],
          workspaceBindingId: bindingAlphaId,
        },
        undefined,
        { registryOptions: { dataDir: registryDir, now } }
      );
      assert.equal(cpRes.ok, true);
      if (cpRes.ok) {
        assert.equal(cpRes.data.revision, 1);
        assert.equal(cpRes.data.displayName, "project-alpha");
        assert.equal(cpRes.data.workspaceResolution, "binding");
      }

      // Resume task via bindingAlphaId -> must read ALPHA-TASK-01
      const resumeAlpha = resumeTask(undefined, {
        workspaceBindingId: bindingAlphaId,
        registryOptions: { dataDir: registryDir, now },
      });
      assert.equal(resumeAlpha.ok, true);
      if (resumeAlpha.ok) {
        assert.equal(resumeAlpha.data.taskId, "ALPHA-TASK-01");
        assert.equal(resumeAlpha.data.displayName, "project-alpha");
        assert.equal(resumeAlpha.data.workspaceResolution, "binding");
      }

      // Meanwhile wsBeta must remain untouched (no active task)
      const betaStatus = resolveProjectMemoryStatus(undefined, wsBeta);
      assert.equal(betaStatus.ok, true);
      if (betaStatus.ok) {
        assert.equal(betaStatus.data.activeTask, false);
        assert.equal(betaStatus.data.displayName, "project-beta");
      }
    });

    await t.test("11. Expired binding bị từ chối (BINDING_EXPIRED)", () => {
      // bindingAlphaId was created at 15:00 with 8h TTL -> expires at 23:00
      const afterBindingExpiry = new Date("2026-11-10T23:30:00.000Z");
      const getBindRes = getWorkspaceBindingInfo(bindingAlphaId, {
        dataDir: registryDir,
        now: afterBindingExpiry,
      });
      assert.equal(getBindRes.ok, false);
      if (!getBindRes.ok) {
        assert.equal(getBindRes.errorCode, "BINDING_EXPIRED");
      }

      const resumeExpired = resumeTask(undefined, {
        workspaceBindingId: bindingAlphaId,
        registryOptions: { dataDir: registryDir, now: afterBindingExpiry },
      });
      assert.equal(resumeExpired.ok, false);
      if (!resumeExpired.ok) {
        assert.equal(resumeExpired.errorCode, "BINDING_EXPIRED");
      }
    });

    await t.test("14 & 15. Environment fallback hoạt động khi không truyền binding; nhưng khi truyền binding lỗi thì KHÔNG fallback sang environment", () => {
      process.env.MCP_WORKSPACE_ROOT = wsEnvFallback;
      initializeProjectMemory();

      const envStatus = resolveProjectMemoryStatus();
      assert.equal(envStatus.ok, true);
      if (envStatus.ok) {
        assert.equal(envStatus.data.displayName, "project-env-fallback");
        assert.equal(envStatus.data.workspaceResolution, "environment");
      }

      // Passing an invalid bindingId while MCP_WORKSPACE_ROOT is valid MUST fail with BINDING_NOT_FOUND (no fallback!)
      const badBindingStatus = resolveProjectMemoryStatus({
        workspaceBindingId: "bind_non_existent_12345",
        registryOptions: { dataDir: registryDir },
      });
      assert.equal(badBindingStatus.ok, false);
      if (!badBindingStatus.ok) {
        assert.equal(badBindingStatus.errorCode, "BINDING_NOT_FOUND");
        assert.equal(badBindingStatus.workspaceResolution, "binding");
      }

      const badBindingSave = saveApprovedPlan(
        {
          taskId: "SHOULD-NOT-SAVE",
          objective: "Should fail because binding is invalid",
          planSteps: ["Step 1"],
          acceptanceCriteria: ["Crit 1"],
          constraints: [],
          approvedByUser: true,
          workspaceBindingId: "bind_non_existent_12345",
        },
        undefined,
        { registryOptions: { dataDir: registryDir } }
      );
      assert.equal(badBindingSave.ok, false);
      if (!badBindingSave.ok) {
        assert.equal(badBindingSave.errorCode, "BINDING_NOT_FOUND");
      }

      // Verify wsEnvFallback still has no approved plan
      const envStatusAfter = resolveProjectMemoryStatus();
      assert.equal(envStatusAfter.ok, true);
      if (envStatusAfter.ok) {
        assert.equal(envStatusAfter.data.activeTask, false);
      }

      // If neither workspaceBindingId nor MCP_WORKSPACE_ROOT is provided -> WORKSPACE_NOT_RESOLVED
      delete process.env.MCP_WORKSPACE_ROOT;
      const unresolvedRes = resolveProjectMemoryStatus();
      assert.equal(unresolvedRes.ok, false);
      if (!unresolvedRes.ok) {
        assert.equal(unresolvedRes.errorCode, "WORKSPACE_NOT_RESOLVED");
      }
    });

    await t.test("Workspace mismatch protection: phát hiện khi APPROVED_PLAN.md thuộc về workspace khác", () => {
      const now = new Date("2026-11-10T16:00:00.000Z");
      // Register and attach to wsBeta
      registerWorkspaceFromHook(
        {
          conversationId: "conv-beta-3",
          workspacePaths: [wsBeta],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );
      const attachBeta = attachActiveWorkspace(
        { initializeIfMissing: true },
        { dataDir: registryDir, now }
      );
      assert.equal(attachBeta.ok, true);
      if (!attachBeta.ok) return;

      // Copy APPROVED_PLAN.md from wsAlpha (which has Workspace ID of wsAlpha) into wsBeta/.ai
      fs.copyFileSync(
        path.join(wsAlpha, ".ai", MEMORY_FILES.APPROVED_PLAN),
        path.join(wsBeta, ".ai", MEMORY_FILES.APPROVED_PLAN)
      );

      // Attempting to checkpoint on wsBeta must fail with WORKSPACE_MISMATCH
      const mismatchCp = checkpointTask(
        {
          taskId: "ALPHA-TASK-01",
          expectedRevision: 0,
          status: "in_progress",
          objective: "Cross-workspace tamper attempt",
          acceptanceCriteria: ["Blocked"],
          completed: [],
          currentState: "Blocked",
          nextSteps: [],
          changedFiles: ["src/index.ts"],
          tests: [],
          blockers: [],
          openQuestions: [],
          workspaceBindingId: attachBeta.data.bindingId,
        },
        undefined,
        { registryOptions: { dataDir: registryDir, now } }
      );
      assert.equal(mismatchCp.ok, false);
      if (!mismatchCp.ok) {
        assert.equal(mismatchCp.errorCode, "WORKSPACE_MISMATCH");
      }
    });

    await t.test("16. Không trả canonicalRoot trong bất kỳ kết quả tool nào", () => {
      const now = new Date("2026-11-10T16:05:00.000Z");
      registerWorkspaceFromHook(
        {
          conversationId: "conv-alpha-4",
          workspacePaths: [wsAlpha],
          hookEventName: "SessionStart",
        },
        { dataDir: registryDir, now }
      );

      const listRes = listRegisteredWorkspaces({ dataDir: registryDir, now });
      const attachRes = attachActiveWorkspace(
        { initializeIfMissing: false },
        { dataDir: registryDir, now }
      );
      assert.equal(attachRes.ok, true);
      if (!attachRes.ok) return;

      const bindInfoRes = getWorkspaceBindingInfo(attachRes.data.bindingId, {
        dataDir: registryDir,
        now,
      });
      const statusRes = resolveProjectMemoryStatus({
        workspaceBindingId: attachRes.data.bindingId,
        registryOptions: { dataDir: registryDir, now },
      });
      const handoffRes = prepareHandoff(
        {
          expectedRevision: 1,
          reason: "manual",
          nextExactAction: "Ready to archive ALPHA-TASK-01",
          doNotRedo: ["Step A1"],
          workspaceBindingId: attachRes.data.bindingId,
        },
        undefined,
        { registryOptions: { dataDir: registryDir, now } }
      );
      const archiveRes = archiveCompletedTask(
        {
          taskId: "ALPHA-TASK-01",
          expectedRevision: 1,
          userConfirmed: true,
          completionSummary: "Archived via workspaceBindingId",
          workspaceBindingId: attachRes.data.bindingId,
        },
        undefined,
        { registryOptions: { dataDir: registryDir, now }, now }
      );
      const detachRes = detachWorkspaceBinding(attachRes.data.bindingId, {
        dataDir: registryDir,
        now,
      });

      const combinedSerialized = JSON.stringify({
        listRes,
        attachRes,
        bindInfoRes,
        statusRes,
        handoffRes,
        archiveRes,
        detachRes,
      });

      assert.equal(combinedSerialized.includes("canonicalRoot"), false);
      assert.equal(combinedSerialized.includes(wsAlpha), false);
    });

    await t.test("17, 18, 19, 20. Inter-process lock: concurrent writes, stale lock recovery, lock timeout, và temp/lock cleanup", async () => {
      const lockDir = path.join(registryDir, "locks");
      const lockFilePath = path.join(lockDir, "registry.lock");
      fs.mkdirSync(lockDir, { recursive: true });

      // 18. Stale lock recovery: create a lock with createdAt 60 seconds in the past
      fs.writeFileSync(
        lockFilePath,
        JSON.stringify({ pid: 999999, createdAt: Date.now() - 60_000, token: "stale" }),
        "utf-8"
      );

      const recovered = withRegistryLock(
        () => "recovered-ok",
        { dataDir: registryDir, staleLockMs: 1_000, lockTimeoutMs: 1_000 }
      );
      assert.equal(recovered.ok, true);
      if (recovered.ok) {
        assert.equal(recovered.data, "recovered-ok");
      }
      assert.equal(fs.existsSync(lockFilePath), false, "Lock file must be cleaned up");

      // 19. Lock timeout: create a fresh active lock and verify REGISTRY_LOCK_TIMEOUT
      fs.writeFileSync(
        lockFilePath,
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "fresh" }),
        "utf-8"
      );
      try {
        const timedOut = withRegistryLock(
          () => "should-not-run",
          { dataDir: registryDir, staleLockMs: 60_000, lockTimeoutMs: 120 }
        );
        assert.equal(timedOut.ok, false);
        if (!timedOut.ok) {
          assert.equal(timedOut.errorCode, "REGISTRY_LOCK_TIMEOUT");
        }
      } finally {
        if (fs.existsSync(lockFilePath)) {
          fs.unlinkSync(lockFilePath);
        }
      }

      // 17. Concurrent writes do not corrupt JSON
      const concurrentDirs = Array.from({ length: 6 }, (_, i) => {
        const d = path.join(tempRoot, `concurrent-ws-${i}`);
        fs.mkdirSync(d, { recursive: true });
        return d;
      });

      await Promise.all(
        concurrentDirs.map((dir, idx) =>
          Promise.resolve().then(() =>
            registerWorkspaceFromHook(
              {
                conversationId: `conv-conc-${idx}`,
                workspacePaths: [dir],
                hookEventName: "PreInvocation",
              },
              { dataDir: registryDir }
            )
          )
        )
      );

      const registryRaw = fs.readFileSync(path.join(registryDir, "registry.json"), "utf-8");
      const parsedRegistry = JSON.parse(registryRaw);
      assert.equal(parsedRegistry.schemaVersion, "1.0");
      assert.ok(Object.keys(parsedRegistry.workspaces).length >= 8);

      // 20. Verify no .tmp files or lock files remain
      const remainingTmp = fs
        .readdirSync(registryDir)
        .filter((name) => name.startsWith(".tmp-") || name.endsWith(".tmp"));
      assert.deepEqual(remainingTmp, []);
      assert.deepEqual(fs.readdirSync(lockDir), []);
    });

    await t.test("21. CLI stdout luôn là JSON hợp lệ ({}) và log chẩn đoán chỉ ghi ra stderr", () => {
      // Valid payload
      const okExec = executeRegisterWorkspaceFromStdin(
        JSON.stringify({
          conversationId: "cli-conv-1",
          workspacePaths: [wsAlpha],
          cwd: wsAlpha,
          hookEventName: "SessionStart",
        }),
        { dataDir: registryDir }
      );
      const okHookOutput = JSON.parse(okExec.stdoutJson);
      assert.deepEqual(okHookOutput, {}, "Normal mode không inject workflow khi queue rỗng");
      assert.match(okExec.stderrMessage, /Registered normal workspace/);
      assert.equal(okExec.result.ok, true);

      if (!okExec.result.ok) throw new Error("workspace registration failed");
      const workspaceId = okExec.result.data.workspaceId;
      fs.writeFileSync(
        path.join(registryDir, "execution-queue.json"),
        JSON.stringify({
          schemaVersion: "1.0",
          requests: {
            exec_test: {
              requestId: "exec_test", workspaceId, displayName: "alpha", rootFingerprint: "fp_test",
              taskId: "queued-task", objective: "Queued objective", status: "pending_user_start", revision: 0,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userApprovedPlanHandoff: true,
              userApprovedExecutionAt: null, executorId: null, executionLeaseExpiresAt: null,
              progressSummary: "waiting", blocker: null,
            },
          },
        }),
        "utf-8"
      );
      const queuedExec = executeRegisterWorkspaceFromStdin(
        JSON.stringify({ conversationId: "cli-conv-queue", workspacePaths: [wsAlpha], hookEventName: "SessionStart" }),
        { dataDir: registryDir }
      );
      const queuedOutput = JSON.parse(queuedExec.stdoutJson);
      assert.ok(Array.isArray(queuedOutput.injectSteps));
      assert.match(queuedOutput.injectSteps[0].systemMessage.systemMessage, /Dual-Agent Mode/);
      assert.match(queuedOutput.injectSteps[0].systemMessage.systemMessage, /queued-task/);

      fs.unlinkSync(path.join(registryDir, "execution-queue.json"));

      // Malformed JSON payload -> still returns valid JSON `{}` on stdout and does not throw
      const badJsonExec = executeRegisterWorkspaceFromStdin("{not-valid-json", {
        dataDir: registryDir,
      });
      assert.deepEqual(JSON.parse(badJsonExec.stdoutJson), {});
      assert.match(badJsonExec.stderrMessage, /INVALID_HOOK_PAYLOAD/);
      assert.equal(badJsonExec.result.ok, false);

      // Empty stdin -> still returns valid JSON `{}` on stdout
      const emptyExec = executeRegisterWorkspaceFromStdin("", {
        dataDir: registryDir,
      });
      assert.deepEqual(JSON.parse(emptyExec.stdoutJson), {});
      assert.match(emptyExec.stderrMessage, /INVALID_HOOK_PAYLOAD/);

      // End-to-end spawn of `node dist/cli.js register-workspace`
      const cliJsPath = path.resolve("dist/cli.js");
      if (fs.existsSync(cliJsPath)) {
        const spawned = spawnSync(
          process.execPath,
          [cliJsPath, "register-workspace"],
          {
            input: JSON.stringify({
              conversationId: "spawn-cli-conv",
              workspacePaths: [wsAlpha],
              hookEventName: "PreInvocation",
            }),
            encoding: "utf-8",
            env: {
              ...process.env,
              DAGW_DATA_DIR: registryDir,
            },
          }
        );
        assert.equal(spawned.status, 0);
        const spawnedOutput = JSON.parse(spawned.stdout.trim());
        assert.deepEqual(spawnedOutput, {});
        assert.match(spawned.stderr, /Registered normal workspace/);
      }
    });

    await t.test("22. Plugin hook artifact có schema hợp lệ, không hard-code đường dẫn máy, và chạy được qua session-start.js", () => {
      const pluginDir = path.resolve("integrations/antigravity/dual-agent-bridge");
      const pluginJsonPath = path.join(pluginDir, "plugin.json");
      const hooksJsonPath = path.join(pluginDir, "hooks.json");
      const readmePath = path.join(pluginDir, "README.md");
      const sessionStartScriptPath = path.join(pluginDir, "scripts", "session-start.js");
      const installScriptPath = path.join(pluginDir, "scripts", "install-plugin.js");
      const safetyGateScriptPath = path.join(pluginDir, "scripts", "safety-gate.js");
      const rulesPath = path.join(pluginDir, "rules", "AGENTS.md");

      assert.ok(fs.existsSync(pluginJsonPath), "plugin.json phải tồn tại");
      assert.ok(fs.existsSync(hooksJsonPath), "hooks.json phải tồn tại");
      assert.ok(fs.existsSync(readmePath), "README.md phải tồn tại");
      assert.ok(fs.existsSync(sessionStartScriptPath), "scripts/session-start.js phải tồn tại");
      assert.ok(fs.existsSync(installScriptPath), "scripts/install-plugin.js phải tồn tại");
      assert.ok(fs.existsSync(safetyGateScriptPath), "scripts/safety-gate.js phải tồn tại");
      assert.ok(fs.existsSync(rulesPath), "rules/AGENTS.md phải tồn tại");

      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));
      const allowedPluginKeys = new Set([
        "name",
        "displayName",
        "version",
        "description",
        "logo",
        "suggestedPrompts",
        "author",
        "homepage",
        "repository",
        "disabled",
      ]);
      for (const key of Object.keys(pluginJson)) {
        assert.ok(allowedPluginKeys.has(key), `Key không hợp lệ trong plugin.json: ${key}`);
      }
      assert.equal(pluginJson.name, "dual-agent-bridge");

      const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      // Schema native Antigravity: top-level khong duoc co description hoac hooks
      assert.equal("description" in hooksJson, false, "hooks.json khong duoc co top-level description");
      assert.equal("hooks" in hooksJson, false, "hooks.json khong duoc co top-level hooks wrapper");

      // Top-level key phai la hook spec (vi du dual-agent-bridge-hook)
      const hookNames = Object.keys(hooksJson);
      assert.ok(hookNames.length > 0, "hooks.json phai chua it nhat mot hook spec");
      assert.ok("dual-agent-bridge-hook" in hooksJson, "hooks.json phai chua hook spec dual-agent-bridge-hook");
      const hookSpec = hooksJson["dual-agent-bridge-hook"];
      assert.ok(typeof hookSpec === "object" && hookSpec !== null && !Array.isArray(hookSpec));

      // Phase 5.1.2: SessionStart đăng ký đầy đủ; PreInvocation chỉ heartbeat có debounce.
      assert.ok(Array.isArray(hookSpec.SessionStart), "SessionStart phai la flat array");
      assert.ok(hookSpec.SessionStart.length > 0, "SessionStart khong duoc rong");
      for (const handler of hookSpec.SessionStart) {
        assert.equal(handler.type, "command");
        assert.ok(typeof handler.command === "string");
        assert.equal("hooks" in handler, false, "SessionStart khong duoc boc trong matcher/hooks");
        assert.equal("matcher" in handler, false, "SessionStart khong duoc co matcher");
      }

      assert.ok(Array.isArray(hookSpec.PreInvocation), "PreInvocation phai la flat array");
      assert.equal(hookSpec.PreInvocation.length, 1);
      for (const handler of hookSpec.PreInvocation) {
        assert.equal(handler.type, "command");
        assert.match(handler.command, /session-start\.js/);
        assert.ok(handler.timeout <= 4);
        assert.equal("hooks" in handler, false);
        assert.equal("matcher" in handler, false);
      }

      assert.equal("Stop" in hookSpec, false);
      assert.equal("PostInvocation" in hookSpec, false);

      assert.equal("PreToolUse" in hookSpec, false);

      // Verify no hard-coded machine paths (e.g. C:\Users\buida) exist in plugin artifact files
      for (const filePath of [
        pluginJsonPath,
        hooksJsonPath,
        readmePath,
        sessionStartScriptPath,
        installScriptPath,
        safetyGateScriptPath,
        rulesPath,
      ]) {
        const raw = fs.readFileSync(filePath, "utf-8");
        assert.doesNotMatch(raw, /C:\\Users\\|\/Users\/buida/i);
      }

      const rulesText = fs.readFileSync(rulesPath, "utf-8");
      assert.match(rulesText, /start_work_session/);
      assert.match(rulesText, /checkpoint_task/);
      assert.match(rulesText, /archive_completed_task/);
      assert.match(rulesText, /terminal\/sandbox native/i);
      assert.match(rulesText, /Normal mode \(default\)/);
      assert.match(rulesText, /không gọi `start_work_session`/i);
      assert.match(rulesText, /Ngoại lệ riêng tư cho Project Memory/i);
      assert.match(rulesText, /không nêu tên thư mục, đường dẫn, tên file/i);
      assert.match(rulesText, /không stage, commit, push/i);
      assert.match(rulesText, /git add -A/);

      const destructiveGate = spawnSync(process.execPath, [safetyGateScriptPath], {
        input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "Remove-Item C:\\\\data -Recurse -Force" } } }),
        encoding: "utf-8",
      });
      assert.equal(destructiveGate.status, 0);
      assert.equal(JSON.parse(destructiveGate.stdout).decision, "force_ask");

      const safeGate = spawnSync(process.execPath, [safetyGateScriptPath], {
        input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "npm test" } } }),
        encoding: "utf-8",
      });
      assert.equal(safeGate.status, 0);
      assert.equal(JSON.parse(safeGate.stdout).decision, "ask");

      // Verify session-start.js executes cleanly when invoked from pluginDir
      const cliJsPath = path.resolve("dist/cli.js");
      if (fs.existsSync(cliJsPath)) {
        const hookRun = spawnSync(
          process.execPath,
          [sessionStartScriptPath],
          {
            cwd: pluginDir,
            input: JSON.stringify({
              conversationId: "plugin-hook-conv",
              workspacePaths: [wsAlpha],
              hookEventName: "SessionStart",
            }),
            encoding: "utf-8",
            env: {
              ...process.env,
              DAGW_DATA_DIR: registryDir,
            },
          }
        );
        assert.equal(hookRun.status, 0);
        const hookOutput = JSON.parse(hookRun.stdout.trim());
        assert.deepEqual(hookOutput, {});

        const heartbeatRegistryDir = path.join(tempRoot, "heartbeat-registry");
        const heartbeatPayload = JSON.stringify({
          conversationId: "plugin-heartbeat-conv",
          workspacePaths: [wsBeta],
          hookEventName: "PreInvocation",
        });
        const heartbeatEnv = {
          ...process.env,
          DAGW_DATA_DIR: heartbeatRegistryDir,
          DAGW_HEARTBEAT_DEBOUNCE_MS: "300000",
        };

        const firstHeartbeat = spawnSync(process.execPath, [sessionStartScriptPath], {
          cwd: pluginDir,
          input: heartbeatPayload,
          encoding: "utf-8",
          env: heartbeatEnv,
        });
        assert.equal(firstHeartbeat.status, 0);
        assert.deepEqual(JSON.parse(firstHeartbeat.stdout.trim()), {});
        assert.match(firstHeartbeat.stderr, /Registered normal workspace/);

        const heartbeatRegistryPath = path.join(heartbeatRegistryDir, "registry.json");
        const registryAfterFirstHeartbeat = fs.readFileSync(
          heartbeatRegistryPath,
          "utf-8"
        );

        const secondHeartbeat = spawnSync(process.execPath, [sessionStartScriptPath], {
          cwd: pluginDir,
          input: heartbeatPayload,
          encoding: "utf-8",
          env: heartbeatEnv,
        });
        assert.equal(secondHeartbeat.status, 0);
        assert.deepEqual(JSON.parse(secondHeartbeat.stdout.trim()), {});
        assert.equal(secondHeartbeat.stderr, "");
        assert.equal(
          fs.readFileSync(heartbeatRegistryPath, "utf-8"),
          registryAfterFirstHeartbeat,
          "Heartbeat thu hai trong debounce window khong duoc ghi lai registry"
        );
      }
    });
  } finally {
    if (originalEnvRoot !== undefined) {
      process.env.MCP_WORKSPACE_ROOT = originalEnvRoot;
    } else {
      delete process.env.MCP_WORKSPACE_ROOT;
    }

    if (originalDataDir !== undefined) {
      process.env.DAGW_DATA_DIR = originalDataDir;
    } else {
      delete process.env.DAGW_DATA_DIR;
    }

    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

