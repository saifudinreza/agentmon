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
import { guardRequest } from "./guard";
import type { Logger } from "./logger";

// Input hook bisa besar (misalnya hasil membaca berkas panjang), tetapi tidak tanpa batas.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Bentuk minimum input hook. Kolom lain ikut terbawa apa adanya, dan maknanya hanya
// dipahami adapter per agent (folder adapters/). Untuk Claude Code, bentuk lengkapnya
// ada di docs/hooks-claude-code.md.
export type HookInput = {
  hook_event_name: string;
  tool_name?: string;
  [key: string]: unknown;
};

// Jawaban untuk Claude Code berupa objek keputusan (lihat docs/hooks-claude-code.md
// bagian 6), atau undefined bila tidak ada keputusan.
export type HookResponse = Record<string, unknown> | undefined;
// Bekal yang diberikan daemon ke penangan hook: pencatat log dan identitas laptop ini.
export type HookContext = { logger: Logger; machineId: string };
export type HookHandler = (input: HookInput, context: HookContext) => Promise<HookResponse> | HookResponse;

export type ServerOptions = {
  token: string;
  logger: Logger;
  version: string;
  machineId: string;
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

export function createDaemonServer(options: ServerOptions): Server {
  const { token, logger, version, machineId } = options;
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const startedAt = Date.now();

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
    const guard = guardRequest(req, { port, token });
    const path = (req.url ?? "").split("?")[0];
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
      return handleHook(req, res);
    }

    reply(res, 404, { error: "tidak ditemukan" });
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
      response = await options.onHook?.(input, { logger, machineId });
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

  return server;
}
