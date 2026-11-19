import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorkspaceFromHook, attachActiveWorkspace } from "../src/memory/project-memory.js";
import { registerProjectTask, listProjectTasks, activateProjectTask, updateProjectTask } from "../src/tasks/task-registry.js";

test("Phase 4 task registry: multi-project, dependency và file claim safety", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-tasks-test-"));
  const dataDir = path.join(root, "data");
  const wsA = path.join(root, "project-a");
  const wsB = path.join(root, "project-b");
  fs.mkdirSync(wsA); fs.mkdirSync(wsB);
  const options = { dataDir, now: new Date("2026-11-12T06:00:00.000Z") };
  try {
    registerWorkspaceFromHook({ conversationId: "a", workspacePaths: [wsA], hookEventName: "SessionStart" }, options);
    const attachedA = attachActiveWorkspace({ initializeIfMissing: true }, options);
    assert.equal(attachedA.ok, true); if (!attachedA.ok) return;
    const a = attachedA.data.bindingId;

    const base = { workspaceBindingId: a, inScope: ["Auth module"], outOfScope: ["Billing"], doNotChange: ["Legacy API"], acceptanceCriteria: ["Tests pass"], userApprovedIntentContract: true };
    const taskA = registerProjectTask({ ...base, taskId: "auth-backend", objective: "Build auth backend", dependencies: [], plannedFiles: ["src/auth.ts"] }, options);
    assert.equal(taskA.ok, true);
    const taskB = registerProjectTask({ ...base, taskId: "auth-ui", objective: "Build auth UI", dependencies: [], plannedFiles: ["src/auth.ts"] }, options);
    assert.equal(taskB.ok, true);
    const taskC = registerProjectTask({ ...base, taskId: "auth-e2e", objective: "Test auth", dependencies: ["auth-backend"], plannedFiles: ["test/auth.test.ts"] }, options);
    assert.equal(taskC.ok, true);

    await t.test("dependency chưa hoàn thành bị chặn", () => {
      const blocked = activateProjectTask({ workspaceBindingId: a, taskId: "auth-e2e", expectedRevision: 0, userConfirmedActivation: true }, options);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.errorCode, "DEPENDENCIES_INCOMPLETE");
    });

    await t.test("file claim chặn hai active task cùng file", () => {
      const activeA = activateProjectTask({ workspaceBindingId: a, taskId: "auth-backend", expectedRevision: 0, userConfirmedActivation: true }, options);
      assert.equal(activeA.ok, true);
      const conflict = activateProjectTask({ workspaceBindingId: a, taskId: "auth-ui", expectedRevision: 0, userConfirmedActivation: true }, options);
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.errorCode, "FILE_CLAIM_CONFLICT");
    });

    await t.test("hoàn thành dependency tự mở khóa task phụ thuộc", () => {
      const completed = updateProjectTask({ workspaceBindingId: a, taskId: "auth-backend", expectedRevision: 1, status: "completed", progressSummary: "Done" }, options);
      assert.equal(completed.ok, true);
      const listed = listProjectTasks(a, options);
      assert.equal(listed.ok, true);
      if (listed.ok) assert.equal(listed.data.tasks.find((task) => task.taskId === "auth-e2e")?.status, "ready");
    });

    await t.test("cùng taskId ở project khác được cô lập", () => {
      registerWorkspaceFromHook({ conversationId: "b", workspacePaths: [wsB], hookEventName: "SessionStart" }, options);
      const attachedB = attachActiveWorkspace({ initializeIfMissing: true }, options);
      assert.equal(attachedB.ok, true); if (!attachedB.ok) return;
      const created = registerProjectTask({ ...base, workspaceBindingId: attachedB.data.bindingId, taskId: "auth-backend", objective: "Separate project task", dependencies: [], plannedFiles: ["src/auth.ts"] }, options);
      assert.equal(created.ok, true);
      const listB = listProjectTasks(attachedB.data.bindingId, options);
      assert.equal(listB.ok, true);
      if (listB.ok) assert.equal(listB.data.tasks.length, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
