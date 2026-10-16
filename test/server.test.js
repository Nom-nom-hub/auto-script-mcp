// End-to-end tests driven through a real MCP client over in-memory transport,
// plus direct Registry/Executor unit coverage. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry } from "../dist/registry.js";
import { createServer } from "../dist/server.js";
import { executeScript } from "../dist/executor.js";

function tmpRegistry(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "asm-test-"));
  return {
    base,
    registry: new Registry({
      projectDir: path.join(base, "project"),
      globalDir: path.join(base, "global"),
      ...extra,
    }),
  };
}

async function connect(registry) {
  const server = createServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const ECHO_JS = `
const args = JSON.parse(process.argv[2] || "{}");
console.log(JSON.stringify({ echoed: args }));
`;

test("save_script registers a dynamic tool and it executes", async () => {
  const { registry } = tmpRegistry();
  const client = await connect(registry);

  let tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assert.ok(names.includes("save_script"));
  assert.ok(names.includes("list_scripts"));
  assert.ok(!names.includes("script_echo_args"));

  const save = await client.callTool({
    name: "save_script",
    arguments: {
      name: "echo_args",
      description: "Echo back the arguments it was called with.",
      language: "javascript",
      input_schema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      code: ECHO_JS,
    },
  });
  assert.equal(save.isError, false, JSON.stringify(save));

  tools = await client.listTools();
  assert.ok(tools.tools.map((t) => t.name).includes("script_echo_args"));

  const run = await client.callTool({
    name: "script_echo_args",
    arguments: { msg: "hello tokens saved" },
  });
  assert.equal(run.isError, false, JSON.stringify(run));
  const body = JSON.parse(run.content[0].text);
  assert.equal(body.success, true);
  assert.deepEqual(JSON.parse(body.stdout), { echoed: { msg: "hello tokens saved" } });
  assert.equal(typeof body.duration_ms, "number");
  await client.close();
  registry.close();
});

test("persistence: a new Registry over the same dirs sees saved scripts", async () => {
  const { base, registry } = tmpRegistry();
  await registry.save({
    name: "persisted_one",
    description: "Persistence probe.",
    language: "javascript",
    input_schema: { type: "object", properties: {} },
    code: "console.log('still here')",
  });
  registry.close();

  const again = new Registry({
    projectDir: path.join(base, "project"),
    globalDir: path.join(base, "global"),
  });
  assert.ok(again.listAll().some((s) => s.name === "persisted_one"));
  const res = await again.run("persisted_one", {});
  assert.equal(res.success, true);
  assert.match(res.stdout, /still here/);
  again.close();
});

test("python scripts save, validate and execute", async () => {
  const { registry } = tmpRegistry();
  await registry.save({
    name: "py_upper",
    description: "Uppercase the text argument.",
    language: "python",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    code: "import sys, json\nargs = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')\nprint(args.get('text','').upper())\n",
  });
  const res = await registry.run("py_upper", { text: "shout" });
  assert.equal(res.success, true, res.stderr);
  assert.match(res.stdout, /SHOUT/);
  registry.close();
});

test("typescript scripts save and execute via tsx", async () => {
  const { registry } = tmpRegistry();
  await registry.save({
    name: "ts_add",
    description: "Add two numbers.",
    language: "typescript",
    input_schema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
    code: "const args: {a?: number, b?: number} = JSON.parse(process.argv[2] || '{}');\nconsole.log((args.a ?? 0) + (args.b ?? 0));\n",
  });
  const res = await registry.run("ts_add", { a: 19, b: 23 });
  assert.equal(res.success, true, res.stderr);
  assert.match(res.stdout, /42/);
  registry.close();
});

test("invalid names and invalid syntax are rejected before writing", async () => {
  const { registry } = tmpRegistry();
  await assert.rejects(
    registry.save({
      name: "../evil",
      description: "x",
      language: "javascript",
      input_schema: {},
      code: "console.log(1)",
    }),
    /Invalid script name/,
  );
  await assert.rejects(
    registry.save({
      name: "bad_name_ok",
      description: "x",
      language: "javascript",
      input_schema: {},
      code: "this is not javascript {{{",
    }),
    /Syntax validation failed|syntax/i,
  );
  // The rejected syntax must NOT leave a registered tool behind.
  assert.ok(!registry.listAll().some((s) => s.name === "bad_name_ok"));
  registry.close();
});

test("global scope lands in the global store", async () => {
  const { registry } = tmpRegistry();
  await registry.save({
    name: "global_probe",
    description: "Global scope probe.",
    language: "javascript",
    input_schema: {},
    code: "console.log('g')",
    scope: "global",
  });
  const meta = registry.listAll().find((s) => s.name === "global_probe");
  assert.equal(meta.scope, "global");
  registry.close();
});

test("executor enforces timeout and truncates output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-exec-"));
  const slow = path.join(dir, "slow.js");
  fs.writeFileSync(slow, "setTimeout(() => console.log('late'), 60000)");
  const slowRes = await executeScript({ filePath: slow, language: "javascript", args: {}, timeoutMs: 500 });
  assert.equal(slowRes.success, false);
  assert.equal(slowRes.timed_out, true);

  const loud = path.join(dir, "loud.js");
  fs.writeFileSync(loud, "console.log('x'.repeat(50000))");
  const loudRes = await executeScript({ filePath: loud, language: "javascript", args: {} });
  assert.equal(loudRes.success, true);
  assert.equal(loudRes.truncated, true);
  assert.ok(loudRes.stdout.length < 9000);
});

test("prompt auto-script-instructions is exposed", async () => {
  const { registry } = tmpRegistry();
  const client = await connect(registry);
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === "auto-script-instructions"));
  const got = await client.getPrompt({ name: "auto-script-instructions" });
  assert.match(got.messages[0].content.text, /Always review|review the registered/i);
  await client.close();
  registry.close();
});

test("delete_script unmounts the tool", async () => {
  const { registry } = tmpRegistry();
  const client = await connect(registry);
  await client.callTool({
    name: "save_script",
    arguments: {
      name: "temp_one",
      description: "Temporary.",
      language: "javascript",
      input_schema: { type: "object", properties: {} },
      code: "console.log(1)",
    },
  });
  let tools = await client.listTools();
  assert.ok(tools.tools.map((t) => t.name).includes("script_temp_one"));
  await client.callTool({ name: "delete_script", arguments: { name: "temp_one" } });
  tools = await client.listTools();
  assert.ok(!tools.tools.map((t) => t.name).includes("script_temp_one"));
  await client.close();
  registry.close();
});
