import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Registry } from "./registry.js";
import { normalizeSchema } from "./types.js";
import type { Language, Scope } from "./types.js";

export const INSTRUCTIONS = `You have access to auto-script-mcp, a self-generating script registry.

Rules:
1. Always review the registered script_* tools before executing multi-file, batch, or repetitive operations yourself. If a script_* tool matches the task, call it instead of doing the work token-by-token.
2. If NO script matches the current task and the task is repetitive, bulk, or likely to recur:
   a. Write a reusable script (JavaScript, TypeScript, or Python) that takes its inputs as a JSON object.
   b. Script contract: arguments arrive as a JSON string in argv[2], on stdin, and in the SCRIPT_ARGS_JSON env var. Parse one of those. Print results to stdout. Exit 0 on success, non-zero on failure.
   c. Test the script locally if you can, then persist it with the save_script tool. It immediately becomes a native script_<name> tool for this and all future sessions.
   d. Then call the new script_<name> tool to do the actual work.
3. Prefer project scope (default) for repo-specific scripts and global scope only for utilities that apply everywhere.
4. Keep scripts deterministic and single-purpose. Put the "when to use this" guidance in the save_script description — that is what future agents read to decide.`;

const SAVE_SCRIPT_TOOL: Tool = {
  name: "save_script",
  description:
    "Register a newly authored script into the registry. The script is syntax-validated, written to disk, indexed in SQLite, and IMMEDIATELY exposed as a native script_<name> tool (tools/list_changed is emitted). Use this when you have written and tested a reusable script for a repetitive task no existing script_* tool covers.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "snake_case identifier, e.g. batch_json_transform. Must match ^[a-z0-9_]+$",
      },
      description: {
        type: "string",
        description: "Concise summary of what the script does AND when to invoke it.",
      },
      language: {
        type: "string",
        enum: ["javascript", "typescript", "python"],
        description: "Script language.",
      },
      input_schema: {
        type: "object",
        description: "Valid JSON Schema object describing the script's arguments.",
      },
      code: { type: "string", description: "Full source code of the script." },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "project = .scripts/ in the current repo (default). global = ~/.config/auto-script-mcp/scripts/",
      },
    },
    required: ["name", "description", "language", "input_schema", "code"],
  },
};

const LIST_SCRIPTS_TOOL: Tool = {
  name: "list_scripts",
  description:
    "List every registered script (both scopes) with its description, language, and input schema. Check this before writing a new script — one may already exist under a script_<name> tool.",
  inputSchema: { type: "object", properties: {} },
};

const DELETE_SCRIPT_TOOL: Tool = {
  name: "delete_script",
  description: "Remove a registered script (file + index entry) and unmount its script_<name> tool.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Script name without the script_ prefix." },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Optional. If omitted, project is tried first, then global.",
      },
    },
    required: ["name"],
  },
};

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

export function createServer(registry: Registry): Server {
  const server = new Server(
    { name: "auto-script-mcp", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, prompts: {} },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dynamic: Tool[] = registry.listAll().map((s) => ({
      name: `script_${s.name}`,
      description: `${s.description} [auto-script-mcp · ${s.language} · ${s.scope}]`,
      inputSchema: normalizeSchema(s.input_schema) as Tool["inputSchema"],
    }));
    return { tools: [SAVE_SCRIPT_TOOL, LIST_SCRIPTS_TOOL, DELETE_SCRIPT_TOOL, ...dynamic] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "save_script") {
        const a = (args ?? {}) as Record<string, unknown>;
        const meta = await registry.save({
          name: String(a.name ?? ""),
          description: String(a.description ?? ""),
          language: a.language as Language,
          input_schema: (a.input_schema ?? {}) as Record<string, unknown>,
          code: String(a.code ?? ""),
          scope: (a.scope as Scope | undefined) ?? undefined,
        });
        // Dynamic registration: tell the client the tool list changed NOW.
        await server.notification({ method: "notifications/tools/list_changed" });
        return jsonResult({
          success: true,
          tool: `script_${meta.name}`,
          scope: meta.scope,
          file_path: meta.file_path,
          message: `Registered. Call it as script_${meta.name}.`,
        });
      }

      if (name === "list_scripts") {
        return jsonResult({ scripts: registry.listAll() });
      }

      if (name === "delete_script") {
        const a = (args ?? {}) as Record<string, unknown>;
        const removed = registry.remove(String(a.name ?? ""), a.scope as Scope | undefined);
        if (removed) await server.notification({ method: "notifications/tools/list_changed" });
        return jsonResult({ success: removed, name: a.name });
      }

      if (name.startsWith("script_")) {
        const scriptName = name.slice("script_".length);
        const result = await registry.run(scriptName, (args ?? {}) as Record<string, unknown>);
        return jsonResult(result, !result.success);
      }

      return jsonResult({ success: false, error: `Unknown tool: ${name}` }, true);
    } catch (err) {
      return jsonResult(
        { success: false, error: err instanceof Error ? err.message : String(err) },
        true,
      );
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "auto-script-instructions",
        description:
          "Execution instructions for using the auto-script-mcp registry: check script_* tools first, generate + save a script when none matches.",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== "auto-script-instructions") {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    return {
      description: "auto-script-mcp execution instructions",
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: INSTRUCTIONS } },
      ],
    };
  });

  return server;
}
