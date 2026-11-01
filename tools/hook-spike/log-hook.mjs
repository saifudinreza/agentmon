// Spike #5: pencatat dan pengatur keputusan untuk hook Claude Code. Bukan kode produksi.
//
// Dipanggil Claude Code sebagai: node log-hook.mjs <NamaEvent>
// Alurnya: baca JSON dari stdin, catat ke SPIKE_LOG (satu baris JSON per catatan),
// lalu, bila ada aturan yang cocok di SPIKE_SCENARIO, keluarkan keputusan sesuai aturan.
//
// Aturan skenario (array JSON, aturan pertama yang cocok dipakai):
//   { "event": "PreToolUse", "tool_name": "Write", "when": { "stop_hook_active": false },
//     "sleepMs": 0, "stdout": { ... } | "teks", "stderr": "teks", "exitCode": 0 }
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const eventArg = process.argv[2] ?? "unknown";
const logFile = process.env.SPIKE_LOG;
const scenarioFile = process.env.SPIKE_SCENARIO;

process.stdin.setEncoding("utf8");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input = null;
try {
  input = JSON.parse(raw);
} catch {
  input = null;
}

const log = (record) => {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), event: eventArg, ...record }) + "\n");
};

const claudeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("CLAUDE")).map(([k, v]) => [k, k.includes("TOKEN") ? "..." : v]),
);

let rules = [];
if (scenarioFile && existsSync(scenarioFile)) rules = JSON.parse(readFileSync(scenarioFile, "utf8"));

const matches = (rule) =>
  rule.event === (input?.hook_event_name ?? eventArg) &&
  (rule.tool_name === undefined || rule.tool_name === input?.tool_name) &&
  Object.entries(rule.when ?? {}).every(([k, v]) => input?.[k] === v);
const index = rules.findIndex(matches);
const rule = index >= 0 ? rules[index] : null;

log({ phase: "start", rule: index, rawParsed: input !== null, input, claudeEnv });

if (rule?.sleepMs) await sleep(rule.sleepMs);

// Nilai {"$merge": {...}} diganti dengan tool_input asli yang digabung patch tersebut,
// supaya skenario bisa mengubah sebagian input tanpa tahu path file yang dipakai.
const resolve = (v) => {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") {
    if ("$merge" in v) return { ...(input?.tool_input ?? {}), ...v.$merge };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
};
if (rule && typeof rule.stdout === "object") rule.stdout = resolve(rule.stdout);

const stdout = rule?.stdout === undefined ? "" : typeof rule.stdout === "string" ? rule.stdout : JSON.stringify(rule.stdout);
if (stdout) process.stdout.write(stdout);
if (rule?.stderr) process.stderr.write(rule.stderr);
log({ phase: "end", rule: index, stdout, stderr: rule?.stderr ?? "", exitCode: rule?.exitCode ?? 0 });
process.exit(rule?.exitCode ?? 0);
