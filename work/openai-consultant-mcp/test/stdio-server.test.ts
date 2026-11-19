import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { registerWorkspaceFromHook } from "../src/registry/workspace-registry.js";

test("MCP Stdio JSON-RPC Integration Test", async (t) => {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-test-"));
  const tempSecondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-ws2-"));
  const tempRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-reg-"));
  const memoryDir = path.join(tempWorkspace, ".ai");

  try {
    const proc = spawn("node", ["dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MCP_WORKSPACE_ROOT: tempWorkspace,
        DAGW_DATA_DIR: tempRegistryDir,
      },
    });

    let stdoutBuffer = "";
    const pendingResponses = new Map<number, (res: any) => void>();

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line.trim());
          if (json.id && pendingResponses.has(json.id)) {
            const cb = pendingResponses.get(json.id)!;
            pendingResponses.delete(json.id);
            cb(json);
          }
        } catch {
          // ignore non-json
        }
      }
    });

    function sendRequest(method: string, params: any): Promise<any> {
      requestId++;
      const id = requestId;
      return new Promise((resolve) => {
        pendingResponses.set(id, resolve);
        const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        proc.stdin.write(req);
      });
    }

    let requestId = 0;

    await t.test("initialize", async () => {
      const res = await sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      assert.equal(res.result.serverInfo.name, "dual-agent-workflow-gateway");
      assert.equal(res.result.serverInfo.version, "5.1.2");
      assert.match(res.result.instructions, /Project Memory.*riêng tư/i);
      assert.match(res.result.instructions, /không.*Git stage\/commit\/push/i);
    });

    await t.test("tools/list phản hồi đủ 32 tools qua Phase 5.1 opt-in dispatch và đúng annotations", async () => {
      const res = await sendRequest("tools/list", {});
      const tools = res.result.tools;
      assert.equal(tools.length, 32);

      const findTool = (name: string) => tools.find((tool: any) => tool.name === name);

      const healthTool = findTool("gateway_health");
      assert.ok(healthTool);
      assert.equal(healthTool.annotations?.readOnlyHint, true);

      const startSessionTool = findTool("start_work_session");
      assert.ok(findTool("dispatch_execution_task"));
      assert.ok(startSessionTool);
      assert.equal(startSessionTool.annotations?.destructiveHint, false);
      assert.match(startSessionTool.description, /BẮT BUỘC|đầu tiên/i);

      const contextHandoffTool = findTool("prepare_context_handoff");
      assert.ok(contextHandoffTool);
      assert.equal(contextHandoffTool.annotations?.destructiveHint, false);
      assert.match(contextHandoffTool.description, /chuyển chat|context/i);

      for (const queueToolName of [
        "submit_execution_request",
        "execution_queue_status",
        "approve_execution_start",
        "claim_execution_request",
        "report_execution_progress",
        "cancel_execution_request",
      ]) {
        assert.ok(findTool(queueToolName), `Thiếu Phase 2 tool ${queueToolName}`);
      }
      assert.equal(findTool("execution_queue_status").annotations?.readOnlyHint, true);
      assert.match(findTool("approve_execution_start").description, /HITL/i);

      for (const intelligenceToolName of [
        "workflow_telemetry_summary",
        "assess_context_health",
        "route_external_review",
      ]) {
        assert.ok(findTool(intelligenceToolName), `Thiếu Phase 3 tool ${intelligenceToolName}`);
      }

      for (const taskToolName of ["register_project_task", "list_project_tasks", "activate_project_task", "update_project_task"]) {
        assert.ok(findTool(taskToolName), `Thiếu Phase 4 tool ${taskToolName}`);
      }
      for (const opsToolName of ["create_project_memory_backup", "list_project_memory_backups", "restore_project_memory_backup", "workflow_audit_summary"]) {
        assert.ok(findTool(opsToolName), `Thiếu Phase 5 tool ${opsToolName}`);
      }
      assert.equal(findTool("restore_project_memory_backup").annotations?.destructiveHint, true);

      const listWsTool = findTool("list_registered_workspaces");
      assert.ok(listWsTool);
      assert.equal(listWsTool.annotations?.readOnlyHint, true);

      const attachTool = findTool("attach_active_workspace");
      assert.ok(attachTool);
      assert.equal(attachTool.annotations?.destructiveHint, false);
      assert.equal(attachTool.annotations?.idempotentHint, false);
      assert.match(attachTool.description, /displayName|project/i);

      const getBindingTool = findTool("get_workspace_binding");
      assert.ok(getBindingTool);
      assert.equal(getBindingTool.annotations?.readOnlyHint, true);

      const detachTool = findTool("detach_workspace");
      assert.ok(detachTool);
      assert.equal(detachTool.annotations?.destructiveHint, false);
      assert.equal(detachTool.annotations?.idempotentHint, true);

      const statusTool = findTool("project_memory_status");
      assert.ok(statusTool);
      assert.equal(statusTool.annotations?.readOnlyHint, true);

      const initTool = findTool("initialize_project_memory");
      assert.ok(initTool);
      assert.equal(initTool.annotations?.destructiveHint, false);
      assert.equal(initTool.annotations?.idempotentHint, true);

      const savePlanTool = findTool("save_approved_plan");
      assert.ok(savePlanTool);
      assert.equal(savePlanTool.annotations?.destructiveHint, false);
      assert.equal(savePlanTool.annotations?.idempotentHint, false);

      const checkpointTool = findTool("checkpoint_task");
      assert.ok(checkpointTool);
      assert.equal(checkpointTool.annotations?.destructiveHint, false);
      assert.equal(checkpointTool.annotations?.idempotentHint, false);

      const resumeTool = findTool("resume_task");
      assert.ok(resumeTool);
      assert.equal(resumeTool.annotations?.readOnlyHint, true);
      assert.match(resumeTool.description, /compact/i);

      const handoffTool = findTool("prepare_handoff");
      assert.ok(handoffTool);
      assert.equal(handoffTool.annotations?.destructiveHint, false);
      assert.equal(handoffTool.annotations?.idempotentHint, false);

      const archiveTool = findTool("archive_completed_task");
      assert.ok(archiveTool);
      assert.equal(archiveTool.annotations?.destructiveHint, true);
      assert.equal(archiveTool.annotations?.idempotentHint, false);
    });

    await t.test("tools/call gateway_health trả về đúng service và status", async () => {
      const res = await sendRequest("tools/call", {
        name: "gateway_health",
        arguments: {},
      });
      assert.equal(res.result.structuredContent.service, "dual-agent-workflow-gateway");
      assert.equal(res.result.structuredContent.status, "ok");
    });

    await t.test("tools/call project_memory_status ban đầu khi chưa init (environment fallback)", async () => {
      const res = await sendRequest("tools/call", {
        name: "project_memory_status",
        arguments: {},
      });
      const data = res.result.structuredContent;
      assert.equal(data.configured, true);
      assert.equal(data.workspaceExists, true);
      assert.equal(data.memoryDirectoryExists, false);
      assert.equal(data.files.projectContext, false);
      assert.equal(data.files.approvedPlan, false);
      assert.equal(data.activeTask, false);
      assert.equal(data.activeTaskId, null);
      assert.equal(data.activeRevision, 0);
      assert.equal(data.archiveCount, 0);
      assert.equal(data.workspaceResolution, "environment");
      assert.ok(data.workspaceId?.startsWith("ws_"));
      assert.ok(data.rootFingerprint?.startsWith("fp_"));
      assert.equal("canonicalRoot" in data, false);
    });

    await t.test("tools/call initialize_project_memory tạo đủ 5 file", async () => {
      const res = await sendRequest("tools/call", {
        name: "initialize_project_memory",
        arguments: {},
      });
      assert.equal(res.result.isError, undefined);
      assert.equal(res.result.structuredContent.created.length, 5);
      assert.equal(res.result.structuredContent.alreadyExisted.length, 0);
      assert.equal(res.result.structuredContent.workspaceResolution, "environment");
      assert.equal("canonicalRoot" in res.result.structuredContent, false);
    });

    await t.test("tools/call project_memory_status sau khi init có đủ 5 file true", async () => {
      const res = await sendRequest("tools/call", {
        name: "project_memory_status",
        arguments: {},
      });
      const data = res.result.structuredContent;
      assert.equal(data.configured, true);
      assert.equal(data.memoryDirectoryExists, true);
      assert.deepEqual(data.files, {
        projectContext: true,
        approvedPlan: true,
        taskState: true,
        decisions: true,
        handoff: true,
      });
      assert.equal(data.activeTask, false);
      assert.equal(data.archiveCount, 0);
    });

    await t.test("tools/call save_approved_plan thành công và từ chối gọi lần 2", async () => {
      const res1 = await sendRequest("tools/call", {
        name: "save_approved_plan",
        arguments: {
          taskId: "STDIO-TASK-1",
          objective: "Test stdio save plan",
          planSteps: ["Step 1", "Step 2"],
          acceptanceCriteria: ["Criterion 1"],
          constraints: ["No external API"],
          approvedByUser: true,
        },
      });
      assert.equal(res1.result.isError, undefined);
      assert.equal(res1.result.structuredContent.saved, true);
      assert.equal(res1.result.structuredContent.taskId, "STDIO-TASK-1");
      assert.equal(res1.result.structuredContent.workspaceResolution, "environment");

      const res2 = await sendRequest("tools/call", {
        name: "save_approved_plan",
        arguments: {
          taskId: "STDIO-TASK-2",
          objective: "Overwrite attempt",
          planSteps: ["Step X"],
          acceptanceCriteria: ["Criterion X"],
          constraints: [],
          approvedByUser: true,
        },
      });
      assert.equal(res2.result.isError, true);
      assert.equal(res2.result.structuredContent.errorCode, "PLAN_ALREADY_EXISTS");
    });

    await t.test("tools/call checkpoint_task thành công ở revision 0", async () => {
      const okRes = await sendRequest("tools/call", {
        name: "checkpoint_task",
        arguments: {
          taskId: "STDIO-TASK-1",
          expectedRevision: 0,
          status: "in_progress",
          objective: "Test stdio save plan",
          acceptanceCriteria: ["Criterion 1"],
          completed: ["Step 1"],
          currentState: "Executing Step 2",
          nextSteps: ["Finish Step 2", "Run handoff"],
          changedFiles: ["src/index.ts"],
          tests: [
            {
              command: "npm test",
              status: "passed",
              result: "All green",
            },
          ],
          blockers: [],
          openQuestions: [],
        },
      });
      assert.equal(okRes.result.isError, undefined);
      assert.equal(okRes.result.structuredContent.revision, 1);
      assert.equal(okRes.result.structuredContent.workspaceResolution, "environment");
    });

    await t.test("tools/call prepare_handoff thành công với revision 1", async () => {
      const okRes = await sendRequest("tools/call", {
        name: "prepare_handoff",
        arguments: {
          expectedRevision: 1,
          reason: "end_session",
          nextExactAction: "Continue with Finish Step 2 in next session",
          doNotRedo: ["Do not re-init memory"],
        },
      });
      assert.equal(okRes.result.isError, undefined);
      assert.equal(okRes.result.structuredContent.taskId, "STDIO-TASK-1");
      assert.equal(okRes.result.structuredContent.basedOnRevision, 1);
      assert.equal(okRes.result.structuredContent.handoffUpdated, true);
    });

    await t.test("tools/call resume_task mặc định là compact và hỗ trợ full", async () => {
      const compactRes = await sendRequest("tools/call", {
        name: "resume_task",
        arguments: {},
      });
      assert.equal(compactRes.result.isError, undefined);
      const compactData = compactRes.result.structuredContent;
      assert.equal(compactData.hasApprovedPlan, true);
      assert.equal(compactData.taskId, "STDIO-TASK-1");
      assert.equal(compactData.revision, 1);
      assert.equal(compactData.status, "in_progress");
      assert.equal(compactData.recommendedNextAction, "Finish Step 2");
      assert.equal(
        compactData.handoffNextAction,
        "Continue with Finish Step 2 in next session"
      );
      assert.equal("projectContext" in compactData, false);
      assert.equal("taskState" in compactData, false);
      assert.equal(compactData.workspaceResolution, "environment");

      const fullRes = await sendRequest("tools/call", {
        name: "resume_task",
        arguments: { detailLevel: "full" },
      });
      assert.equal(fullRes.result.isError, undefined);
      const fullData = fullRes.result.structuredContent;
      assert.equal(typeof fullData.projectContext, "string");
      assert.equal(typeof fullData.taskState, "string");
    });

    await t.test("tools/call archive_completed_task hoàn tất vòng đời task và cập nhật status", async () => {
      // Cannot archive while status is in_progress
      const notDoneRes = await sendRequest("tools/call", {
        name: "archive_completed_task",
        arguments: {
          taskId: "STDIO-TASK-1",
          expectedRevision: 1,
          userConfirmed: true,
          completionSummary: "Try archiving early",
        },
      });
      assert.equal(notDoneRes.result.isError, true);
      assert.equal(notDoneRes.result.structuredContent.errorCode, "TASK_NOT_COMPLETED");

      // Checkpoint to completed (revision 2)
      const completeCp = await sendRequest("tools/call", {
        name: "checkpoint_task",
        arguments: {
          taskId: "STDIO-TASK-1",
          expectedRevision: 1,
          status: "completed",
          objective: "Test stdio save plan",
          acceptanceCriteria: ["Criterion 1"],
          completed: ["Step 1", "Step 2"],
          currentState: "All steps completed",
          nextSteps: [],
          changedFiles: ["src/index.ts"],
          tests: [
            {
              command: "npm test",
              status: "passed",
              result: "All green",
            },
          ],
          blockers: [],
          openQuestions: [],
        },
      });
      assert.equal(completeCp.result.isError, undefined);
      assert.equal(completeCp.result.structuredContent.revision, 2);

      // Archive task
      const archiveRes = await sendRequest("tools/call", {
        name: "archive_completed_task",
        arguments: {
          taskId: "STDIO-TASK-1",
          expectedRevision: 2,
          userConfirmed: true,
          completionSummary: "Completed STDIO-TASK-1 successfully",
        },
      });
      assert.equal(archiveRes.result.isError, undefined);
      const archiveData = archiveRes.result.structuredContent;
      assert.equal(archiveData.archived, true);
      assert.equal(archiveData.taskId, "STDIO-TASK-1");
      assert.equal(archiveData.archivedRevision, 2);
      assert.equal(archiveData.resetCurrentTask, true);
      assert.ok(archiveData.archiveId.endsWith("_STDIO-TASK-1"));

      // Verify project_memory_status after archive
      const statusRes = await sendRequest("tools/call", {
        name: "project_memory_status",
        arguments: {},
      });
      const statusData = statusRes.result.structuredContent;
      assert.equal(statusData.activeTask, false);
      assert.equal(statusData.activeTaskId, null);
      assert.equal(statusData.activeRevision, 0);
      assert.equal(statusData.archiveCount, 1);
    });

    await t.test("tools/call cho 4 workspace tools mới qua stdio (list, attach, get_binding, detach) và không lộ canonicalRoot", async () => {
      registerWorkspaceFromHook(
        {
          conversationId: "stdio-conv-1",
          workspacePaths: [tempSecondWorkspace],
          cwd: tempSecondWorkspace,
          hookEventName: "SessionStart",
        },
        { dataDir: tempRegistryDir }
      );

      const listRes = await sendRequest("tools/call", {
        name: "list_registered_workspaces",
        arguments: {},
      });
      assert.equal(listRes.result.isError, undefined);
      const listData = listRes.result.structuredContent;
      assert.equal(listData.workspaces.length, 1);
      assert.equal(listData.workspaces[0].isActive, true);
      assert.equal("canonicalRoot" in listData.workspaces[0], false);
      assert.equal(JSON.stringify(listRes).includes(tempSecondWorkspace), false);

      const startSessionRes = await sendRequest("tools/call", {
        name: "start_work_session",
        arguments: {},
      });
      assert.equal(startSessionRes.result.isError, undefined);
      const startSessionData = startSessionRes.result.structuredContent;
      assert.equal(startSessionData.sessionReady, true);
      assert.equal(startSessionData.mode, "new_task");
      assert.equal(startSessionData.projectMemoryInitialized, true);
      assert.ok(startSessionData.bindingId.startsWith("bind_"));
      assert.equal(startSessionData.displayName, path.basename(tempSecondWorkspace));
      assert.equal("canonicalRoot" in startSessionData, false);
      assert.equal(JSON.stringify(startSessionRes).includes(tempSecondWorkspace), false);

      const attachRes = await sendRequest("tools/call", {
        name: "attach_active_workspace",
        arguments: { initializeIfMissing: true },
      });
      assert.equal(attachRes.result.isError, undefined);
      const attachData = attachRes.result.structuredContent;
      assert.ok(attachData.bindingId.startsWith("bind_"));
      assert.equal(attachData.projectMemoryInitialized, true);
      assert.equal(attachData.workspaceResolution, "binding");
      assert.equal("canonicalRoot" in attachData, false);

      const getBindRes = await sendRequest("tools/call", {
        name: "get_workspace_binding",
        arguments: { bindingId: attachData.bindingId },
      });
      assert.equal(getBindRes.result.isError, undefined);
      assert.equal(getBindRes.result.structuredContent.bindingId, attachData.bindingId);
      assert.equal("canonicalRoot" in getBindRes.result.structuredContent, false);

      // Call project_memory_status using workspaceBindingId
      const boundStatusRes = await sendRequest("tools/call", {
        name: "project_memory_status",
        arguments: { workspaceBindingId: attachData.bindingId },
      });
      assert.equal(boundStatusRes.result.isError, undefined);
      assert.equal(
        boundStatusRes.result.structuredContent.workspaceId,
        attachData.workspaceId
      );
      assert.equal(
        boundStatusRes.result.structuredContent.workspaceResolution,
        "binding"
      );

      // Detach binding
      const detachRes = await sendRequest("tools/call", {
        name: "detach_workspace",
        arguments: { bindingId: attachData.bindingId },
      });
      assert.equal(detachRes.result.isError, undefined);
      assert.equal(detachRes.result.structuredContent.detached, true);

      // Subsequent call with detached bindingId must return BINDING_NOT_FOUND and NOT fallback to MCP_WORKSPACE_ROOT
      const afterDetachRes = await sendRequest("tools/call", {
        name: "project_memory_status",
        arguments: { workspaceBindingId: attachData.bindingId },
      });
      assert.equal(afterDetachRes.result.isError, true);
      assert.equal(
        afterDetachRes.result.structuredContent.errorCode,
        "BINDING_NOT_FOUND"
      );
    });

    await t.test("Không còn file tạm trong .ai sau toàn bộ phiên stdio", () => {
      const remainingTmp = fs
        .readdirSync(memoryDir)
        .filter((f) => f.startsWith(".tmp-") || f.endsWith(".tmp"));
      assert.deepEqual(remainingTmp, []);
    });

    proc.stdin.end();
    proc.kill();
  } finally {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
    fs.rmSync(tempSecondWorkspace, { recursive: true, force: true });
    fs.rmSync(tempRegistryDir, { recursive: true, force: true });
  }
});
