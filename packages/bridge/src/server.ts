// Server HTTP daemon: menerima hook dari Claude Code dan menjawab pemeriksaan kesehatan.
//
// Alurnya: Claude Code mengirim POST /hook berisi JSON (input hook) -> penjaga pintu
// (guard.ts) memeriksa -> penangan hook (onHook) memutuskan -> jawaban dikirim balik.
//
// Prinsip anti-macet (PRD bagian 8): daemon tidak boleh menjadi alasan agent berhenti.
// Karena itu penangan hook yang error tetap dijawab 200 dengan `{}`, yang bagi Claude
// Code berarti "tidak ada keputusan" sehingga alur izin normal berjalan.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApprovalEngine } from "./approvals";
import type { DaemonControl } from "./control";
import { decisionAnswer, handleDevRequest } from "./dev-ui";
import { guardRequest } from "./guard";
import type { Logger } from "./logger";
import type { Timeline } from "./timeline";

// Input hook bisa besar (misalnya hasil membaca berkas panjang), tetapi tidak tanpa batas.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Bentuk minimum input hook, yaitu amplop bersama yang diminta daemon dari agent mana pun:
// objek JSON dengan nama event. `tool_name` hanya dipakai untuk baris log. Kolom lain ikut
// terbawa apa adanya, dan maknanya hanya dipahami adapter per agent (folder adapters/).
// Untuk Claude Code, bentuk lengkapnya ada di docs/hooks-claude-code.md. Apakah amplop ini
// cukup umum untuk Codex baru diketahui setelah riset Codex (issue spike hooks Codex).
export type HookInput = {
  hook_event_name: string;
  tool_name?: string;
  [key: string]: unknown;
};

// Jawaban untuk Claude Code berupa objek keputusan (lihat docs/hooks-claude-code.md
// bagian 6), atau undefined bila tidak ada keputusan.
export type HookResponse = Record<string, unknown> | undefined;
// Bekal yang diberikan daemon ke penangan hook: pencatat log, identitas laptop ini, dan buku
// antrean izin (approval engine) tempat permintaan izin dibuka dan diputuskan.
export type HookContext = { logger: Logger; machineId: string; approvals: ApprovalEngine; control: DaemonControl };
export type HookHandler = (input: HookInput, context: HookContext) => Promise<HookResponse> | HookResponse;

export type ServerOptions = {
  token: string;
  logger: Logger;
  version: string;
  machineId: string;
  approvals: ApprovalEngine;
  control: DaemonControl;
  timeline: Timeline;
  // Halaman web lokal (alat pengembangan). Bawaan mati: alamat /dev tidak ada sama sekali.
  devUi?: boolean;
  onHook?: HookHandler;
  maxBodyBytes?: number;
};

class BodyTooLargeError extends Error {}

function reply(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isHookInput(value: unknown): value is HookInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { hook_event_name?: unknown }).hook_event_name === "string"
  );
}

// Server beserta "pengering": drain() menunggu semua hook yang sedang dijawab sampai selesai
// terkirim. Dipakai saat daemon berhenti, supaya hook yang menunggu keputusan sempat
// menerima jawabannya sebelum koneksinya ditutup.
export type DaemonServer = { server: Server; drain(timeoutMs: number): Promise<void> };

export function createDaemonServer(options: ServerOptions): DaemonServer {
  const { token, logger, version, machineId, approvals, control, timeline } = options;
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const startedAt = Date.now();
  // Hook yang sedang berjalan. "close" terjadi setelah jawaban selesai terkirim (atau koneksi putus).
  const inFlight = new Set<Promise<void>>();

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // Kesalahan tak terduga: jawab 500 tanpa membocorkan detail, lalu catat.
      logger.error(`kesalahan tak terduga: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) reply(res, 500, { error: "kesalahan internal" });
    });
  });
  // Batas waktu untuk MENERIMA request lengkap. Menunggu jawaban (misalnya keputusan
  // dari HP) tidak dibatasi oleh angka ini.
  server.requestTimeout = 15_000;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const port = (server.address() as AddressInfo).port;
    const path = (req.url ?? "").split("?")[0] ?? "";

    // Halaman web lokal punya penjaga sendiri (browser harus bisa memakainya). Hanya dilayani bila
    // mode pengembangan menyala; bila mati, alamat /dev diperlakukan seperti alamat lain dan
    // jatuh ke penjaga biasa di bawah.
    if (options.devUi && (path === "/dev" || path.startsWith("/dev/"))) {
      return handleDevRequest(req, res, path, { token, port, approvals, control, timeline, logger, reply, readJson });
    }

    const guard = guardRequest(req, { port, token });
    if (!guard.ok) {
      logger.error(`ditolak ${guard.status} ${req.method} ${path}: ${guard.message}`);
      reply(res, guard.status, { error: guard.message });
      return;
    }

    if (path === "/health") {
      if (req.method !== "GET") return reply(res, 405, { error: "metode tidak diizinkan" }, { allow: "GET" });
      return reply(res, 200, {
        status: "ok",
        version,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Date.now() - startedAt,
      });
    }

    if (path === "/hook") {
      if (req.method !== "POST") return reply(res, 405, { error: "metode tidak diizinkan" }, { allow: "POST" });
      const finished = new Promise<void>((resolve) => res.once("close", resolve));
      inFlight.add(finished);
      void finished.then(() => inFlight.delete(finished));
      return handleHook(req, res);
    }

    // ---- Kontrol lokal (dipakai perintah `status`, `pause`, `resume`, dan keputusan manual) ----
    if (path === "/status") {
      if (req.method !== "GET") return reply(res, 405, { error: "metode tidak diizinkan" }, { allow: "GET" });
      return reply(res, 200, control.status());
    }

    if (path === "/pause" || path === "/resume") {
      if (req.method !== "POST") return reply(res, 405, { error: "metode tidak diizinkan" }, { allow: "POST" });
      if (path === "/pause") {
        const released = control.pause();
        logger.info(`dijeda (${released} izin yang menunggu dilepas)`);
        return reply(res, 200, { ...control.status(), released });
      }
      control.resume();
      logger.info("dilanjutkan");
      return reply(res, 200, control.status());
    }

    // Keputusan untuk satu izin yang menunggu. Isinya bentuk ApprovalDecision dari paket
    // shared; mesin persetujuan yang memeriksanya, karena nanti datang dari HP.
    if (path === "/decision") {
      if (req.method !== "POST") return reply(res, 405, { error: "metode tidak diizinkan" }, { allow: "POST" });
      const body = await readJson(req, res);
      if (!body.ok) return;
      const answer = decisionAnswer(approvals, body.value);
      return reply(res, answer.status, answer.body);
    }

    reply(res, 404, { error: "tidak ditemukan" });
  }

  // Membaca isi request sebagai JSON. Bila gagal, jawabannya sudah dikirim di sini dan
  // pemanggil cukup berhenti (ok = false).
  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      reply(res, 415, { error: "hanya application/json" });
      return { ok: false };
    }
    let raw: string;
    try {
      raw = await readBody(req, limit);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.on("finish", () => req.destroy());
        reply(res, 413, { error: "isi terlalu besar" }, { connection: "close" });
      } else {
        reply(res, 400, { error: "isi tidak bisa dibaca" });
      }
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      reply(res, 400, { error: "JSON tidak valid" });
      return { ok: false };
    }
  }

  async function handleHook(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      return reply(res, 415, { error: "hanya application/json" });
    }

    let raw: string;
    try {
      raw = await readBody(req, limit);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        logger.error(`hook ditolak: isi lebih dari ${limit} byte`);
        // Putuskan koneksi setelah jawaban terkirim, supaya sisa kiriman tidak dibaca.
        res.on("finish", () => req.destroy());
        return reply(res, 413, { error: "isi terlalu besar" }, { connection: "close" });
      }
      return reply(res, 400, { error: "isi tidak bisa dibaca" });
    }

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return reply(res, 400, { error: "JSON tidak valid" });
    }
    if (!isHookInput(input)) return reply(res, 400, { error: "bukan input hook" });

    const started = performance.now();
    let response: HookResponse;
    try {
      response = await options.onHook?.(input, { logger, machineId, approvals, control });
    } catch (error) {
      // Gagal berarti tanpa keputusan, bukan persetujuan.
      logger.error(`penangan hook gagal: ${error instanceof Error ? error.message : String(error)}`);
      response = undefined;
    }

    // Hanya nama event, nama alat, dan hasilnya yang dicatat, tidak pernah isinya.
    const tool = typeof input.tool_name === "string" ? input.tool_name : "-";
    const ms = Math.round(performance.now() - started);
    logger.info(`hook ${input.hook_event_name} alat=${tool} -> ${response ? "keputusan" : "tanpa keputusan"} (${ms} ms)`);

    // `{}` = tidak ada keputusan. Teks biasa akan dianggap kesalahan oleh Claude Code,
    // jadi jawabannya selalu objek JSON.
    reply(res, 200, response ?? {});
  }

  async function drain(timeoutMs: number): Promise<void> {
    if (inFlight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all([...inFlight]).then(() => undefined), timeout]);
    clearTimeout(timer);
  }

  return { server, drain };
}
