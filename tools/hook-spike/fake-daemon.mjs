// Daemon palsu untuk menguji bagaimana Claude Code bereaksi pada jawaban yang salah.
// Pemakaian: node fake-daemon.mjs <mode> <port> [delayMs]
//
// Mode:
//   slow      menjawab {} setelah delayMs (untuk menguji timeout)
//   text      200 dengan teks biasa, bukan JSON
//   badjson   200 dengan JSON yang terpotong
//   badshape  200 dengan JSON valid tetapi nilai keputusannya tidak dikenal
//   status500 500 dengan JSON
//   allow     jawaban "allow" yang SAH. Kontrol positif: membuktikan bahwa uji bisa
//             mendeteksi aksi yang disetujui. Tanpa ini, "tidak ada yang disetujui"
//             tidak berarti apa-apa.
import { createServer } from "node:http";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const [mode, port, delay] = process.argv.slice(2);

const reply = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};

createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let event = "?";
    try {
      event = JSON.parse(raw).hook_event_name ?? "?";
    } catch {
      // abaikan
    }
    process.stdout.write(`${new Date().toISOString()} ${mode} ${event}\n`);

    if (mode === "slow") {
      await sleep(Number(delay ?? 15000));
      return reply(res, 200, "application/json", "{}");
    }
    if (mode === "text") return reply(res, 200, "text/plain", "oke");
    if (mode === "badjson") return reply(res, 200, "application/json", '{"hookSpecificOutput":');
    if (mode === "badshape") {
      return reply(
        res,
        200,
        "application/json",
        JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "bukan-nilai-sah" } }),
      );
    }
    if (mode === "status500") return reply(res, 500, "application/json", '{"error":"rusak"}');
    if (mode === "allow") {
      if (event === "PreToolUse") {
        return reply(res, 200, "application/json", JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "allow" } }));
      }
      if (event === "PermissionRequest") {
        return reply(res, 200, "application/json", JSON.stringify({ hookSpecificOutput: { hookEventName: event, decision: { behavior: "allow" } } }));
      }
    }
    reply(res, 200, "application/json", "{}");
  });
}).listen(Number(port), "127.0.0.1");
