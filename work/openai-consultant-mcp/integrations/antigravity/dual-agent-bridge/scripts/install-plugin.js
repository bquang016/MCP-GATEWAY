#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginSourceDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pluginSourceDir, "../../..");

/**
 * Installs the dual-agent-bridge plugin into a target directory and generates
 * bridge-config.json pointing to the local gateway dist/cli.js without hard-coding
 * machine-specific paths in the repository source files.
 */
export function renderBridgeConfig(gatewayCliPath) {
  return {
    schemaVersion: "1.0",
    cliPath: path.resolve(gatewayCliPath),
    generatedAt: new Date().toISOString(),
  };
}

export function installPluginToDirectory(targetPluginDir, customGatewayCliPath) {
  const cliPath = path.resolve(
    customGatewayCliPath ?? path.join(repoRoot, "dist", "cli.js")
  );
  const resolvedTarget = path.resolve(targetPluginDir);

  fs.mkdirSync(path.join(resolvedTarget, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(resolvedTarget, "rules"), { recursive: true });

  for (const fileName of ["plugin.json", "hooks.json", "README.md"]) {
    fs.copyFileSync(
      path.join(pluginSourceDir, fileName),
      path.join(resolvedTarget, fileName)
    );
  }

  for (const scriptName of ["session-start.js", "safety-gate.js", "install-plugin.js"]) {
    fs.copyFileSync(
      path.join(pluginSourceDir, "scripts", scriptName),
      path.join(resolvedTarget, "scripts", scriptName)
    );
  }

  fs.copyFileSync(
    path.join(pluginSourceDir, "rules", "AGENTS.md"),
    path.join(resolvedTarget, "rules", "AGENTS.md")
  );

  const bridgeConfig = renderBridgeConfig(cliPath);
  fs.writeFileSync(
    path.join(resolvedTarget, "bridge-config.json"),
    JSON.stringify(bridgeConfig, null, 2) + "\n",
    "utf-8"
  );

  return {
    installedTo: resolvedTarget,
    cliPath: bridgeConfig.cliPath,
  };
}

const isMain = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      path.resolve(process.argv[1]) === path.resolve(__filename)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const targetFlagIdx = args.indexOf("--target");
  const targetDir =
    targetFlagIdx >= 0 && args[targetFlagIdx + 1]
      ? args[targetFlagIdx + 1]
      : path.join(os.homedir(), ".gemini", "config", "plugins", "dual-agent-bridge");

  const result = installPluginToDirectory(targetDir);
  process.stderr.write(
    `[dual-agent-bridge] Installed plugin to ${result.installedTo} (cliPath=${result.cliPath})\n`
  );
}

