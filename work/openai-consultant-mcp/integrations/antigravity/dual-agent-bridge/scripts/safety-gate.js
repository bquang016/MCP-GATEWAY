#!/usr/bin/env node
import process from "node:process";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

const destructivePatterns = [
  /\brm\s+[^\r\n]*(?:-rf|-fr|--recursive)/i,
  /\bremove-item\b[^\r\n]*(?:-recurse|-force)/i,
  /\b(?:rmdir|rd|del)\b[^\r\n]*(?:\/s|\/q)/i,
  /\b(?:format|diskpart|clear-disk|initialize-disk)\b/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|push\s+[^\r\n]*--force)/i,
  /\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i,
  /\b(?:shutdown|restart-computer|stop-computer)\b/i,
  /\breg(?:\.exe)?\s+(?:delete|add)\b/i,
];

try {
  const payload = JSON.parse(await readStdin());
  const args = payload?.toolCall?.args ?? {};
  const command = String(
    args.CommandLine ?? args.commandLine ?? args.command ?? args.cmd ?? ""
  );
  const isDestructive = destructivePatterns.some((pattern) => pattern.test(command));
  const result = isDestructive
    ? {
        decision: "force_ask",
        reason:
          "Dual-Agent HITL: lệnh có dấu hiệu destructive/system-wide. Hãy kiểm tra command, target, ảnh hưởng và khả năng khôi phục trước khi cho phép.",
      }
    : {
        decision: "ask",
        reason:
          "Dual-Agent HITL: terminal command cần quyền native của Antigravity; có thể dùng Always Allow cho lệnh an toàn quen thuộc.",
      };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `[dual-agent-bridge] safety-gate parse error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ decision: "force_ask", reason: "Không phân tích được terminal command; yêu cầu người dùng kiểm tra thủ công." })}\n`
  );
}
