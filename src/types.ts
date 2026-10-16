export type Language = "javascript" | "typescript" | "python";
export type Scope = "project" | "global";

export interface ScriptRecord {
  id: string;
  name: string;
  description: string;
  language: Language;
  input_schema: string; // JSON string
  file_path: string;
  scope: Scope;
  created_at: string;
  updated_at: string;
}

export interface ScriptMeta {
  name: string;
  description: string;
  language: Language;
  input_schema: Record<string, unknown>;
  scope: Scope;
  file_path: string;
  created_at: string;
  updated_at: string;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
  exit_code: number | null;
  timed_out?: boolean;
  truncated?: boolean;
}

export const NAME_RE = /^[a-z0-9_]+$/;
export const MAX_OUTPUT_CHARS = 8192;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function extForLanguage(language: Language): string {
  switch (language) {
    case "javascript":
      return "js";
    case "typescript":
      return "ts";
    case "python":
      return "py";
  }
}

export function toMeta(r: ScriptRecord): ScriptMeta {
  let schema: Record<string, unknown> = { type: "object", properties: {} };
  try {
    const parsed = JSON.parse(r.input_schema);
    if (parsed && typeof parsed === "object") schema = parsed;
  } catch {
    /* keep default */
  }
  return {
    name: r.name,
    description: r.description,
    language: r.language,
    input_schema: schema,
    scope: r.scope,
    file_path: r.file_path,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Ensure a stored schema is a valid MCP-compatible object schema. */
export function normalizeSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  const s = { ...(raw as Record<string, unknown>) };
  if (s.type !== "object") s.type = "object";
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}
