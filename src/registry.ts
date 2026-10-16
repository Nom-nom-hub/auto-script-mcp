import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptStore } from "./store.js";
import { validateSyntax } from "./validate.js";
import { executeScript } from "./executor.js";
import type { Language, Scope, ScriptMeta, ExecResult } from "./types.js";
import { NAME_RE, toMeta, normalizeSchema } from "./types.js";

export interface RegistryOptions {
  projectDir?: string; // default: <cwd>/.scripts
  globalDir?: string; // default: ~/.config/auto-script-mcp/scripts
  timeoutMs?: number;
}

export class Registry {
  readonly project: ScriptStore;
  readonly global: ScriptStore;
  readonly timeoutMs?: number;

  constructor(opts: RegistryOptions = {}) {
    const projectBase =
      opts.projectDir ??
      process.env.AUTO_SCRIPT_PROJECT_DIR ??
      path.join(process.cwd(), ".scripts");
    const globalBase =
      opts.globalDir ??
      process.env.AUTO_SCRIPT_GLOBAL_DIR ??
      path.join(os.homedir(), ".config", "auto-script-mcp", "scripts");
    this.project = new ScriptStore(projectBase, "project");
    this.global = new ScriptStore(globalBase, "global");
    this.timeoutMs = opts.timeoutMs;
  }

  private storeFor(scope: Scope): ScriptStore {
    return scope === "global" ? this.global : this.project;
  }

  /** All scripts. On a name collision the project scope wins (PRD: local first). */
  listAll(): ScriptMeta[] {
    const byName = new Map<string, ScriptMeta>();
    for (const r of this.global.list()) byName.set(r.name, toMeta(r));
    for (const r of this.project.list()) byName.set(r.name, toMeta(r));
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  find(name: string): { meta: ScriptMeta; store: ScriptStore } | undefined {
    const p = this.project.get(name);
    if (p) return { meta: toMeta(p), store: this.project };
    const g = this.global.get(name);
    if (g) return { meta: toMeta(g), store: this.global };
    return undefined;
  }

  async save(input: {
    name: string;
    description: string;
    language: Language;
    input_schema: Record<string, unknown>;
    code: string;
    scope?: Scope;
  }): Promise<ScriptMeta> {
    if (!NAME_RE.test(input.name)) {
      throw new Error(
        `Invalid script name "${input.name}": must match ^[a-z0-9_]+$ (snake_case, no spaces or path separators)`,
      );
    }
    if (!["javascript", "typescript", "python"].includes(input.language)) {
      throw new Error(
        `Unsupported language "${input.language}": use javascript, typescript, or python`,
      );
    }
    if (!input.description?.trim()) throw new Error("description is required");
    if (!input.code?.trim()) throw new Error("code is required");

    // Dry-run validation BEFORE writing anything to disk (PRD §7).
    await validateSyntax(input.language, input.code);

    const scope: Scope = input.scope ?? "project";
    const store = this.storeFor(scope);
    const filePath = store.filePathFor(input.name, input.language);

    // If an older version used a different language/extension, remove the stale file.
    const existing = store.get(input.name);
    if (existing && existing.file_path !== filePath) {
      try {
        fs.unlinkSync(existing.file_path);
      } catch {
        /* ignore */
      }
    }

    fs.writeFileSync(filePath, input.code, "utf8");
    const rec = store.upsert({
      name: input.name,
      description: input.description,
      language: input.language,
      input_schema: normalizeSchema(input.input_schema),
      file_path: filePath,
    });
    return toMeta(rec);
  }

  remove(name: string, scope?: Scope): boolean {
    if (scope) return this.storeFor(scope).remove(name);
    return this.project.remove(name) || this.global.remove(name);
  }

  async run(name: string, args: Record<string, unknown>): Promise<ExecResult> {
    const found = this.find(name);
    if (!found) throw new Error(`No script named "${name}" is registered`);
    if (!fs.existsSync(found.meta.file_path)) {
      throw new Error(
        `Script "${name}" is registered but its file is missing: ${found.meta.file_path}`,
      );
    }
    return executeScript({
      filePath: found.meta.file_path,
      language: found.meta.language,
      args,
      timeoutMs: this.timeoutMs,
    });
  }

  close(): void {
    this.project.close();
    this.global.close();
  }
}
