import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerWorkspaceFromHook,
  attachActiveWorkspace,
  saveApprovedPlan,
} from "../src/memory/project-memory.js";
import {
  submitExecutionRequest,
  submitExecutionRequestForTask,
  listExecutionRequests,
  approveExecutionStart,
  claimExecutionRequest,
  updateExecutionProgress,
  cancelExecutionRequest,
} from "../src/queue/execution-queue.js";

test("Phase 2A execution queue: HITL, revision và chống chạy trùng", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dagw-queue-test-"));
  const workspace = path.join(tempRoot, "project");
  const dataDir = path.join(tempRoot, "registry");
  fs.mkdirSync(workspace, { recursive: true });
  const options = { dataDir, now: new Date("2026-11-12T04:00:00.000Z") };

  try {
    const registered = registerWorkspaceFromHook(
      { conversationId: "queue-test", workspacePaths: [workspace], hookEventName: "SessionStart" },
      options
    );
    assert.equal(registered.ok, true);
    const attached = attachActiveWorkspace({ initializeIfMissing: true }, options);
    assert.equal(attached.ok, true);
    if (!attached.ok) return;
    const bindingId = attached.data.bindingId;

    const saved = saveApprovedPlan(
      {
        workspaceBindingId: bindingId,
        taskId: "phase2-queue-test",
        objective: "Verify execution queue",
        planSteps: ["Queue safely", "Require HITL", "Claim once"],
        acceptanceCriteria: ["No execution before Start approval"],
        constraints: ["No source modification"],
        approvedByUser: true,
      },
      undefined,
      { workspaceBindingId: bindingId, registryOptions: options }
    );
    assert.equal(saved.ok, true);

    await t.test("submit yêu cầu xác nhận và chống request trùng", () => {
      const denied = submitExecutionRequest(
        { workspaceBindingId: bindingId, userConfirmedPlanHandoff: false },
        options
      );
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.errorCode, "USER_CONFIRMATION_REQUIRED");

      const submitted = submitExecutionRequest(
        { workspaceBindingId: bindingId, userConfirmedPlanHandoff: true },
        options
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) return;
      assert.equal(submitted.data.status, "pending_user_start");
      assert.equal(submitted.data.revision, 0);

      const duplicate = submitExecutionRequest(
        { workspaceBindingId: bindingId, userConfirmedPlanHandoff: true },
        options
      );
      assert.equal(duplicate.ok, false);
      if (!duplicate.ok) assert.equal(duplicate.errorCode, "EXECUTION_REQUEST_ALREADY_EXISTS");
    });

    const listed = listExecutionRequests(bindingId, options);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.data.requests.length, 1);
    const requestId = listed.data.requests[0].requestId;

    await t.test("không queued trước HITL Start; approve đúng tăng revision", () => {
      const denied = approveExecutionStart(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 0, userConfirmedStart: false },
        options
      );
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.errorCode, "USER_CONFIRMATION_REQUIRED");

      const approved = approveExecutionStart(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 0, userConfirmedStart: true },
        options
      );
      assert.equal(approved.ok, true);
      if (!approved.ok) return;
      assert.equal(approved.data.status, "queued");
      assert.equal(approved.data.revision, 1);
    });

    await t.test("claim độc quyền và chặn stale/double claim", () => {
      const claimed = claimExecutionRequest(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 1, executorId: "antigravity:test" },
        options
      );
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      assert.equal(claimed.data.status, "executing");
      assert.equal(claimed.data.revision, 2);

      const doubleClaim = claimExecutionRequest(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 1, executorId: "other" },
        options
      );
      assert.equal(doubleClaim.ok, false);
      if (!doubleClaim.ok) assert.equal(doubleClaim.errorCode, "REVISION_CONFLICT");
    });

    await t.test("chỉ executor đã claim được báo progress và completed không archive task", () => {
      const wrong = updateExecutionProgress(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 2, executorId: "other", status: "executing", progressSummary: "bad" },
        options
      );
      assert.equal(wrong.ok, false);
      if (!wrong.ok) assert.equal(wrong.errorCode, "EXECUTOR_MISMATCH");

      const review = updateExecutionProgress(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 2, executorId: "antigravity:test", status: "review", progressSummary: "Ready for review" },
        options
      );
      assert.equal(review.ok, true);
      if (!review.ok) return;
      assert.equal(review.data.revision, 3);

      const completed = updateExecutionProgress(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 3, executorId: "antigravity:test", status: "completed", progressSummary: "Execution finished; archive still requires user approval" },
        options
      );
      assert.equal(completed.ok, true);
      if (!completed.ok) return;
      assert.equal(completed.data.status, "completed");

      const cancelCompleted = cancelExecutionRequest(
        { workspaceBindingId: bindingId, requestId, expectedRevision: 4, userConfirmedCancel: true },
        options
      );
      assert.equal(cancelCompleted.ok, false);
      if (!cancelCompleted.ok) assert.equal(cancelCompleted.errorCode, "INVALID_EXECUTION_TRANSITION");
    });

    await t.test("Phase 5.1: task mới dispatch độc lập, không bị task legacy completed/chưa archive chặn", () => {
      const intentContract = {
        schemaVersion: "1.0" as const,
        contractRevision: 0,
        inScope: ["queue contract"],
        outOfScope: ["unrelated files"],
        doNotChange: ["public API"],
        acceptanceCriteria: ["contract reaches executor"],
        dependencies: [],
        plannedFiles: [],
      };
      const next = submitExecutionRequestForTask(
        {
          workspaceBindingId: bindingId,
          taskId: "second-independent-task",
          objective: "Execute a second independently approved task",
          userConfirmedPlanHandoff: true,
          intentContract,
        },
        options
      );
      assert.equal(next.ok, true);
      if (!next.ok) return;
      assert.equal(next.data.status, "pending_user_start");
      assert.equal(next.data.taskId, "second-independent-task");
      assert.deepEqual(next.data.intentContract, intentContract);

      const retry = submitExecutionRequestForTask(
        {
          workspaceBindingId: bindingId,
          taskId: "second-independent-task",
          objective: "Execute a second independently approved task",
          userConfirmedPlanHandoff: true,
        },
        options
      );
      assert.equal(retry.ok, true);
      if (retry.ok) assert.equal(retry.data.requestId, next.data.requestId);

      const collision = submitExecutionRequestForTask(
        {
          workspaceBindingId: bindingId,
          taskId: "second-independent-task",
          objective: "Different objective must not overwrite the existing task",
          userConfirmedPlanHandoff: true,
        },
        options
      );
      assert.equal(collision.ok, false);
      if (!collision.ok) assert.equal(collision.errorCode, "TASK_ID_COLLISION");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
