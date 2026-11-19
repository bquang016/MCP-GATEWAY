import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PublicWorkspaceInfo,
  RegistryOptions,
  RegistryResult,
  registerWorkspaceFromHook,
} from "./registry/workspace-registry.js";
import { listActionableExecutionRequestsForWorkspace } from "./queue/execution-queue.js";

export interface CliExecutionResult {
  stdoutJson: string;
  stderrMessage: string;
  result: RegistryResult<PublicWorkspaceInfo>;
}

/**
 * Processes raw stdin JSON for `register-workspace` hook command.
 * Always produces valid JSON `{}` for Antigravity hook stdout contract,
 * logs diagnostic messages exclusively for stderr, and never throws.
 */
export function executeRegisterWorkspaceFromStdin(
  rawStdin: string,
  options?: RegistryOptions
): CliExecutionResult {
  const emptyHookStdoutJson = "{}\n";

  if (typeof rawStdin !== "string" || rawStdin.trim().length === 0) {
    const errResult: RegistryResult<PublicWorkspaceInfo> = {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: "Hook stdin rỗng.",
    };
    return {
      stdoutJson: emptyHookStdoutJson,
      stderrMessage: `[dual-agent-workflow-gateway] [INVALID_HOOK_PAYLOAD] ${errResult.message}\n`,
      result: errResult,
    };
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawStdin);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    const errResult: RegistryResult<PublicWorkspaceInfo> = {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: `Hook stdin không phải là JSON hợp lệ: ${detail}`,
    };
    return {
      stdoutJson: emptyHookStdoutJson,
      stderrMessage: `[dual-agent-workflow-gateway] [INVALID_HOOK_PAYLOAD] ${errResult.message}\n`,
      result: errResult,
    };
  }

  try {
    const result = registerWorkspaceFromHook(parsedPayload, options);
    if (!result.ok) {
      return {
        stdoutJson: emptyHookStdoutJson,
        stderrMessage: `[dual-agent-workflow-gateway] [${result.errorCode}] ${result.message}\n`,
        result,
      };
    }

    const payload = parsedPayload as { hookEventName?: unknown };
    const actionable = listActionableExecutionRequestsForWorkspace(
      result.data.workspaceId,
      options
    );
    if (!actionable.ok || actionable.data.requests.length === 0) {
      return {
        stdoutJson: emptyHookStdoutJson,
        stderrMessage: `[dual-agent-workflow-gateway] Registered normal workspace '${result.data.displayName}' (${result.data.workspaceId}); no actionable execution request.\n`,
        result,
      };
    }

    const queueMessage = actionable.data.requests
      .map((request) =>
        request.status === "pending_user_start"
          ? `Execution request ${request.requestId} cho task '${request.taskId}' đang chờ người dùng xác nhận Start. Hãy trình bày objective và hỏi xác nhận; tuyệt đối không tự đặt userConfirmedStart=true.`
          : `Execution request ${request.requestId} cho task '${request.taskId}' có trạng thái '${request.status}' (revision ${request.revision}).`
      )
      .join("\n");
    const systemMessage =
      `Dual-Agent Mode đã được kích hoạt cho workspace '${result.data.displayName}' vì có execution request thực sự. ` +
      "Gọi start_work_session đúng một lần, xử lý queue theo HITL và không trộn với yêu cầu chat trực tiếp. " +
      queueMessage;
    const hookStdoutJson = JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage,
            metadata: {
              source: "dual-agent-bridge",
              hookEventName: String(payload.hookEventName ?? "unknown"),
            },
          },
        },
      ],
    }) + "\n";

    return {
      stdoutJson: hookStdoutJson,
      stderrMessage: `[dual-agent-workflow-gateway] Registered active workspace '${result.data.displayName}' (${result.data.workspaceId}) until ${result.data.leaseExpiresAt}\n`,
      result,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    const errResult: RegistryResult<PublicWorkspaceInfo> = {
      ok: false,
      errorCode: "INVALID_HOOK_PAYLOAD",
      message: `Lỗi không mong đợi khi xử lý hook payload: ${detail}`,
    };
    return {
      stdoutJson: emptyHookStdoutJson,
      stderrMessage: `[dual-agent-workflow-gateway] [INVALID_HOOK_PAYLOAD] ${errResult.message}\n`,
      result: errResult,
    };
  }
}

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function runCli(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand !== "register-workspace") {
    process.stderr.write(
      `[dual-agent-workflow-gateway] Unknown or missing CLI command: ${String(
        subcommand ?? ""
      )}. Expected: register-workspace\n`
    );
    process.stdout.write("{}\n");
    return;
  }

  let rawStdin = "";
  try {
    rawStdin = await readStdinAll();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[dual-agent-workflow-gateway] Failed reading stdin: ${detail}\n`
    );
    process.stdout.write("{}\n");
    return;
  }

  const execResult = executeRegisterWorkspaceFromStdin(rawStdin);
  if (execResult.stderrMessage) {
    process.stderr.write(execResult.stderrMessage);
  }
  process.stdout.write(execResult.stdoutJson);
}

const isMainModule = (() => {
  try {
    if (!process.argv[1]) {
      return false;
    }
    const entryUrl = pathToFileURL(path.resolve(process.argv[1])).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCli().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[dual-agent-workflow-gateway] Unhandled CLI error: ${detail}\n`
    );
    process.stdout.write("{}\n");
  });
}

