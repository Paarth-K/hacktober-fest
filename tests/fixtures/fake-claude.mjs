// Stand-in for `claude -p ... --output-format stream-json`: emits stream-json lines and makes REAL edits in cwd.
import { writeFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.9.9 (Fake Claude)"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] ?? "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init" });
out({ type: "assistant", message: { content: [{ type: "text", text: "I'll add the feature." }, { type: "tool_use", name: "Write", input: { file_path: `${process.cwd()}/src/feature.js` } }] } });
mkdirSync("src", { recursive: true });
writeFileSync("src/feature.js", "export function feature() {\n  return 42;\n}\n");
writeFileSync("README.md", "# demo\n\nNow with feature().\n");
out({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "This command requires approval" }] } });
if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 60_000));
out({ type: "result", subtype: "success", is_error: false, result: `Done. Added feature() (prompt had ${prompt.length} chars).` });
