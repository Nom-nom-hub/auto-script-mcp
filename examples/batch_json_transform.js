// batch_json_transform — example script for auto-script-mcp
// Save it with save_script (language: "javascript"), then call it as
// script_batch_json_transform.
//
// input_schema:
// {
//   "type": "object",
//   "properties": {
//     "dir":        { "type": "string", "description": "Directory to scan" },
//     "key":        { "type": "string", "description": "Object key to uppercase" },
//     "extensions": { "type": "array", "items": { "type": "string" }, "description": "File extensions, default [\".json\"]" }
//   },
//   "required": ["dir", "key"]
// }
//
// Reads args from argv[2] (JSON) per the auto-script-mcp script contract,
// uppercases `key` in every matching JSON file under `dir`, writes files
// back, and prints a JSON summary.
import fs from "node:fs";
import path from "node:path";

const args = JSON.parse(process.argv[2] || "{}");
const dir = args.dir;
const key = args.key;
const exts = args.extensions ?? [".json"];
if (!dir || !key) {
  console.error("dir and key are required");
  process.exit(1);
}

let changed = 0;
let scanned = 0;
for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !exts.includes(path.extname(entry.name))) continue;
  const file = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
  scanned++;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = Array.isArray(data) ? data : [data];
    let touched = false;
    for (const item of items) {
      if (item && typeof item[key] === "string") {
        item[key] = item[key].toUpperCase();
        touched = true;
      }
    }
    if (touched) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      changed++;
    }
  } catch {
    /* skip unparseable files */
  }
}
console.log(JSON.stringify({ scanned, changed }));
