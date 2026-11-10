// =====================================================================================
// FILE INI: perintah CLI kecil untuk "mengendalikan" daemon yang sedang berjalan.
// =====================================================================================
//
//   status                      apa yang sedang terjadi? (dijeda? ada yang menunggu HP?)
//   pause                       jeda: aksi agent tidak ditahan, yang sedang menunggu dilepas
//   resume                      lanjutkan penahanan
//   approve [id] [komentar]     setujui satu permintaan yang menunggu
//   deny    [id] [komentar]     tolak, dengan komentar yang dibaca agent
//
// ANALOGI: remote control untuk satpam (daemon). Satpam duduk di pos jaga (proses lain);
// remote ini berbicara dengannya lewat loket lokal yang sama, dengan kata sandi (token) yang
// sama. Ia hanya bisa dipakai di laptop ini.
//
// `approve` dan `deny` ada karena belum ada HP yang tersambung (relay dibuat di tahap 2).
// Sampai saat itu, ini jalan untuk menjawab permintaan yang ditahan, dan saluran yang sama
// nanti dipakai halaman web lokal.
//
// Logika ada di sini supaya bisa dites. Pintu masuk dari terminal ada di cli-main.ts.
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { DEFAULT_PORT } from "./daemon";
import { agentmonHome, paths } from "./home";
import type { DaemonStatus } from "./control";

// Bekal yang bisa diganti di test: lingkungan, tempat menulis keluaran.
export type CliDeps = {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
};

type Reply = { status: number; body: unknown };

// Mengirim satu request ke daemon. Tidak pernah melempar error untuk daemon yang mati;
// hasilnya `undefined` supaya pemanggil bisa menjelaskannya dengan bahasa manusia.
function call(port: number, token: string, method: "GET" | "POST", path: string, json?: unknown): Promise<Reply | undefined> {
  return new Promise((resolve) => {
    const payload = json === undefined ? undefined : JSON.stringify(json);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 5000,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end(payload);
  });
}

const USAGE = [
  "Pemakaian: cli <perintah>",
  "  status                    lihat keadaan daemon",
  "  pause                     jeda penahanan aksi",
  "  resume                    lanjutkan penahanan",
  "  approve [id] [komentar]   setujui permintaan yang menunggu",
  "  deny [id] [komentar]      tolak permintaan, dengan komentar untuk agent",
].join("\n");

/** Menjalankan satu perintah. Mengembalikan kode keluar (0 = berhasil). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !["status", "pause", "resume", "approve", "deny"].includes(command)) {
    deps.err(USAGE);
    return command ? 2 : 0;
  }

  // Port dan token dibaca dengan cara yang sama seperti daemon.
  const portText = deps.env.AGENTMON_PORT;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    deps.err(`AGENTMON_PORT tidak valid: ${portText}`);
    return 1;
  }
  const home = deps.env.AGENTMON_HOME ?? agentmonHome();
  let token: string;
  try {
    token = readFileSync(paths(home).token, "utf8").trim();
  } catch {
    deps.err(`Daemon belum pernah dijalankan (berkas token tidak ada di ${home}).`);
    return 1;
  }

  const notRunning = () => {
    deps.err(`Daemon tidak berjalan di 127.0.0.1:${port}. Jalankan dulu dengan: pnpm --filter @agentmon/bridge daemon`);
    return 1;
  };

  if (command === "status" || command === "pause" || command === "resume") {
    const method = command === "status" ? "GET" : "POST";
    const reply = await call(port, token, method, `/${command}`);
    if (!reply) return notRunning();
    if (reply.status !== 200) {
      deps.err(`Daemon menolak perintah (${reply.status}).`);
      return 1;
    }
    const status = reply.body as DaemonStatus & { released?: number };
    deps.out(status.message);
    if (command === "pause" && status.released) deps.out(`${status.released} permintaan yang menunggu dilepas ke terminal.`);
    for (const p of status.pending) deps.out(`  - ${p.approvalId.slice(0, 8)}  alat=${p.toolName}  kedaluwarsa ${p.expiresAt}`);
    return 0;
  }

  // approve / deny: [id] [komentar...]
  const decision = command === "approve" ? "approve" : "deny";
  const statusReply = await call(port, token, "GET", "/status");
  if (!statusReply) return notRunning();
  const pending = (statusReply.body as DaemonStatus).pending;

  // Id boleh diawali saja (8 karakter pertama cukup), dan boleh dilewati bila hanya ada satu
  // permintaan yang menunggu. Kata pertama dianggap id hanya bila cocok dengan permintaan yang ada.
  const first = rest[0];
  const byPrefix = first === undefined ? [] : pending.filter((p) => p.approvalId.startsWith(first));
  let target: (typeof pending)[number] | undefined;
  let commentWords = rest;
  if (byPrefix.length > 1) {
    deps.err(`Id "${first}" cocok dengan ${byPrefix.length} permintaan. Tulis lebih panjang.`);
    return 1;
  }
  if (byPrefix.length === 1) {
    target = byPrefix[0];
    commentWords = rest.slice(1);
  } else if (pending.length === 1) {
    target = pending[0];
  }
  if (!target) {
    deps.err(pending.length === 0 ? "Tidak ada permintaan yang sedang menunggu." : "Ada beberapa permintaan; sebutkan id-nya (lihat `status`).");
    return 1;
  }

  const comment = commentWords.join(" ").trim();
  const reply = await call(port, token, "POST", "/decision", {
    approvalId: target.approvalId,
    decision,
    ...(comment ? { comment } : {}),
  });
  if (!reply) return notRunning();
  if (reply.status === 200) {
    deps.out(`${decision === "approve" ? "Disetujui" : "Ditolak"}: ${target.toolName}`);
    return 0;
  }
  const body = reply.body as { error?: string; status?: string };
  deps.err(`Gagal (${reply.status}): ${body.error ?? "tidak diketahui"}${body.status ? ` (hasil sebenarnya: ${body.status})` : ""}`);
  return 1;
}
