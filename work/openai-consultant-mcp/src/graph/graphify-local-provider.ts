import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GitWorkspaceState, GraphQueryResult, GraphStatus } from "./types.js";

const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
const DEFAULT_QUERY_TIMEOUT_MS = 20_000;
const SENSITIVE_ENV = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "NEO4J_PASSWORD", "FALKORDB_PASSWORD",
];

export const GRAPHIFY_EXCLUDES = [
  ".ai", ".ai/**", ".env", ".env.*", "*.pem", "*.key", "*.p12",
  "*credential*", "*credentials*", "*secret*", "node_modules", "dist",
  "build", "coverage", ".cache", ".git", ".venv", "venv", "env",
  "__pycache__", "graphify-out", "*.sqlite", "*.db",
];

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
}

export interface GraphBuildResult {
  ok: boolean;
  graphPath: string;
  revision: string | null;
  durationMs: number;
  updatedIncrementally: boolean;
  fallbackReason: string | null;
}

export interface GraphProvider {
  getStatus(workspaceRoot: string, graphDir: string, git: GitWorkspaceState, cachedRevision: string | null): GraphStatus;
  buildOrUpdate(workspaceRoot: string, graphDir: string, git: GitWorkspaceState, cachedRevision: string | null): GraphBuildResult;
  query(graphPath: string, question: string, budgetTokens: number, depth: number, maxFiles: number): GraphQueryResult;
  findSymbols(result: GraphQueryResult): string[];
  rankFiles(result: GraphQueryResult, maxFiles: number): string[];
  findDependencies(result: GraphQueryResult): string[];
  suggestTests(result: GraphQueryResult): string[];
}

export function parseGraphifyQueryOutput(
  text: string,
  maxFiles: number,
  durationMs = 0,
  truncated = false
): GraphQueryResult {
  const extension = "(?:ts|tsx|js|jsx|py|java|go|rs|cs|cpp|c|h|rb|php|vue|svelte)";
  const sourceFields = [...text.matchAll(new RegExp(`\\bsrc=([^\\s\\]]+\\.${extension})`, "gimu"))]
    .map((match) => match[1].replace(/\\/g, "/"));
  const nodeFiles = [...text.matchAll(new RegExp(`^NODE\\s+([^\\s\\[]+\\.${extension})(?:\\s|$)`, "gimu"))]
    .map((match) => match[1].replace(/\\/g, "/"));
  const genericFiles = [...text.matchAll(new RegExp(`(?:^|\\s)([\\w./\\\\-]+\\.${extension})(?:[:\\s]|$)`, "gimu"))]
    .map((match) => match[1].replace(/\\/g, "/"));
  const rankedCandidates = sourceFields.length > 0 ? sourceFields : [...nodeFiles, ...genericFiles];
  const rankedFiles = [...new Set(rankedCandidates)].slice(0, maxFiles);
  const colonSymbols = [...text.matchAll(/(?:Node|Symbol|Function|Class|Method):\s*([^\r\n]{1,120})/giu)]
    .map((match) => match[1].trim());
  const nodeSymbols = [...text.matchAll(/^NODE\s+(.+?)\s+\[src=/gimu)]
    .map((match) => match[1].trim())
    .filter((label) => !new RegExp(`\\.${extension}$`, "iu").test(label));
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const dependencies = lines.filter((line) => /-->|<--|\s--(?:calls|imports|imports_from|contains|depends|uses)\s|calls|depends|uses/iu.test(line)).slice(0, 20);
  const tests = rankedFiles.filter((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|\.)|\.test\.|\.spec\./iu.test(file));
  return {
    text,
    symbols: [...new Set([...colonSymbols, ...nodeSymbols])].slice(0, 20),
    rankedFiles,
    dependencyPaths: dependencies,
    relevantTests: tests,
    durationMs,
    truncated,
  };
}

function discoverGraphifyCommand(): string {
  const configured = process.env.GRAPHIFY_COMMAND?.trim();
  if (configured) return configured;
  if (process.platform !== "win32" || !process.env.APPDATA) return "graphify";
  const pythonUserRoot = path.join(process.env.APPDATA, "Python");
  try {
    const candidates = fs.readdirSync(pythonUserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name))
      .map((entry) => path.join(pythonUserRoot, entry.name, "Scripts", "graphify.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .reverse();
    return candidates[0] ?? "graphify";
  } catch {
    return "graphify";
  }
}

export class GraphifyLocalProvider implements GraphProvider {
  private readonly command: string;

  constructor(command = discoverGraphifyCommand()) {
    if (command.includes("\0")) throw new Error("Invalid Graphify command.");
    this.command = command;
  }

  private localEnvironment(graphDir?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GRAPHIFY_DISABLE_CLOUD: "1",
      GRAPHIFY_BACKEND: "none",
      GRAPHIFY_QUERY_LOG_DISABLE: "1",
    };
    for (const key of SENSITIVE_ENV) delete env[key];
    if (graphDir) env.GRAPHIFY_OUT = graphDir;
    return env;
  }

  private run(args: string[], cwd: string, timeoutMs: number, graphDir?: string): CommandResult {
    const started = Date.now();
    const result = spawnSync(this.command, args, {
      cwd,
      env: this.localEnvironment(graphDir),
      encoding: "utf-8",
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    return {
      ok: !error && result.status === 0,
      stdout: String(result.stdout ?? "").slice(0, MAX_PROCESS_OUTPUT_BYTES),
      stderr: String(result.stderr ?? "").slice(0, MAX_PROCESS_OUTPUT_BYTES),
      durationMs: Date.now() - started,
      timedOut: error?.code === "ETIMEDOUT",
      exitCode: result.status,
    };
  }

  private version(): string | null {
    if (process.env.DAGW_GRAPHIFY_ENABLED === "0") return null;
    const result = this.run(["--version"], process.cwd(), 5_000);
    return result.ok ? (result.stdout || result.stderr).trim().slice(0, 120) : null;
  }

  getStatus(_workspaceRoot: string, graphDir: string, git: GitWorkspaceState, cachedRevision: string | null): GraphStatus {
    const providerVersion = this.version();
    const graphExists = fs.existsSync(path.join(graphDir, "graph.json"));
    const revisionMatched = Boolean(graphExists && git.commitSha && cachedRevision === git.commitSha);
    return {
      available: providerVersion !== null,
      graphExists,
      graphRevision: graphExists ? cachedRevision : null,
      revisionMatched,
      providerVersion,
      mode: providerVersion ? "graph_first" : "degraded",
      fallbackReason: providerVersion ? null : "GRAPHIFY_UNAVAILABLE",
    };
  }

  buildOrUpdate(workspaceRoot: string, graphDir: string, git: GitWorkspaceState, cachedRevision: string | null): GraphBuildResult {
    const graphPath = path.join(graphDir, "graph.json");
    if (!this.version()) return { ok: false, graphPath, revision: null, durationMs: 0, updatedIncrementally: false, fallbackReason: "GRAPHIFY_UNAVAILABLE" };
    fs.mkdirSync(graphDir, { recursive: true });
    const exists = fs.existsSync(graphPath);
    if (exists && git.commitSha && cachedRevision === git.commitSha) {
      return { ok: true, graphPath, revision: cachedRevision, durationMs: 0, updatedIncrementally: false, fallbackReason: null };
    }
    const excludes = GRAPHIFY_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
    const args = exists
      ? ["update", workspaceRoot, "--no-cluster", ...excludes]
      : ["extract", workspaceRoot, "--code-only", "--no-cluster", ...excludes];
    const result = this.run(args, workspaceRoot, DEFAULT_BUILD_TIMEOUT_MS, graphDir);
    const produced = fs.existsSync(graphPath);
    return {
      ok: result.ok && produced,
      graphPath,
      revision: result.ok && produced ? git.commitSha : null,
      durationMs: result.durationMs,
      updatedIncrementally: exists,
      fallbackReason: result.ok && produced ? null : result.timedOut ? "GRAPHIFY_TIMEOUT" : "GRAPHIFY_BUILD_FAILED",
    };
  }

  query(graphPath: string, question: string, budgetTokens: number, depth: number, maxFiles: number): GraphQueryResult {
    const cleanQuestion = question.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 8_000);
    const result = this.run(
      ["query", cleanQuestion, "--graph", graphPath, "--budget", String(budgetTokens), "--depth", String(depth)],
      path.dirname(graphPath),
      DEFAULT_QUERY_TIMEOUT_MS
    );
    const text = result.ok ? result.stdout.slice(0, budgetTokens * 4) : "";
    return parseGraphifyQueryOutput(text, maxFiles, result.durationMs, result.stdout.length > text.length);
  }

  findSymbols(result: GraphQueryResult): string[] { return result.symbols; }
  rankFiles(result: GraphQueryResult, maxFiles: number): string[] { return result.rankedFiles.slice(0, maxFiles); }
  findDependencies(result: GraphQueryResult): string[] { return result.dependencyPaths; }
  suggestTests(result: GraphQueryResult): string[] { return result.relevantTests; }
}

