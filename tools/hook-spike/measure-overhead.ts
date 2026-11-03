// Mengukur waktu tambahan akibat hook http, dengan daemon dan konfigurasi yang SEBENARNYA.
// Pemakaian (dari folder packages/bridge): node --import tsx ../../tools/hook-spike/measure-overhead.ts
// Variabel: SPIKE_OUT (folder hasil), SPIKE_MODEL. Memakai sedikit kuota langganan (satu sesi).
//
// Cara mengukur: Claude diminta membaca 15 berkas satu per satu. Untuk tiap pembacaan,
// daemon mencatat kapan PreToolUse dan PostToolUse tiba. Selisihnya dikurangi
// `duration_ms` (lama alat berjalan, dilaporkan Claude Code) adalah waktu di luar alat:
// pengiriman hook Pre, jawaban daemon, dan pengiriman hook Post. Itu BATAS ATAS untuk
// satu hook, karena memuat dua panggilan sekaligus.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../packages/bridge/src/daemon";
import { buildClaudeHookSettings } from "../../packages/bridge/src/hook-config";

type Arrival = { event: string; id: string; tool: string; duration: number | undefined; t: number };

const slash = (p: string) => p.replace(/\\/g, "/");
const base = slash(process.env.SPIKE_OUT ?? mkdtempSync(join(tmpdir(), "agentmon-overhead-")));
const work = `${base}/_overhead`;
rmSync(work, { recursive: true, force: true });
mkdirSync(`${work}/seed`, { recursive: true });
for (let i = 1; i <= 15; i++) writeFileSync(`${work}/seed/f${i}.txt`, `isi berkas ${i}\n`);

const arrivals: Arrival[] = [];
const home = `${work}/home`;
const daemon = await startDaemon({
  home,
  port: 0,
  onHook: (input) => {
    arrivals.push({
      event: input.hook_event_name,
      id: String(input.tool_use_id ?? ""),
      tool: String(input.tool_name ?? ""),
      duration: typeof input.duration_ms === "number" ? input.duration_ms : undefined,
      t: performance.now(),
    });
    return undefined;
  },
});

const settingsFile = `${work}/settings.json`;
writeFileSync(settingsFile, JSON.stringify(buildClaudeHookSettings({ port: daemon.port, token: daemon.token })));

const prompt =
  "Ada 15 berkas bernama f1.txt sampai f15.txt di folder ini. Baca masing-masing dengan alat Read, " +
  "satu panggilan per berkas, satu per satu secara berurutan (jangan paralel). Setelah semuanya terbaca, berhenti.";
// Harus spawn yang tidak memblokir (bukan spawnSync): daemon berjalan di proses ini, jadi
// proses ini harus tetap bisa menjawab hook selama Claude berjalan. Dengan spawnSync, daemon
// membeku dan Claude menunggu sampai batas waktu hook.
const runScript = new URL("./run.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const exitCode = await new Promise<number | null>((resolve) => {
  const child = spawn("bash", [runScript, "overhead", "-", prompt], {
    env: { ...process.env, SPIKE_SETTINGS: settingsFile, SPIKE_SEED: `${work}/seed`, SPIKE_OUT: work, SPIKE_TURNS: "40" },
    stdio: "ignore",
  });
  // Pengaman: sesi yang menggantung tidak boleh membuat pengukuran menunggu selamanya.
  const timer = setTimeout(() => child.kill(), 300_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
await daemon.stop();
if (exitCode !== 0) process.stdout.write(`run.sh keluar dengan kode ${exitCode}\n`);

const pre = new Map(arrivals.filter((a) => a.event === "PreToolUse" && a.tool === "Read").map((a) => [a.id, a]));
const pairs = arrivals
  .filter((a) => a.event === "PostToolUse" && a.tool === "Read" && a.duration !== undefined && pre.has(a.id))
  .map((post) => {
    const before = pre.get(post.id) as Arrival;
    return { id: post.id, start: before.t, end: post.t, overhead: post.t - before.t - (post.duration as number) };
  })
  .sort((a, b) => a.start - b.start);

// Hanya pasangan yang tidak tumpang tindih dengan pasangan lain (panggilan paralel akan
// mencemari selisihnya).
const clean = pairs.filter((p, i) => {
  const prev = pairs[i - 1];
  const next = pairs[i + 1];
  return (!prev || prev.end <= p.start) && (!next || p.end <= next.start);
});

const sorted = clean.map((p) => p.overhead).sort((a, b) => a - b);
const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;
const fmt = (n: number) => `${n.toFixed(1)} ms`;

const lines = [
  `pembacaan berkas tercatat : ${pairs.length} (dipakai: ${clean.length}, sisanya tumpang tindih)`,
  `waktu di luar alat per panggilan (Pre + Post): median ${fmt(pct(0.5))}, p95 ${fmt(pct(0.95))}, maksimum ${fmt(sorted[sorted.length - 1] ?? NaN)}`,
  `target PRD §14 (p95 per hook) : < 150 ms -> ${pct(0.95) < 150 ? "TERPENUHI" : "TIDAK TERPENUHI"}`,
];
writeFileSync(`${work}/hasil.json`, JSON.stringify({ pairs, clean: clean.length, median: pct(0.5), p95: pct(0.95) }, null, 2));
process.stdout.write(`${lines.join("\n")}\n`);
