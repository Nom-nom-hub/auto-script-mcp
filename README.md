# auto-script-mcp

**Self-generating, zero-token script registry and execution middleware for AI coding agents.**

When AI coding agents (Cline, Roo Code, Cursor, Continue) do multi-step file manipulation, data processing, or batch operations, they burn tokens and latency doing work a local script could do in one shot. `auto-script-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that acts as a deterministic execution layer:

- Every saved script is exposed to the agent as a **native MCP tool** — `script_<name>` — with a real JSON Schema for its arguments.
- When no existing script fits a repetitive task, the agent writes one, and persists it with the built-in **`save_script`** tool. The new tool is mounted **live** (`notifications/tools/list_changed`) — no server restart, and it survives into every future session.
- Execution happens in a local subprocess (Node.js / TypeScript / Python). The agent pays tokens for one tool call instead of the whole operation.

```
┌────────────────────────────────┐
│  Client AI Agent (VS Code)     │
│ (Cline, Roo, Cursor, Continue) │
└───────────────┬────────────────┘
                │ JSON-RPC over stdio
                ▼
┌──────────────────────────────────────────────────────────┐
│                   auto-script-mcp Server                 │
│  Dynamic Tool Registry          Built-in MCP Tools       │
│   └─ script_<script_name>        ├─ save_script          │
│                                  ├─ list_scripts         │
│                                  └─ delete_script        │
└────────┬───────────────────────────────┬─────────────────┘
         ▼                               ▼
  Exec Subprocess                 Storage Layer
  (Node.js / Python,              - SQLite index (index.db)
   timeout + truncation)          - Local `.scripts/` files
```

## Quick start

```bash
npm install -g auto-script-mcp   # or run from a clone: npm install && npm run build
```

### Wire it into your agent

**Cline / Roo Code** (`mcpServers` in settings):

```json
{
  "mcpServers": {
    "auto-script": {
      "command": "node",
      "args": ["/path/to/auto-script-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`) and **Continue** use the same `mcpServers` shape.

On connect, the server also serves its playbook as server `instructions` and as the **`auto-script-instructions`** prompt:

> Always review registered tools before executing multi-file operations. If no script matches the current task, create a reusable script, test it locally, and persist it via `save_script`.

## How it works

1. You ask for a repetitive or bulk task in VS Code.
2. The agent checks its tools — including every dynamic `script_*` tool.
3. **Match found** → agent calls `script_<name>(args)`; the server runs the subprocess and returns `{ success, stdout, stderr, duration_ms }`. Tokens saved.
4. **No match** → agent writes a script, verifies it locally, calls `save_script(...)`. The server syntax-checks it (dry-run), writes it to disk, indexes it in SQLite, emits `tools/list_changed`, and the new tool is available immediately — and on every future launch.

## Tools

### Built-in

| Tool | What it does |
| --- | --- |
| `save_script` | Validate + persist a script and mount it live as `script_<name>`. Params: `name` (snake_case), `description` (what it does **and when to use it**), `language` (`javascript` \| `typescript` \| `python`), `input_schema` (JSON Schema), `code`, `scope` (`project` default, or `global`). |
| `list_scripts` | List all registered scripts across both scopes with schemas. |
| `delete_script` | Remove a script's file + index entry and unmount its tool. |

### Dynamic — `script_<name>`

One per saved script. Accepts exactly the arguments in that script's `input_schema` and returns:

```json
{ "success": true, "stdout": "...", "stderr": "", "duration_ms": 42, "exit_code": 0 }
```

## The script contract

Scripts receive their arguments **three ways** — use whichever is natural:

1. `argv[2]` (JS/TS) / `sys.argv[1]` (Python) — a JSON string of the args object
2. **stdin** — the same JSON string
3. **`SCRIPT_ARGS_JSON`** environment variable

Print results to stdout; exit `0` on success, non-zero on failure. Examples in [`examples/`](examples/) (`batch_json_transform.js`, `sync_db_schema.py`).

## Storage

```
.scripts/                                  # project scope: <cwd>/.scripts/
├── index.db                               # SQLite metadata store
└── src/
    ├── batch_json_transform.js
    ├── sync_db_schema.py
    └── extract_tailwind_classes.ts

~/.config/auto-script-mcp/scripts/         # global scope, same layout
├── index.db
└── src/…
```

```sql
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
```

Project scope wins on a name collision. On boot the server scans both stores and mounts every script it finds.

## Safety & guardrails

- **Execution timeout** — subprocesses are killed after 30s by default (`--timeout-ms` flag or `AUTO_SCRIPT_TIMEOUT_MS` env to change; SIGTERM, then SIGKILL).
- **Path sanitization** — script names must match `^[a-z0-9_]+$`; no traversal, no separators.
- **Output truncation** — stdout/stderr returned to the agent are capped at 8 KB so a chatty script can't blow the context window it exists to protect. Capture is also hard-capped in memory.
- **Dry-run validation** — `save_script` parses/checks syntax (`node --check`, TypeScript compiler diagnostics, `py_compile`) **before** anything is written to disk. Invalid code never becomes a tool.
- Scripts run with your user's permissions, in the project cwd — same trust model as the agent's own terminal. Only save scripts you'd run yourself.

## Server options

```bash
auto-script-mcp [--project-dir <path>] [--global-dir <path>] [--timeout-ms <n>]
# Env equivalents: AUTO_SCRIPT_PROJECT_DIR, AUTO_SCRIPT_GLOBAL_DIR,
#                  AUTO_SCRIPT_TIMEOUT_MS, PYTHON_BIN
```

## Development

```bash
npm install
npm run build
npm test        # end-to-end: real MCP client ↔ server — save, mount, run (JS/TS/Python), persist, timeout, truncation, delete
```

## Roadmap

- HTTP transport (stdio today)
- Per-script permission prompts / allowlist for destructive scripts
- Script versioning + usage stats (which scripts actually save the most calls)
- Import/export packs of scripts between machines

## License

MIT © Andrew Edouard
