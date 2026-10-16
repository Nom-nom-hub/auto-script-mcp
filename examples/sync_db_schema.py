# sync_db_schema — example script for auto-script-mcp
# Save it with save_script (language: "python"), then call it as
# script_sync_db_schema.
#
# input_schema:
# {
#   "type": "object",
#   "properties": {
#     "db_path":  { "type": "string", "description": "Path to the SQLite database" },
#     "table":    { "type": "string", "description": "Table name to describe" }
#   },
#   "required": ["db_path", "table"]
# }
#
# Prints the table's columns as JSON — handy for giving an agent exact
# schema facts in one tool call instead of a terminal session.
import json
import sqlite3
import sys

args = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
db_path = args.get("db_path")
table = args.get("table")
if not db_path or not table:
    print("db_path and table are required", file=sys.stderr)
    sys.exit(1)

conn = sqlite3.connect(db_path)
rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
columns = [
    {"name": r[1], "type": r[2], "notnull": bool(r[3]), "pk": bool(r[5])}
    for r in rows
]
print(json.dumps({"table": table, "columns": columns}, indent=2))
