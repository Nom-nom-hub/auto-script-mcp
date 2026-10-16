#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Registry } from "./registry.js";
import { createServer } from "./server.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";

function parseArgs(argv: string[]): { projectDir?: string; globalDir?: string; timeoutMs?: number } {
  const out: { projectDir?: string; globalDir?: string; timeoutMs?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-dir") out.projectDir = argv[++i];
    else if (a === "--global-dir") out.globalDir = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.error(
        "Usage: auto-script-mcp [--project-dir <path>] [--global-dir <path>] [--timeout-ms <n>]\n" +
          "Env: AUTO_SCRIPT_PROJECT_DIR, AUTO_SCRIPT_GLOBAL_DIR, AUTO_SCRIPT_TIMEOUT_MS, PYTHON_BIN",
      );
      process.exit(0);
    }
  }
  if (out.timeoutMs === undefined && process.env.AUTO_SCRIPT_TIMEOUT_MS) {
    const n = Number(process.env.AUTO_SCRIPT_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const registry = new Registry({
    projectDir: opts.projectDir,
    globalDir: opts.globalDir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const server = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel.
  console.error(
    `auto-script-mcp ready · ${registry.listAll().length} script(s) registered · project=${registry.project.baseDir} · global=${registry.global.baseDir}`,
  );
}

main().catch((err) => {
  console.error("auto-script-mcp fatal:", err);
  process.exit(1);
});
