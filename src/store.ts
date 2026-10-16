import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Language, Scope, ScriptRecord } from "./types.js";
import { extForLanguage } from "./types.js";

/**
 * SQLite-backed metadata store for one scope.
 * Layout (per PRD §5):
 *   <baseDir>/index.db
 *   <baseDir>/src/<name>.<ext>
 */
export class ScriptStore {
  readonly baseDir: string;
  readonly srcDir: string;
  readonly scope: Scope;
  private db: Database.Database;

  constructor(baseDir: string, scope: Scope) {
    this.baseDir = baseDir;
    this.scope = scope;
    this.srcDir = path.join(baseDir, "src");
    fs.mkdirSync(this.srcDir, { recursive: true });
    const dbPath = path.join(baseDir, "index.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scripts (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        language TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  list(): ScriptRecord[] {
    return this.db
      .prepare("SELECT * FROM scripts ORDER BY name ASC")
      .all() as ScriptRecord[];
  }

  get(name: string): ScriptRecord | undefined {
    return this.db
      .prepare("SELECT * FROM scripts WHERE name = ?")
      .get(name) as ScriptRecord | undefined;
  }

  upsert(input: {
    name: string;
    description: string;
    language: Language;
    input_schema: Record<string, unknown>;
    file_path: string;
  }): ScriptRecord {
    const existing = this.get(input.name);
    const id = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scripts (id, name, description, language, input_schema, file_path, scope, created_at, updated_at)
         VALUES (@id, @name, @description, @language, @input_schema, @file_path, @scope, @created_at, @updated_at)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           language = excluded.language,
           input_schema = excluded.input_schema,
           file_path = excluded.file_path,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        name: input.name,
        description: input.description,
        language: input.language,
        input_schema: JSON.stringify(input.input_schema),
        file_path: input.file_path,
        scope: this.scope,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    return this.get(input.name)!;
  }

  remove(name: string): boolean {
    const rec = this.get(name);
    if (!rec) return false;
    this.db.prepare("DELETE FROM scripts WHERE name = ?").run(name);
    try {
      fs.unlinkSync(rec.file_path);
    } catch {
      /* file may already be gone */
    }
    return true;
  }

  filePathFor(name: string, language: Language): string {
    return path.join(this.srcDir, `${name}.${extForLanguage(language)}`);
  }

  close(): void {
    this.db.close();
  }
}
