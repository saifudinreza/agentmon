// Mengubah catatan hasil eksperimen menjadi fixture bersih (tanpa path atau ID asli).
// Pemakaian: node make-fixtures.mjs <folder-hasil-eksperimen> <folder-tujuan>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const [src, dest] = process.argv.slice(2);
const PROJECT = String.raw`C:\work\project`;
const SESSION = "00000000-0000-4000-8000-000000000001";
const PROMPT = "00000000-0000-4000-8000-0000000000a1";

// [folder eksperimen, event, nama alat (atau null), nama berkas, syarat tambahan]
const picks = [
  ["01-baseline", "SessionStart", null, "SessionStart"],
  ["01-baseline", "UserPromptSubmit", null, "UserPromptSubmit"],
  ["01-baseline", "PreToolUse", "Read", "PreToolUse.Read"],
  ["01-baseline", "PreToolUse", "Write", "PreToolUse.Write"],
  ["01-baseline", "PreToolUse", "Edit", "PreToolUse.Edit"],
  ["01-baseline", "PreToolUse", "PowerShell", "PreToolUse.PowerShell"],
  ["15-bash-tool", "PreToolUse", "Bash", "PreToolUse.Bash"],
  ["01-baseline", "PermissionRequest", "Write", "PermissionRequest.Write"],
  ["01-baseline", "PermissionRequest", "Edit", "PermissionRequest.Edit"],
  ["16-powershell-write", "PermissionRequest", "PowerShell", "PermissionRequest.PowerShell"],
  ["15-bash-tool", "PermissionRequest", "Bash", "PermissionRequest.Bash"],
  ["01-baseline", "PostToolUse", "Read", "PostToolUse.Read"],
  ["01-baseline", "PostToolUse", "Write", "PostToolUse.Write"],
  ["01-baseline", "PostToolUse", "Edit", "PostToolUse.Edit"],
  ["01-baseline", "PostToolUse", "PowerShell", "PostToolUse.PowerShell"],
  ["15-bash-tool", "PostToolUse", "Bash", "PostToolUse.Bash"],
  ["01-baseline", "Stop", null, "Stop"],
  ["08-stop-block", "Stop", null, "Stop.continued", (i) => i.stop_hook_active === true],
  ["01-baseline", "SessionEnd", null, "SessionEnd"],
];

const ids = new Map();
const clean = (value, cwd) => {
  if (Array.isArray(value)) return value.map((v) => clean(v, cwd));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, cwd)]));
  }
  if (typeof value !== "string") return value;
  return value.split(cwd).join(PROJECT);
};

mkdirSync(dest, { recursive: true });
for (const [run, event, tool, name, extra] of picks) {
  const rows = readFileSync(`${src}/${run}/events.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const row = rows.find((r) => r.phase === "start" && r.event === event && (tool === null || r.input?.tool_name === tool) && (!extra || extra(r.input)));
  if (!row) throw new Error(`tidak ditemukan: ${run} ${event} ${tool}`);
  const input = clean(row.input, row.input.cwd);
  input.session_id = SESSION;
  if ("prompt_id" in input) input.prompt_id = PROMPT;
  input.transcript_path = String.raw`C:\Users\<USER>\.claude\projects\<PROJECT>\<SESSION_ID>.jsonl`;
  if ("tool_use_id" in input) {
    if (!ids.has(input.tool_use_id)) ids.set(input.tool_use_id, `toolu_fixture${String(ids.size + 1).padStart(4, "0")}`);
    input.tool_use_id = ids.get(input.tool_use_id);
  }
  const text = JSON.stringify(input, null, 2);
  // Path pengguna asli (selain placeholder) atau folder sementara berarti ada yang lolos.
  const leak = text.match(/Users\\(?!\\<USER>)|scratchpad|AppData|Temp\\/i);
  if (leak) throw new Error(`data pribadi tersisa di ${name}: ${leak[0]}`);
  writeFileSync(`${dest}/${name}.json`, `${text}\n`);
}
process.stdout.write(`${picks.length} fixture ditulis ke ${dest}\n`);
