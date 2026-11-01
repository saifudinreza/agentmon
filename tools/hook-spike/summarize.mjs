// Meringkas hasil satu eksperimen. Pemakaian: node summarize.mjs <folder-hasil>
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const out = (text) => process.stdout.write(`${text}\n`);

const dir = process.argv[2];
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const short = (v, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "..." : s; };

out("== HOOK ==");
for (const r of lines(`${dir}/events.jsonl`)) {
  const i = r.input ?? {};
  if (r.phase === "http") {
    out(`> ${r.event} (http ${r.method} ${r.contentType}) tool=${i.tool_name ?? "-"} rule=${r.rule}`);
  } else if (r.phase === "start") {
    out(`> ${r.event} tool=${i.tool_name ?? "-"} mode=${i.permission_mode ?? "-"} rule=${r.rule} keys=${Object.keys(i).join(",")}`);
  } else {
    out(`  < selesai rule=${r.rule} exit=${r.exitCode} stdout=${short(r.stdout, 200)}`);
  }
}
out("== CLAUDE ==");
for (const m of lines(`${dir}/stream.jsonl`)) {
  if (m.type === "assistant") {
    for (const c of m.message?.content ?? []) {
      if (c.type === "text") out(`[claude] ${short(c.text, 400)}`);
      if (c.type === "tool_use") out(`[tool_use] ${c.name} ${short(c.input, 200)}`);
    }
  } else if (m.type === "user") {
    for (const c of m.message?.content ?? []) {
      if (c.type === "tool_result") out(`[tool_result${c.is_error ? " ERROR" : ""}] ${short(c.content, 300)}`);
    }
  } else if (m.type === "result") {
    out(`[result] ${m.subtype} turns=${m.num_turns} cost=${m.total_cost_usd} denials=${short(m.permission_denials ?? [], 200)}`);
  } else if (m.type === "system" && !["init", "thinking_tokens", "hook_started", "hook_response", "task_started", "task_notification"].includes(m.subtype)) {
    out(`[system:${m.subtype}] ${short(m, 200)}`);
  }
}
