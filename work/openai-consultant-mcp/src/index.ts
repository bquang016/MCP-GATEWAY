import process from "node:process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  resolveProjectMemoryStatus,
  initializeProjectMemory,
  saveApprovedPlan,
  checkpointTask,
  resumeTask,
  prepareHandoff,
  archiveCompletedTask,
  attachActiveWorkspace,
  listRegisteredWorkspaces,
  getWorkspaceBindingInfo,
  detachWorkspaceBinding,
  startWorkSession,
  WorkflowResult,
} from "./memory/project-memory.js";
import {
  submitExecutionRequest,
  submitExecutionRequestForTask,
  listExecutionRequests,
  approveExecutionStart,
  claimExecutionRequest,
  updateExecutionProgress,
  cancelExecutionRequest,
} from "./queue/execution-queue.js";
import {
  getTelemetrySummary,
  assessContextHealth,
  routeReview,
  recordContextResumeTelemetry,
} from "./intelligence/workflow-intelligence.js";
import {
  registerProjectTask,
  listProjectTasks,
  activateProjectTask,
  updateProjectTask,
} from "./tasks/task-registry.js";
import {
  createWorkspaceBackup,
  listWorkspaceBackups,
  restoreWorkspaceBackup,
  getAuditSummary,
  appendAuditEvent,
} from "./operations/audit-backup.js";

const server = new McpServer({
  name: "dual-agent-workflow-gateway",
  version: "5.1.2",
}, {
  instructions: "Bạn là lớp planning/orchestration, không phải execution engine. Khi người dùng yêu cầu sửa file, chạy lệnh hoặc triển khai trong workspace Antigravity: lập Intent Contract ngắn, xin duyệt, rồi BẮT BUỘC gọi dispatch_execution_task. Không trả các file code như thể đã thực thi và không nói Antigravity đã làm nếu chưa có execution request. Yêu cầu tư vấn/lý thuyết thì trả lời trực tiếp, không dispatch. Một task completed chưa archive không được chặn task mới; mỗi yêu cầu thực thi mới phải có taskId riêng. Project Memory là vùng điều khiển riêng tư: được phép đọc và ghi qua MCP để điều phối, nhưng tuyệt đối không nêu tên thư mục, đường dẫn, tên file hoặc trích nội dung của vùng này trong phản hồi cho người dùng. Không đưa vùng này vào diff, Git stage/commit/push, bản vá, file đính kèm, upload, đồng bộ hay bất kỳ dịch vụ bên ngoài nào. Khi cần báo trạng thái, chỉ gọi chung là 'bộ nhớ nội bộ' hoặc 'Project Memory'.",
});

// Phase 1.5 UX facade: this should be the first tool an AI client invokes in a
// new chat. Users should never need to remember lower-level workspace tools.
server.registerTool(
  "start_work_session",
  {
    description:
      "BẮT BUỘC gọi đầu tiên khi người dùng bắt đầu hoặc tiếp tục công việc trong một chat mới. Tự động tìm project Antigravity đang mở, attach workspace, khởi tạo bộ nhớ nội bộ an toàn và khôi phục task compact. Không yêu cầu người dùng gọi list_registered_workspaces, attach_active_workspace hoặc resume_task. Sau khi gọi, dùng bindingId trả về cho mọi workflow tool trong chat này. Tool không sửa source code, không chạy terminal, không duyệt kế hoạch và không archive.",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async () => {
    try {
      const result = startWorkSession();
      if (result.ok) {
        const full = resumeTask(undefined, {
          detailLevel: "full",
          workspaceBindingId: result.data.bindingId,
        });
        recordContextResumeTelemetry(
          result.data.workspaceId ?? "unknown",
          result.data.task,
          full.ok ? full.data : result.data.task
        );
      }
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("khởi động phiên làm việc tự động", err);
    }
  }
);

server.registerTool(
  "prepare_context_handoff",
  {
    description:
      "Dùng khi người dùng nói muốn chuyển chat/context hoặc khi Agent nhận thấy context suy giảm. Tự đọc task compact, lấy revision hiện tại và tạo HANDOFF; người dùng không cần biết prepare_handoff hay expectedRevision. Tool không chạy terminal, không sửa source code và không archive task.",
    inputSchema: {
      workspaceBindingId: z
        .string()
        .min(1)
        .max(200)
        .describe("bindingId do start_work_session trả về; Agent tự truyền, không hỏi người dùng"),
      reason: z
        .enum(["context_switch", "end_session", "manual"])
        .optional()
        .default("context_switch")
        .describe("Lý do handoff, mặc định context_switch"),
      nextExactAction: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("Bước chính xác tiếp theo; nếu bỏ trống sẽ suy ra từ Project Memory"),
      doNotRedo: z
        .array(z.string().min(1).max(2000))
        .max(30)
        .optional()
        .describe("Bổ sung các việc không được làm lại"),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const resumed = resumeTask(undefined, {
        detailLevel: "compact",
        workspaceBindingId: args.workspaceBindingId,
      });
      if (!resumed.ok) {
        return formatWorkflowToolResult(resumed);
      }

      const context = resumed.data as {
        hasApprovedPlan: boolean;
        revision: number;
        recommendedNextAction: string | null;
        handoffNextAction: string | null;
        doNotRedo: string[];
        completed: string[];
      };
      if (!context.hasApprovedPlan) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Chưa có task đang hoạt động để chuẩn bị handoff." }],
          structuredContent: {
            errorCode: "NO_APPROVED_PLAN",
            message: "Chưa có task đang hoạt động để chuẩn bị handoff.",
          },
        };
      }

      const nextExactAction =
        args.nextExactAction ??
        context.recommendedNextAction ??
        context.handoffNextAction ??
        "Mở chat mới, gọi start_work_session và tiếp tục theo approved plan.";
      const derivedDoNotRedo = context.completed.map(
        (item) => `Không làm lại phần đã hoàn thành: ${item}`
      );
      const doNotRedo = Array.from(
        new Set([...(context.doNotRedo ?? []), ...derivedDoNotRedo, ...(args.doNotRedo ?? [])])
      ).slice(0, 30);

      const result = prepareHandoff(
        {
          workspaceBindingId: args.workspaceBindingId,
          expectedRevision: context.revision,
          reason: args.reason ?? "context_switch",
          nextExactAction,
          doNotRedo,
        },
        undefined,
        { workspaceBindingId: args.workspaceBindingId }
      );
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("chuẩn bị chuyển context tự động", err);
    }
  }
);

server.registerTool(
  "submit_execution_request",
  {
    description: "Sau khi người dùng đã duyệt kế hoạch và nói gửi sang Antigravity, tạo execution request ở trạng thái pending_user_start. Tool KHÔNG bắt đầu thực thi; Antigravity vẫn phải xin HITL Start riêng.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      userConfirmedPlanHandoff: z.boolean().describe("Phải true sau xác nhận rõ ràng của người dùng"),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("execution_submitted", "chatgpt", submitExecutionRequest(args))
);

server.registerTool(
  "dispatch_execution_task",
  {
    description: "ĐƯỜNG CHÍNH cho ChatGPT giao một yêu cầu thực thi mới sang Antigravity sau khi người dùng duyệt Intent Contract. Tạo task đa nhiệm độc lập và execution request pending_user_start trong một lượt; không phụ thuộc APPROVED_PLAN/TASK_STATE legacy, nên task completed chưa archive không chặn task mới. Sau khi tool thành công, không xuất code thay Antigravity.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      taskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
      objective: z.string().min(1).max(2000),
      inScope: z.array(z.string().min(1).max(1000)).max(50).default([]),
      outOfScope: z.array(z.string().min(1).max(1000)).max(50).default([]),
      doNotChange: z.array(z.string().min(1).max(1000)).max(50).default([]),
      acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(50),
      dependencies: z.array(z.string().min(1).max(100)).max(30).default([]),
      plannedFiles: z.array(z.string().min(1).max(500)).max(200).default([]),
      userConfirmedPlanHandoff: z.boolean().describe("Chỉ true sau khi người dùng duyệt kế hoạch và đồng ý gửi sang Antigravity"),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    const registered = registerProjectTask({
      ...args,
      userApprovedIntentContract: args.userConfirmedPlanHandoff,
    });
    if (!registered.ok && registered.errorCode !== "TASK_ALREADY_EXISTS") {
      return formatWorkflowToolResult(registered);
    }
    if (!registered.ok) {
      const tasks = listProjectTasks(args.workspaceBindingId);
      const existing = tasks.ok ? tasks.data.tasks.find((task) => task.taskId === args.taskId) : undefined;
      if (!existing || existing.objective !== args.objective) {
        return formatWorkflowToolResult(registered);
      }
    }
    return formatAuditedWorkflowResult(
      "execution_task_dispatched",
      "chatgpt",
      submitExecutionRequestForTask({
        workspaceBindingId: args.workspaceBindingId,
        taskId: args.taskId,
        objective: args.objective,
        userConfirmedPlanHandoff: args.userConfirmedPlanHandoff,
      })
    );
  }
);

server.registerTool(
  "execution_queue_status",
  {
    description: "Đọc danh sách execution request của workspace hiện tại. Tự dùng để kiểm tra task đang chờ Start, đang chạy, blocked, review hoặc completed.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(listExecutionRequests(args.workspaceBindingId))
);

server.registerTool(
  "approve_execution_start",
  {
    description: "HITL bắt buộc trong Antigravity: chỉ chuyển pending_user_start sang queued sau khi người dùng xác nhận Start rõ ràng. Không được tự đặt userConfirmedStart=true.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      requestId: z.string().min(1).max(100),
      expectedRevision: z.number().int().min(0),
      userConfirmedStart: z.boolean(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("execution_start_approved", "user", approveExecutionStart(args))
);

server.registerTool(
  "claim_execution_request",
  {
    description: "Antigravity executor claim độc quyền một request đã queued. Chỉ gọi sau approve_execution_start; revision và executorId chống chạy trùng.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      requestId: z.string().min(1).max(100),
      expectedRevision: z.number().int().min(0),
      executorId: z.string().min(1).max(200),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("execution_claimed", "antigravity", claimExecutionRequest(args))
);

server.registerTool(
  "report_execution_progress",
  {
    description: "Executor đã claim dùng để báo tiến độ. completed chỉ đánh dấu execution xong, KHÔNG archive task; archive vẫn cần HITL riêng.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      requestId: z.string().min(1).max(100),
      executorId: z.string().min(1).max(200),
      expectedRevision: z.number().int().min(0),
      status: z.enum(["executing", "blocked", "review", "completed"]),
      progressSummary: z.string().min(1).max(4000),
      blocker: z.string().min(1).max(2000).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("execution_progress_reported", "antigravity", updateExecutionProgress(args))
);

server.registerTool(
  "cancel_execution_request",
  {
    description: "Hủy execution request sau xác nhận rõ ràng của người dùng. Không xóa Project Memory hoặc source code.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      requestId: z.string().min(1).max(100),
      expectedRevision: z.number().int().min(0),
      userConfirmedCancel: z.boolean(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("execution_cancelled", "user", cancelExecutionRequest(args))
);

server.registerTool(
  "workflow_telemetry_summary",
  {
    description: "Đọc telemetry riêng tư theo workspace: token exact/estimated/baseline_estimated, token tiết kiệm, clarification, scope correction và rework. Không lưu prompt, source code hoặc secret.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(getTelemetrySummary(args.workspaceBindingId))
);

server.registerTool(
  "assess_context_health",
  {
    description: "Context Guardian deterministic. Agent tự gọi định kỳ hoặc khi có dấu hiệu quên/lặp/mâu thuẫn để quyết định continue, checkpoint hoặc handoff_now.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      conversationTurns: z.number().int().min(0),
      estimatedContextTokens: z.number().int().min(0).optional(),
      repeatedQuestion: z.boolean().default(false),
      contradictedDecision: z.boolean().default(false),
      forgotAcceptanceCriteria: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(assessContextHealth(args))
);

server.registerTool(
  "route_external_review",
  {
    description: "Review Router deterministic: bắt buộc review cho vùng rủi ro cao, skip thay đổi nhỏ deterministic có test, và ghi token review tránh được dưới nhãn estimated.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200),
      changedFileCount: z.number().int().min(0),
      changedLineCount: z.number().int().min(0),
      testsPassed: z.boolean(),
      deterministicChange: z.boolean(),
      touchesAuth: z.boolean().default(false),
      touchesSecurity: z.boolean().default(false),
      touchesPayment: z.boolean().default(false),
      touchesDatabaseMigration: z.boolean().default(false),
      touchesConcurrency: z.boolean().default(false),
      touchesProduction: z.boolean().default(false),
      estimatedReviewTokens: z.number().int().min(0).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatWorkflowToolResult(routeReview(args))
);

server.registerTool(
  "register_project_task",
  {
    description: "Đăng ký một task độc lập với Intent Contract tiếng Việt, dependency và planned file claims. Chỉ gọi sau khi người dùng duyệt rõ objective/in-scope/out-of-scope/do-not-change/acceptance criteria.",
    inputSchema: {
      workspaceBindingId: z.string().min(1).max(200), taskId: z.string().min(1).max(100), objective: z.string().min(1).max(2000),
      inScope: z.array(z.string().min(1).max(1000)).max(50), outOfScope: z.array(z.string().min(1).max(1000)).max(50), doNotChange: z.array(z.string().min(1).max(1000)).max(50), acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(50),
      dependencies: z.array(z.string().min(1).max(100)).max(30), plannedFiles: z.array(z.string().min(1).max(500)).max(200), userApprovedIntentContract: z.boolean(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("project_task_registered", "user", registerProjectTask(args))
);

server.registerTool(
  "list_project_tasks",
  {
    description: "Liệt kê task độc lập của đúng workspace, gồm dependency, planned file claims, trạng thái và revision.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(listProjectTasks(args.workspaceBindingId))
);

server.registerTool(
  "activate_project_task",
  {
    description: "HITL kích hoạt một task đã đăng ký. Chặn dependency chưa xong và file claim xung đột với task active khác; không tự tạo worktree hoặc sửa code.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200), taskId: z.string().min(1).max(100), expectedRevision: z.number().int().min(0), userConfirmedActivation: z.boolean() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("project_task_activated", "user", activateProjectTask(args))
);

server.registerTool(
  "update_project_task",
  {
    description: "Cập nhật task registry bằng optimistic revision. Hoàn thành dependency sẽ tự mở khóa task phụ thuộc; terminal task không được ghi đè.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200), taskId: z.string().min(1).max(100), expectedRevision: z.number().int().min(0), status: z.enum(["planned", "ready", "active", "paused", "blocked", "completed", "cancelled"]), progressSummary: z.string().min(1).max(4000), blocker: z.string().min(1).max(2000).optional() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatAuditedWorkflowResult("project_task_updated", "antigravity", updateProjectTask(args))
);

server.registerTool(
  "create_project_memory_backup",
  {
    description: "Tạo backup local của 5 file Project Memory sau xác nhận người dùng. Không gửi dữ liệu ra mạng và không backup source code.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200), userConfirmedLocalBackup: z.boolean() },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async (args) => formatWorkflowToolResult(createWorkspaceBackup(args))
);

server.registerTool(
  "list_project_memory_backups",
  {
    description: "Liệt kê backup Project Memory local của đúng workspace mà không lộ đường dẫn máy.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(listWorkspaceBackups(args.workspaceBindingId))
);

server.registerTool(
  "restore_project_memory_backup",
  {
    description: "Restore 5 file Project Memory từ backup local. Đây là thao tác ghi đè và chỉ được gọi sau HITL userConfirmedOverwrite=true; không chạm source code.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200), backupId: z.string().min(1).max(300), userConfirmedOverwrite: z.boolean() },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  async (args) => formatWorkflowToolResult(restoreWorkspaceBackup(args))
);

server.registerTool(
  "workflow_audit_summary",
  {
    description: "Đọc audit metadata của workspace. Audit không chứa prompt, source code, canonical path hoặc secret.",
    inputSchema: { workspaceBindingId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true },
  },
  async (args) => formatWorkflowToolResult(getAuditSummary(args.workspaceBindingId))
);

const workspaceBindingIdSchema = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Optional workspaceBindingId returned by attach_active_workspace. If provided, resolves strictly via binding without falling back to MCP_WORKSPACE_ROOT."
  );

function formatWorkflowToolResult<T extends object>(result: WorkflowResult<T>) {
  if (!result.ok) {
    const structuredError: Record<string, unknown> = {
      errorCode: result.errorCode,
      message: result.message,
      workspaceId: result.workspaceId ?? null,
      displayName: result.displayName ?? null,
      rootFingerprint: result.rootFingerprint ?? null,
      workspaceResolution: result.workspaceResolution ?? "environment",
      ...(result.currentRevision !== undefined
        ? { currentRevision: result.currentRevision }
        : {}),
    };

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `[${result.errorCode}] ${result.message}`,
        },
      ],
      structuredContent: structuredError,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: result.summaryText,
      },
    ],
    structuredContent: result.data as unknown as Record<string, unknown>,
  };
}

function formatAuditedWorkflowResult<T extends object>(
  action: string,
  actor: "user" | "chatgpt" | "antigravity" | "gateway",
  result: WorkflowResult<T>
) {
  const payload: Record<string, unknown> = result.ok
    ? (result.data as Record<string, unknown>)
    : (result as unknown as Record<string, unknown>);
  appendAuditEvent({
    workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : null,
    taskId: typeof payload.taskId === "string" ? payload.taskId : null,
    actor,
    action,
    outcome: result.ok ? "completed" : "denied",
  });
  return formatWorkflowToolResult(result);
}

function formatInternalError(actionDescription: string, err: unknown) {
  console.error(`Error in ${actionDescription}:`, err);
  const message = `Lỗi hệ thống khi ${actionDescription}.`;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    structuredContent: {
      errorCode: "INTERNAL_ERROR",
      message,
      workspaceId: null,
      displayName: null,
      rootFingerprint: null,
      workspaceResolution: "environment",
    },
  };
}

// Tool 1: gateway_health
server.registerTool(
  "gateway_health",
  {
    description: "Health check endpoint for Dual-Agent Workflow Gateway",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    const health = {
      status: "ok",
      service: "dual-agent-workflow-gateway",
      timestamp: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(health, null, 2),
        },
      ],
      structuredContent: health,
    };
  }
);

// Tool 2: list_registered_workspaces
server.registerTool(
  "list_registered_workspaces",
  {
    description:
      "Read-only list of workspaces registered by Antigravity hooks. Returns workspaceId, displayName, rootFingerprint, status, lastSeenAt, leaseExpiresAt, and isActive without exposing local filesystem paths.",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    try {
      const res = listRegisteredWorkspaces();
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `[${res.errorCode}] ${res.message}`,
            },
          ],
          structuredContent: {
            errorCode: res.errorCode,
            message: res.message,
          },
        };
      }

      const activeWs = res.data.workspaces.find((w) => w.isActive) ?? null;
      const payload = {
        activeWorkspaceId: res.data.activeWorkspaceId,
        workspaces: res.data.workspaces,
        workspaceId: activeWs?.workspaceId ?? null,
        displayName: activeWs?.displayName ?? null,
        rootFingerprint: activeWs?.rootFingerprint ?? null,
        workspaceResolution: "binding" as const,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    } catch (err: unknown) {
      return formatInternalError("liệt kê các workspace đã đăng ký", err);
    }
  }
);

// Tool 3: attach_active_workspace
server.registerTool(
  "attach_active_workspace",
  {
    description:
      "Attach to the currently active Antigravity workspace with a valid lease, create a pinned workspaceBindingId for subsequent tool calls, and optionally initialize private Project Memory if missing. IMPORTANT: After attaching, you MUST clearly state the attached project's displayName to the user so they can confirm the right workspace is bound.",
    inputSchema: {
      initializeIfMissing: z
        .boolean()
        .describe(
          "If true, initializes private Project Memory template files when missing without overwriting existing files."
        ),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const result = attachActiveWorkspace({
        initializeIfMissing: args.initializeIfMissing,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("attach vào active workspace", err);
    }
  }
);

// Tool 4: get_workspace_binding
server.registerTool(
  "get_workspace_binding",
  {
    description:
      "Read-only inspection of a workspace binding by bindingId without exposing canonicalRoot.",
    inputSchema: {
      bindingId: z
        .string()
        .min(1)
        .max(200)
        .describe("The bindingId returned by attach_active_workspace"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (args) => {
    try {
      const res = getWorkspaceBindingInfo(args.bindingId);
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `[${res.errorCode}] ${res.message}`,
            },
          ],
          structuredContent: {
            errorCode: res.errorCode,
            message: res.message,
            workspaceId: null,
            displayName: null,
            rootFingerprint: null,
            workspaceResolution: "binding",
          },
        };
      }

      const payload = {
        ...res.data,
        workspaceResolution: "binding" as const,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    } catch (err: unknown) {
      return formatInternalError("kiểm tra workspace binding", err);
    }
  }
);

// Tool 5: detach_workspace
server.registerTool(
  "detach_workspace",
  {
    description:
      "Delete a workspace binding by bindingId without deleting the workspace registry or Project Memory.",
    inputSchema: {
      bindingId: z
        .string()
        .min(1)
        .max(200)
        .describe("The bindingId to detach"),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async (args) => {
    try {
      const res = detachWorkspaceBinding(args.bindingId);
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `[${res.errorCode}] ${res.message}`,
            },
          ],
          structuredContent: {
            errorCode: res.errorCode,
            message: res.message,
            workspaceId: null,
            displayName: null,
            rootFingerprint: null,
            workspaceResolution: "binding",
          },
        };
      }

      const payload = {
        ...res.data,
        workspaceResolution: "binding" as const,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Đã hủy gắn kết binding ${res.data.bindingId} khỏi workspace '${res.data.displayName}'.`,
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    } catch (err: unknown) {
      return formatInternalError("detach workspace binding", err);
    }
  }
);

// Tool 6: project_memory_status
server.registerTool(
  "project_memory_status",
  {
    description:
      "Inspect configuration, logical record availability, active task state, and archive count of private Project Memory",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (args) => {
    try {
      const result = resolveProjectMemoryStatus({
        workspaceBindingId: args?.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("kiểm tra trạng thái Project Memory", err);
    }
  }
);

// Tool 7: initialize_project_memory
server.registerTool(
  "initialize_project_memory",
  {
    description:
      "Initialize private Project Memory records in the bound or environment-configured workspace",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async (args) => {
    try {
      const result = initializeProjectMemory(undefined, {
        workspaceBindingId: args?.workspaceBindingId,
      });

      if (!result.success) {
        const errorCode = result.errorCode || "INITIALIZATION_FAILED";
        const message =
          result.errorMessage ||
          "Không thể khởi tạo Project Memory. Vui lòng kiểm tra workspaceBindingId hoặc biến môi trường MCP_WORKSPACE_ROOT.";
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `[${errorCode}] ${message}`,
            },
          ],
          structuredContent: {
            errorCode,
            message,
            created: result.created,
            alreadyExisted: result.alreadyExisted,
            errors: result.errors,
            workspaceId: result.workspaceId,
            displayName: result.displayName,
            rootFingerprint: result.rootFingerprint,
            workspaceResolution: result.workspaceResolution,
          },
        };
      }

      const summaryText = `Khởi tạo Project Memory thành công (workspace: ${result.displayName}): ${result.created.length} file tạo mới, ${result.alreadyExisted.length} file đã tồn tại.`;

      return {
        content: [
          {
            type: "text" as const,
            text: summaryText,
          },
        ],
        structuredContent: {
          created: result.created,
          alreadyExisted: result.alreadyExisted,
          errors: result.errors,
          workspaceId: result.workspaceId,
          displayName: result.displayName,
          rootFingerprint: result.rootFingerprint,
          workspaceResolution: result.workspaceResolution,
        },
      };
    } catch (err: unknown) {
      return formatInternalError("khởi tạo Project Memory", err);
    }
  }
);

// Tool 8: save_approved_plan
server.registerTool(
  "save_approved_plan",
  {
    description:
      "Save a user-approved structured plan into private Project Memory without overwriting an existing approved plan",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
      taskId: z
        .string()
        .min(1)
        .max(100)
        .describe("Task ID (1-100 ký tự, không chứa path separator hoặc '..')"),
      objective: z
        .string()
        .min(1)
        .max(2000)
        .describe("Mục tiêu nhiệm vụ (1-2000 ký tự)"),
      planSteps: z
        .array(z.string().min(1).max(2000))
        .min(1)
        .max(50)
        .describe("Các bước thực hiện (1-50 phần tử, mỗi phần tử tối đa 2000 ký tự)"),
      acceptanceCriteria: z
        .array(z.string().min(1).max(2000))
        .min(1)
        .max(50)
        .describe("Tiêu chí nghiệm thu (1-50 phần tử)"),
      constraints: z
        .array(z.string().min(1).max(2000))
        .max(30)
        .describe("Các ràng buộc (0-30 phần tử)"),
      approvedByUser: z
        .boolean()
        .describe("Chỉ cho phép lưu khi approvedByUser đúng bằng true"),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const result = saveApprovedPlan(args, undefined, {
        workspaceBindingId: args.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("lưu kế hoạch đã duyệt", err);
    }
  }
);

// Tool 9: checkpoint_task
server.registerTool(
  "checkpoint_task",
  {
    description:
      "Update private task state with optimistic revision control when taskId matches the approved plan",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
      taskId: z.string().min(1).max(100).describe("Task ID trùng với APPROVED_PLAN.md"),
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .describe("Revision hiện tại của TASK_STATE.md (integer >= 0)"),
      status: z
        .enum(["planned", "in_progress", "blocked", "review", "completed"])
        .describe("Trạng thái hiện tại của nhiệm vụ"),
      objective: z.string().min(1).max(2000).describe("Mục tiêu nhiệm vụ"),
      acceptanceCriteria: z.array(z.string()).describe("Tiêu chí nghiệm thu"),
      completed: z.array(z.string()).describe("Các bước đã hoàn thành"),
      currentState: z.string().min(1).max(4000).describe("Trạng thái triển khai hiện tại"),
      nextSteps: z.array(z.string()).describe("Các bước tiếp theo"),
      changedFiles: z
        .array(z.string())
        .describe("Danh sách relative project path đã thay đổi"),
      tests: z
        .array(
          z.object({
            command: z.string(),
            status: z.enum(["passed", "failed", "not_run"]),
            result: z.string(),
          })
        )
        .describe("Danh sách kết quả kiểm thử"),
      blockers: z.array(z.string()).describe("Các vướng mắc"),
      openQuestions: z.array(z.string()).describe("Các câu hỏi mở"),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const result = checkpointTask(args, undefined, {
        workspaceBindingId: args.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("checkpoint trạng thái nhiệm vụ", err);
    }
  }
);

// Tool 10: resume_task
server.registerTool(
  "resume_task",
  {
    description:
      "Read-only recovery of Project Memory context. Always prefer detailLevel='compact' (default) to minimize context usage; do NOT use 'full' by default—only use 'full' when explicitly requested by the user, investigating state inconsistencies, or when 'compact' is insufficient.",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
      detailLevel: z
        .enum(["compact", "full"])
        .optional()
        .default("compact")
        .describe(
          "Mức độ chi tiết ('compact' | 'full', mặc định 'compact'). Ưu tiên dùng 'compact'; chỉ dùng 'full' khi cần thiết."
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (args) => {
    try {
      const detailLevel = args?.detailLevel ?? "compact";
      const result = resumeTask(undefined, {
        detailLevel,
        workspaceBindingId: args?.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("khôi phục ngữ cảnh nhiệm vụ", err);
    }
  }
);

// Tool 11: prepare_handoff
server.registerTool(
  "prepare_handoff",
  {
    description:
      "Generate a private handoff snapshot from approved plan and task state with optimistic revision check",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .describe("Revision hiện tại của TASK_STATE.md (integer >= 0)"),
      reason: z
        .enum(["context_switch", "end_session", "manual"])
        .describe("Lý do chuẩn bị handoff"),
      nextExactAction: z
        .string()
        .min(1)
        .max(2000)
        .describe("Hành động chính xác tiếp theo (1-2000 ký tự)"),
      doNotRedo: z
        .array(z.string().min(1).max(2000))
        .max(30)
        .describe("Danh sách các việc không được làm lại (tối đa 30 phần tử)"),
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const result = prepareHandoff(args, undefined, {
        workspaceBindingId: args.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("chuẩn bị handoff", err);
    }
  }
);

// Tool 12: archive_completed_task
server.registerTool(
  "archive_completed_task",
  {
    description:
      "Close and archive the current completed task inside private Project Memory. Only call this tool AFTER the user explicitly confirms task completion (userConfirmed: true). This operation closes the current task and resets its current plan, state, and handoff records after archiving succeeds.",
    inputSchema: {
      workspaceBindingId: workspaceBindingIdSchema,
      taskId: z
        .string()
        .min(1)
        .max(100)
        .describe("Task ID hiện tại (phải khớp APPROVED_PLAN.md và TASK_STATE.md)"),
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .describe("Revision hiện tại của TASK_STATE.md (integer >= 0)"),
      userConfirmed: z
        .boolean()
        .describe("Phải đúng bằng true: chỉ thực hiện sau khi user xác nhận hoàn tất"),
      completionSummary: z
        .string()
        .min(1)
        .max(4000)
        .describe("Tóm tắt hoàn thành nhiệm vụ (1-4000 ký tự)"),
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async (args) => {
    try {
      const result = archiveCompletedTask(args, undefined, {
        workspaceBindingId: args.workspaceBindingId,
      });
      return formatWorkflowToolResult(result);
    } catch (err: unknown) {
      return formatInternalError("archive nhiệm vụ đã hoàn thành", err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Dual-Agent Workflow Gateway running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error starting Dual-Agent Workflow Gateway:", error);
  process.exit(1);
});
