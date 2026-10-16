import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Language, ExecResult } from "./types.js";
import { MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS } from "./types.js";

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
  return {
    text: s.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`,
    truncated: true,
  };
}

function resolveTsxBin(): string | null {
  try {
    // tsx package ships a CLI at <pkg>/dist/cli.mjs; resolve relative to this install
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } catch {
    /* fall through */
  }
  return null;
}

export function commandFor(
  language: Language,
  filePath: string,
): { cmd: string; args: string[] } {
  switch (language) {
    case "javascript":
      return { cmd: process.execPath, args: [filePath] };
    case "typescript": {
      const tsxBin = resolveTsxBin();
      if (tsxBin) return { cmd: process.execPath, args: [tsxBin, filePath] };
      return { cmd: "npx", args: ["--yes", "tsx", filePath] };
    }
    case "python":
      return { cmd: process.env.PYTHON_BIN || "python3", args: [filePath] };
  }
}

/**
 * Execute a saved script in a subprocess (PRD §3.3 / §7).
 * Arguments are passed three ways so scripts can use whichever is natural:
 *   1. argv[2]  — JSON string of the args object
 *   2. stdin    — same JSON string
 *   3. env      — SCRIPT_ARGS_JSON
 * Scripts print results to stdout; exit code 0 = success.
 */
export function executeScript(opts: {
  filePath: string;
  language: Language;
  args: Record<string, unknown>;
  timeoutMs?: number;
  cwd?: string;
}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const argsJson = JSON.stringify(opts.args ?? {});
  const { cmd, args } = commandFor(opts.language, opts.filePath);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, [...args, argsJson], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, SCRIPT_ARGS_JSON: argsJson },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2000).unref();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d) => {
      // Cap capture well above the return cap so a runaway script can't OOM us.
      if (stdout.length < MAX_OUTPUT_CHARS * 20) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 20) stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const errT = truncate(stderr || err.message);
      resolve({
        success: false,
        stdout: out.text,
        stderr: errT.text,
        duration_ms: Date.now() - started,
        exit_code: null,
        timed_out: timedOut,
        truncated: out.truncated || errT.truncated,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const errT = truncate(stderr);
      resolve({
        success: code === 0 && !timedOut,
        stdout: out.text,
        stderr: timedOut
          ? errT.text + `\n[auto-script-mcp] killed after ${timeoutMs}ms timeout`
          : errT.text,
        duration_ms: Date.now() - started,
        exit_code: code,
        timed_out: timedOut,
        truncated: out.truncated || errT.truncated,
      });
    });

    try {
      child.stdin.write(argsJson);
      child.stdin.end();
    } catch {
      /* stdin may be closed early by the script */
    }
  });
}
