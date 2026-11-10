// Membuktikan dengan Claude Code SUNGGUHAN bahwa hook menahan aksi dan menerjemahkan keputusan
// dengan benar. Daemon sungguhan berjalan di proses ini, dengan "penjawab otomatis" yang
// mengambil keputusan sesuai skenario (menggantikan HP yang belum ada).
//
// Pemakaian (dari folder packages/bridge, setelah `pnpm install`):
//   SPIKE_OUT=/tmp/spike node --import tsx ../../tools/hook-spike/verify-hold.ts
// Variabel: SPIKE_OUT (folder hasil), SPIKE_MODEL. Memakai sedikit kuota langganan (5 sesi pendek).
//
// Daemon harus tetap bisa menjawab hook selama Claude berjalan, jadi Claude dijalankan dengan
// spawn yang tidak memblokir (bukan spawnSync), seperti measure-overhead.ts.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeHandler } from "../../packages/bridge/src/adapters/claude-code-handler";
import { startDaemon, type RunningDaemon } from "../../packages/bridge/src/daemon";
import { buildClaudeHookSettings } from "../../packages/bridge/src/hook-config";

const slash = (p: string) => p.replace(/\\/g, "/");
const base = slash(process.env.SPIKE_OUT ?? mkdtempSync(join(tmpdir(), "agentmon-hold-")));
const runScript = new URL("./run.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const WRITE_PROMPT =
  "Buat file notes.txt berisi teks 'catatan'. Jika ada yang menghalangi, kutip persis pesan yang kamu terima. Setelah itu berhenti.";
const READ_PROMPT = "Baca file hello.txt dengan alat Read, lalu sebutkan isinya. Setelah itu berhenti.";

type Scenario = {
  name: string;
  prompt: string;
  // Apa yang dilakukan penjawab otomatis pada izin yang menunggu.
  answer: "approve" | "deny" | "none";
  paused?: boolean;
  approvalTimeoutMs?: number;
  // Mengembalikan daftar masalah (kosong = lolos).
  check: (r: Result) => string[];
};

type Result = {
  finished: boolean;
  resultText: string;
  created: boolean; // notes.txt terbentuk
  hooks: string[]; // "PreToolUse:Write", "PermissionRequest:Write", dan seterusnya
  log: string; // log daemon (tanpa isi pesan)
  held: number; // berapa kali daemon menahan
  durationMs: number;
};

const count = (text: string, needle: string) => text.split(needle).length - 1;

const SCENARIOS: Scenario[] = [
  {
    name: "01-disetujui",
    prompt: WRITE_PROMPT,
    answer: "approve",
    check: (r) => [
      ...(r.created ? [] : ["berkas tidak terbentuk padahal disetujui"]),
      ...(r.held === 1 ? [] : [`seharusnya ditahan 1 kali, bukan ${r.held}`]),
      // Diff dihitung untuk aksi yang ditahan (berkas baru, jadi tipenya text).
      ...(r.log.includes("diff dihitung alat=Write: text") ? [] : ["diff tidak dihitung untuk aksi Write yang ditahan"]),
      // Tidak ada prompt izin kedua: PermissionRequest tidak boleh muncul setelah `allow` di PreToolUse.
      ...(r.hooks.some((h) => h.startsWith("PermissionRequest:")) ? ["muncul PermissionRequest (prompt izin kedua)"] : []),
    ],
  },
  {
    name: "02-ditolak-dengan-komentar",
    prompt: WRITE_PROMPT,
    answer: "deny",
    check: (r) => [
      ...(r.created ? ["berkas terbentuk padahal ditolak"] : []),
      // Claude harus membaca komentar penolakan dan menyebutnya.
      ...(r.resultText.includes("KODE-MERAH-42") ? [] : ["Claude tidak mengutip komentar penolakan"]),
    ],
  },
  {
    name: "03-tanpa-jawaban",
    prompt: WRITE_PROMPT,
    answer: "none",
    approvalTimeoutMs: 3000,
    check: (r) => [
      ...(r.created ? ["berkas terbentuk padahal tidak ada yang menyetujui"] : []),
      ...(r.held === 1 ? [] : [`seharusnya ditahan 1 kali lalu dilepas, bukan ${r.held}`]),
      // Alur normal berlanjut ke PermissionRequest dan TIDAK ditahan lagi.
      ...(r.log.includes("diteruskan ke terminal tanpa menahan lagi") ? [] : ["PermissionRequest susulan tidak diteruskan tanpa menahan"]),
      ...(r.log.includes("timed_out") ? [] : ["tidak tercatat timed_out"]),
    ],
  },
  {
    name: "04-dijeda",
    prompt: WRITE_PROMPT,
    answer: "none",
    paused: true,
    check: (r) => [
      ...(r.created ? ["berkas terbentuk padahal tidak ada yang menyetujui"] : []),
      ...(r.held === 0 ? [] : [`tidak boleh menahan saat dijeda, tetapi menahan ${r.held} kali`]),
      ...(r.hooks.includes("PreToolUse:Write") ? [] : ["hook PreToolUse tidak terkirim"]),
    ],
  },
  {
    name: "05-hanya-membaca",
    prompt: READ_PROMPT,
    answer: "none",
    check: (r) => [
      ...(r.held === 0 ? [] : [`aksi baca-saja tidak boleh ditahan, tetapi ditahan ${r.held} kali`]),
      ...(r.hooks.includes("PreToolUse:Read") ? [] : ["hook PreToolUse:Read tidak terkirim"]),
    ],
  },
];

async function runScenario(s: Scenario): Promise<{ problems: string[]; result: Result }> {
  // Dua folder berbeda: run.sh menghapus dan membuat ulang `$SPIKE_OUT/<nama>` miliknya sendiri,
  // jadi data daemon dan pengaturan harus disimpan di tempat lain (`_work`).
  const dir = `${base}/${s.name}`; // hasil run.sh: stream.jsonl, project/
  const work = `${base}/_work/${s.name}`; // milik skrip ini: data daemon, pengaturan
  rmSync(work, { recursive: true, force: true });
  mkdirSync(`${work}/home`, { recursive: true });

  const hooks: string[] = [];
  const handler = createClaudeCodeHandler({ emit: () => undefined });
  const daemon: RunningDaemon = await startDaemon({
    home: `${work}/home`,
    port: 0,
    holdEnabled: true,
    ...(s.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: s.approvalTimeoutMs } : {}),
    onHook: (input, context) => {
      hooks.push(`${input.hook_event_name}:${String(input.tool_name ?? "-")}`);
      return handler(input, context);
    },
  });
  if (s.paused) daemon.control.pause();

  // Penjawab otomatis: pengganti HP.
  const answered = new Set<string>();
  const timer = setInterval(() => {
    if (s.answer === "none") return;
    for (const p of daemon.approvals.listPending()) {
      if (answered.has(p.approvalId)) continue;
      answered.add(p.approvalId);
      daemon.approvals.decide(
        s.answer === "approve"
          ? { approvalId: p.approvalId, decision: "approve" }
          : { approvalId: p.approvalId, decision: "deny", comment: "Jangan buat file baru. KODE-MERAH-42" },
      );
    }
  }, 40);

  const settingsFile = `${work}/settings.json`;
  writeFileSync(settingsFile, JSON.stringify(buildClaudeHookSettings({ port: daemon.port, token: daemon.token })));

  const started = performance.now();
  await new Promise<void>((resolve) => {
    const child = spawn("bash", [runScript, s.name, "-", s.prompt], {
      env: { ...process.env, SPIKE_SETTINGS: settingsFile, SPIKE_OUT: base, SPIKE_TURNS: "8" },
      stdio: "ignore",
    });
    const guard = setTimeout(() => child.kill(), 240_000);
    child.on("close", () => {
      clearTimeout(guard);
      resolve();
    });
  });
  clearInterval(timer);
  const durationMs = Math.round(performance.now() - started);
  await daemon.stop();

  const stream = existsSync(`${dir}/stream.jsonl`) ? readFileSync(`${dir}/stream.jsonl`, "utf8") : "";
  const rows = stream
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; subtype?: string; result?: string });
  const final = rows.find((row) => row.type === "result");
  const log = existsSync(`${work}/home/daemon.log`) ? readFileSync(`${work}/home/daemon.log`, "utf8") : "";

  const result: Result = {
    finished: final?.subtype === "success",
    resultText: final?.result ?? "",
    created: existsSync(`${dir}/project/notes.txt`),
    hooks,
    log,
    held: count(log, "menahan PreToolUse") + count(log, "menahan PermissionRequest"),
    durationMs,
  };
  const problems = [...(result.finished ? [] : ["sesi tidak selesai"]), ...s.check(result)];
  return { problems, result };
}

let failed = 0;
process.stdout.write(`hasil di ${base}\n`);
for (const scenario of SCENARIOS) {
  const { problems, result } = await runScenario(scenario);
  if (problems.length > 0) failed++;
  process.stdout.write(
    `${scenario.name.padEnd(28)} | ${String(result.durationMs).padStart(6)} ms | ditahan ${result.held}x | ${
      problems.length === 0 ? "LOLOS" : `GAGAL: ${problems.join("; ")}`
    }\n`,
  );
}
process.stdout.write(`\nskenario gagal: ${failed}\n`);
process.exitCode = failed === 0 ? 0 : 1;
