// Spike #5: penerima hook bertipe "http". Alternatif tanpa menjalankan proses baru per hook.
// Pemakaian: node http-sink.mjs <port>   (memakai SPIKE_LOG dan SPIKE_SCENARIO seperti log-hook.mjs)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const port = Number(process.argv[2] ?? 4599);
const rules = process.env.SPIKE_SCENARIO && existsSync(process.env.SPIKE_SCENARIO)
  ? JSON.parse(readFileSync(process.env.SPIKE_SCENARIO, "utf8"))
  : [];

createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let input = null;
    try { input = JSON.parse(body); } catch { input = null; }
    const rule = rules.find((r) => r.event === input?.hook_event_name && (r.tool_name === undefined || r.tool_name === input?.tool_name));
    appendFileSync(process.env.SPIKE_LOG, JSON.stringify({
      t: new Date().toISOString(), event: input?.hook_event_name, phase: "http", method: req.method, url: req.url,
      contentType: req.headers["content-type"], rule: rule ? 0 : -1, input,
    }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rule?.stdout ?? {}));
  });
}).listen(port, "127.0.0.1");
