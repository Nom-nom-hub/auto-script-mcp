import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import ts from "typescript";
import type { Language } from "./types.js";

/**
 * Dry-run syntax validation (PRD §7). Throws Error with a readable message
 * on invalid syntax; resolves silently when the code parses.
 */
export async function validateSyntax(
  language: Language,
  code: string,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-script-validate-"));
  try {
    if (language === "javascript") {
      const file = path.join(tmp, "check.mjs");
      fs.writeFileSync(file, code, "utf8");
      await runCheck("node", ["--check", file]);
    } else if (language === "typescript") {
      const result = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
        fileName: "check.ts",
      });
      const errors = (result.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (errors.length > 0) {
        const msg = errors
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
          .join("; ");
        throw new Error(`TypeScript syntax error: ${msg}`);
      }
    } else if (language === "python") {
      const file = path.join(tmp, "check.py");
      fs.writeFileSync(file, code, "utf8");
      const python = process.env.PYTHON_BIN || "python3";
      await runCheck(python, ["-m", "py_compile", file]);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runCheck(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || "unknown error").toString().trim();
        reject(new Error(`Syntax validation failed: ${detail.slice(0, 1000)}`));
      } else {
        resolve();
      }
    });
  });
}
