#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const DEFAULT_HEARTBEAT_DEBOUNCE_MS = 5 * 60 * 1000;

function parseHookPayload(rawInput) {
  try {
    const parsed = JSON.parse(rawInput || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function resolveWorkspaceHint(payload) {
  const firstWorkspace = Array.isArray(payload?.workspacePaths)
    ? payload.workspacePaths.find(
        (value) => typeof value === "string" && value.trim().length > 0
      )
    : undefined;
  const candidate = firstWorkspace || payload?.cwd;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? path.resolve(candidate.trim())
    : null;
}

function heartbeatDebounceMs() {
  const configured = Number.parseInt(
    process.env.DAGW_HEARTBEAT_DEBOUNCE_MS || "",
    10
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_HEARTBEAT_DEBOUNCE_MS;
}

function heartbeatCachePath(workspaceHint) {
  const baseDir = process.env.DAGW_DATA_DIR?.trim()
    ? path.resolve(process.env.DAGW_DATA_DIR.trim())
    : process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA.trim(), "dual-agent-workflow-gateway")
      : path.join(os.homedir(), ".dual-agent-workflow-gateway");
  const key = crypto
    .createHash("sha256")
    .update(process.platform === "win32" ? workspaceHint.toLowerCase() : workspaceHint)
    .digest("hex")
    .slice(0, 24);
  return path.join(baseDir, "heartbeat-cache", `${key}.json`);
}

function shouldDebounceHeartbeat(payload, workspaceHint) {
  if (payload?.hookEventName !== "PreInvocation" || !workspaceHint) {
    return false;
  }
  const debounceMs = heartbeatDebounceMs();
  if (debounceMs === 0) {
    return false;
  }
  try {
    const cache = JSON.parse(
      fs.readFileSync(heartbeatCachePath(workspaceHint), "utf-8")
    );
    return (
      typeof cache.lastSuccessfulHeartbeatAt === "number" &&
      Date.now() - cache.lastSuccessfulHeartbeatAt >= 0 &&
      Date.now() - cache.lastSuccessfulHeartbeatAt < debounceMs
    );
  } catch {
    return false;
  }
}

function recordSuccessfulHeartbeat(workspaceHint) {
  if (!workspaceHint) {
    return;
  }
  const targetPath = heartbeatCachePath(workspaceHint);
  const parentDir = path.dirname(targetPath);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ lastSuccessfulHeartbeatAt: Date.now() }),
      "utf-8"
    );
    fs.renameSync(temporaryPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cache cleanup only. A cache failure must not block the hook.
    }
    process.stderr.write(
      `[dual-agent-bridge] Heartbeat cache update skipped: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

function resolveGatewayCliPath() {
  if (process.env.DAGW_CLI_PATH && process.env.DAGW_CLI_PATH.trim().length > 0) {
    const envPath = path.resolve(process.env.DAGW_CLI_PATH.trim());
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  const configPath = path.join(pluginRoot, "bridge-config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (typeof parsed.cliPath === "string" && parsed.cliPath.trim().length > 0) {
        const resolvedConfigCli = path.resolve(pluginRoot, parsed.cliPath.trim());
        if (fs.existsSync(resolvedConfigCli)) {
          return resolvedConfigCli;
        }
      }
    } catch (err) {
      process.stderr.write(
        `[dual-agent-bridge] Failed reading bridge-config.json: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  const repoRelativeCli = path.resolve(pluginRoot, "../../../dist/cli.js");
  if (fs.existsSync(repoRelativeCli)) {
    return repoRelativeCli;
  }

  return null;
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let rawInput = "";
  try {
    rawInput = await readStdinText();
  } catch (err) {
    process.stderr.write(
      `[dual-agent-bridge] Error reading stdin: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    process.stdout.write("{}\n");
    return;
  }

  const cliPath = resolveGatewayCliPath();
  if (!cliPath) {
    process.stderr.write(
      "[dual-agent-bridge] Gateway CLI (dist/cli.js) could not be resolved. Set DAGW_CLI_PATH or run scripts/install-plugin.js.\n"
    );
    process.stdout.write("{}\n");
    return;
  }

  const hookPayload = parseHookPayload(rawInput);
  const workspaceHint = resolveWorkspaceHint(hookPayload);
  if (shouldDebounceHeartbeat(hookPayload, workspaceHint)) {
    process.stdout.write("{}\n");
    return;
  }

  try {
    const child = spawnSync(
      process.execPath,
      [cliPath, "register-workspace"],
      {
        input: rawInput,
        encoding: "utf-8",
        timeout: 8000,
        env: process.env,
      }
    );

    if (child.stderr) {
      process.stderr.write(child.stderr);
    }

    if (
      child.status === 0 &&
      typeof child.stderr === "string" &&
      /Registered (?:active|normal) workspace/u.test(child.stderr)
    ) {
      recordSuccessfulHeartbeat(workspaceHint);
    }

    const trimmedStdout = (child.stdout || "").trim();
    if (trimmedStdout.length > 0) {
      try {
        JSON.parse(trimmedStdout);
        process.stdout.write(`${trimmedStdout}\n`);
        return;
      } catch {
        process.stderr.write(
          "[dual-agent-bridge] CLI returned non-JSON stdout; emitting fallback {}.\n"
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `[dual-agent-bridge] Failed invoking gateway CLI: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }

  process.stdout.write("{}\n");
}

main().catch((err) => {
  process.stderr.write(
    `[dual-agent-bridge] Unhandled error: ${
      err instanceof Error ? err.message : String(err)
    }\n`
  );
  process.stdout.write("{}\n");
});

