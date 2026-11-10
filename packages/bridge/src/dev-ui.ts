// =====================================================================================
// FILE INI: rute-rute halaman web lokal (alat pengembangan) di daemon.
// =====================================================================================
//
//   GET  /dev                  halaman HTML-nya (tanpa token: hanya kode halaman, tanpa data)
//   GET  /dev/api/state        keadaan: status, izin yang menunggu (dengan diff), timeline
//   POST /dev/api/decision     setujui atau tolak satu izin
//   POST /dev/api/pause        jeda penahanan
//   POST /dev/api/resume       lanjutkan penahanan
//
// HANYA AKTIF DI MODE PENGEMBANGAN. Bila daemon tidak dijalankan dengan devUi, semua alamat
// /dev tidak ada (server.ts tidak pernah memanggil file ini). Dan bila aktif pun, semua API
// tetap memerlukan token, dan hanya menerima request dari program non-browser atau dari halaman
// milik daemon sendiri (lihat guardDevRequest di guard.ts).
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalEngine, ApprovalSnapshot } from "./approvals";
import type { DaemonControl } from "./control";
import { renderDevPage } from "./dev-page";
import { guardDevRequest } from "./guard";
import type { Logger } from "./logger";
import type { Timeline } from "./timeline";

// Hasil memutuskan sebuah izin dalam bentuk jawaban HTTP. Dipakai bersama oleh /decision dan
// /dev/api/decision supaya keduanya selalu sama.
export type HttpAnswer = { status: number; body: Record<string, unknown> };

export function decisionAnswer(approvals: ApprovalEngine, value: unknown): HttpAnswer {
  const result = approvals.decide(value);
  if (result.ok) return { status: 200, body: { ok: true, status: result.approval.status } };
  if (result.reason === "invalid") return { status: 400, body: { error: result.message } };
  if (result.reason === "unknown") return { status: 404, body: { error: "izin tidak dikenal" } };
  return { status: 409, body: { error: "izin sudah selesai", status: result.status } };
}

// Isi yang tampil di halaman dipotong: input alat bisa berisi seluruh isi berkas (megabita),
// padahal untuk memutuskan cukup melihat bagian awalnya. Diff lengkap tampil terpisah.
const MAX_STRING = 2000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

export function truncateInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... (dipotong, ${value.length} karakter)` : value;
  }
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) {
    return typeof value === "object" && value !== null ? "(terlalu dalam)" : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => truncateInput(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`... (${value.length - MAX_ITEMS} item lagi)`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).slice(0, MAX_ITEMS).map(([k, v]) => [k, truncateInput(v, depth + 1)]));
}

// Bagian izin yang ditampilkan di halaman.
function forPage(approval: ApprovalSnapshot) {
  return {
    approvalId: approval.approvalId,
    sessionId: approval.sessionId,
    toolName: approval.toolName,
    toolInput: truncateInput(approval.toolInput),
    ...(approval.diff ? { diff: approval.diff } : {}),
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

export type DevUiContext = {
  token: string;
  port: number;
  approvals: ApprovalEngine;
  control: DaemonControl;
  timeline: Timeline;
  logger: Logger;
  reply: (res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>) => void;
  readJson: (req: IncomingMessage, res: ServerResponse) => Promise<{ ok: true; value: unknown } | { ok: false }>;
};

/** Menangani request untuk alamat /dev dan /dev/*. */
export async function handleDevRequest(req: IncomingMessage, res: ServerResponse, path: string, ctx: DevUiContext): Promise<void> {
  const { reply, logger } = ctx;
  const isPage = path === "/dev";
  const guard = guardDevRequest(req, { port: ctx.port, token: ctx.token }, isPage ? "page" : "api");
  if (!guard.ok) {
    logger.error(`halaman dev: ditolak ${guard.status} ${req.method} ${path}: ${guard.message}`);
    return reply(res, guard.status, { error: guard.message });
  }

  const notAllowed = (allow: string) => reply(res, 405, { error: "metode tidak diizinkan" }, { allow });

  if (isPage) {
    if (req.method !== "GET") return notAllowed("GET");
    // Kode acak sekali pakai: hanya skrip dan gaya yang membawanya yang boleh jalan.
    const nonce = randomBytes(16).toString("base64");
    const html = renderDevPage(nonce);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'", // halaman hanya boleh berbicara dengan daemon ini
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'", // tidak boleh dibingkai situs lain
      ].join("; "),
    });
    res.end(html);
    return;
  }

  if (path === "/dev/api/state") {
    if (req.method !== "GET") return notAllowed("GET");
    return reply(res, 200, {
      status: ctx.control.status(),
      pending: ctx.approvals.listPending().map(forPage),
      timeline: ctx.timeline.list(),
    });
  }

  if (path === "/dev/api/pause" || path === "/dev/api/resume") {
    if (req.method !== "POST") return notAllowed("POST");
    if (path === "/dev/api/pause") {
      const released = ctx.control.pause();
      logger.info(`dijeda lewat halaman dev (${released} izin yang menunggu dilepas)`);
      return reply(res, 200, { ...ctx.control.status(), released });
    }
    ctx.control.resume();
    logger.info("dilanjutkan lewat halaman dev");
    return reply(res, 200, ctx.control.status());
  }

  if (path === "/dev/api/decision") {
    if (req.method !== "POST") return notAllowed("POST");
    const body = await ctx.readJson(req, res);
    if (!body.ok) return;
    const answer = decisionAnswer(ctx.approvals, body.value);
    return reply(res, answer.status, answer.body);
  }

  reply(res, 404, { error: "tidak ditemukan" });
}
