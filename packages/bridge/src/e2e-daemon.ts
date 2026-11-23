// =====================================================================================
// FILE INI: sisi LAPTOP dari E2E saat daemon berjalan = "PETUGAS SEGEL" (issue #033 bagian D; docs/security-e2e.md bagian 4.3 dan 4.5).
// =====================================================================================
//
// Dipakai relay-client di dua arah:
//   KELUAR  `seal(event)`: begitu ada SATU HP terpercaya (e2e.json), event dienkripsi dan ditandatangani laptop sebelum meninggalkan daemon.
//           Gagal menyegel berarti event DIBUANG, tidak pernah dikirim polos (gagal tertutup). Event izin membawa `approvalId` dan `expiresAt` di
//           amplop (bukan rahasia, diautentikasi) supaya relay bisa menghitung dan memberi notifikasi tanpa membuka isi.
//   MASUK   `openCommand(deviceId, body)`: begitu E2E aktif, perintah polos DITOLAK. Perintah yang sah harus: terbuka dengan kunci pasangan HP itu,
//           bertanda tangan kunci HP yang tercatat di BERKAS LAPTOP (bukan dari relay), bukan HP yang dicabut, `commandId` belum pernah dipakai
//           (disimpan di disk, tahan restart), dan untuk keputusan: izinnya dikenal laptop, belum kedaluwarsa menurut JAM LAPTOP, nomor event, sesi,
//           dan `H` sama dengan yang laptop kirim, dan izin yang terpotong tidak boleh disetujui. Gagal di mana pun: tidak ada keputusan.
//   BALASAN `sealReply(deviceId, body)`: dienkripsi dan ditandatangani laptop, supaya relay tidak bisa memalsukan "berhasil".
// Keadaan dibaca dari `e2e.json` setiap kali berubah (pair/revoke dijalankan di proses lain); tidak ada yang perlu memulai ulang daemon.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@agentmon/shared";
import {
  approvalHash,
  bytesEqual,
  fromB64,
  laptopSessionKeys,
  openSigned,
  sealEvent,
  sealSigned,
  utf8,
  type Sodium,
} from "@agentmon/shared/crypto";
import { currentDataKey, E2E_FILE, loadE2e, trustedDevices, type StoredE2e } from "./e2e-store";
import type { Logger } from "./logger";

export type CommandVerdict =
  /** Perintah sah. `command` memuat isi yang BERSIH (kolom bukti seperti `h`, `eventId`, `sessionId` sudah dibuang). */
  | { ok: true; command: Record<string, unknown> }
  /** Ditolak. `reply` (bila ada) dikirim ke HP itu supaya tidak menunggu sia-sia; kegagalan autentikasi sengaja tanpa balasan. */
  | { ok: false; reply?: Record<string, unknown> };

export type DaemonE2e = {
  /** E2E aktif: ada satu HP terpercaya yang belum dicabut. */
  active(): boolean;
  /** Menyegel event untuk dikirim ke relay. Melempar bila gagal (pemanggil membuang event; tidak pernah mengirim polos). */
  seal(event: Envelope): Envelope;
  openCommand(deviceId: string, body: Record<string, unknown>): CommandVerdict;
  /** undefined bila HP itu tidak dikenal atau dicabut (tidak ada yang dikirim). */
  sealReply(deviceId: string, body: Record<string, unknown>): Record<string, unknown> | undefined;
};

export type DaemonE2eOptions = {
  s: Sodium;
  home: string;
  machineId: string;
  logger?: Logger;
  now?: () => number;
  /** Banyaknya izin dan nomor perintah yang diingat. */
  maxRemembered?: number;
};

type Remembered = { sessionId: string; eventId: string; h: Uint8Array; expiresAt: number; truncated: boolean };

const SEEN_FILE = "e2e-commands.json";
const MAX_COMMAND_ID = 200;
const APPROVAL_EVENTS = new Set(["approval.requested", "approval.resolved", "approval.auto_resolved"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createDaemonE2e(options: DaemonE2eOptions): DaemonE2e {
  const { s, home, machineId, logger } = options;
  const now = options.now ?? (() => Date.now());
  const maxRemembered = options.maxRemembered ?? 2000;

  // ---- Keadaan dari e2e.json (dibaca ulang bila berkas berubah) ----
  let cached: { mtimeMs: number; state: StoredE2e | undefined } | undefined;
  const state = (): StoredE2e | undefined => {
    const file = join(home, E2E_FILE);
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      /* belum ada */
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.state;
    let loaded: StoredE2e | undefined;
    try {
      loaded = loadE2e(home);
    } catch (error) {
      // Berkas rusak: E2E dianggap tidak bisa dipakai, dan itu TIDAK diam-diam berarti polos untuk laptop yang sudah punya HP terpercaya: lihat `active`.
      logger?.error(`e2e: berkas kunci tidak bisa dibaca: ${error instanceof Error ? error.message.slice(0, 120) : "galat"}`);
      loaded = undefined;
      broken = true;
    }
    if (loaded) broken = false;
    cached = { mtimeMs, state: loaded };
    return loaded;
  };
  // Berkas kunci yang RUSAK pada laptop yang sebelumnya aktif: event dan perintah ditolak (gagal tertutup), bukan dikirim polos.
  let broken = false;
  let wasActive = false;

  const active = (): boolean => {
    const current = state();
    const result = current !== undefined && trustedDevices(current).length > 0;
    if (result) wasActive = true;
    return result || (broken && wasActive);
  };

  // ---- Ingatan izin dan nomor perintah ----
  const remembered = new Map<string, Remembered>();
  const rememberApproval = (approvalId: string, value: Remembered) => {
    remembered.delete(approvalId);
    remembered.set(approvalId, value);
    if (remembered.size > maxRemembered) remembered.delete(remembered.keys().next().value as string);
  };

  // Nomor perintah yang sudah dipakai: di memori dan di disk (tahan restart). Dibatasi; yang terlama dibuang.
  const seenFile = join(home, SEEN_FILE);
  const seen = new Set<string>();
  try {
    if (existsSync(seenFile)) for (const id of JSON.parse(readFileSync(seenFile, "utf8")) as unknown[]) if (typeof id === "string") seen.add(id);
  } catch {
    // rusak: mulai kosong (paling buruk: replay perintah lama untuk izin yang sudah tidak ada, yang ditolak karena izinnya tidak dikenal)
  }
  const persistSeen = () => {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const temp = `${seenFile}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temp, JSON.stringify([...seen].slice(-maxRemembered)), { mode: 0o600 });
      try {
        renameSync(temp, seenFile);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    } catch {
      logger?.error("e2e: nomor perintah yang sudah dipakai tidak bisa disimpan ke disk");
    }
  };
  const markSeen = (commandId: string): boolean => {
    if (seen.has(commandId)) return false;
    seen.add(commandId);
    while (seen.size > maxRemembered) seen.delete(seen.values().next().value as string);
    persistSeen();
    return true;
  };

  const phoneKeys = (current: StoredE2e, deviceId: string) => {
    const device = current.devices[deviceId];
    if (!device || device.revokedAt !== undefined) return undefined;
    const keys = laptopSessionKeys(s, { publicKey: fromB64(s, current.kx.publicKey), privateKey: fromB64(s, current.kx.privateKey) }, fromB64(s, device.kx));
    return { keys, phoneSign: fromB64(s, device.sign) };
  };

  const reject = (why: string, reply?: Record<string, unknown>): CommandVerdict => {
    logger?.error(`e2e: perintah ditolak (${why})`);
    return reply ? { ok: false, reply } : { ok: false };
  };

  return {
    active,

    seal(event) {
      const current = state();
      if (!current || trustedDevices(current).length === 0) throw new Error("e2e: tidak ada HP terpercaya (atau berkas kunci rusak); event tidak dikirim polos");
      const payload = event.payload;
      const plaintext = utf8(JSON.stringify(payload ?? null));
      const approvalId = APPROVAL_EVENTS.has(event.type) && isObject(payload) && typeof payload.approvalId === "string" ? payload.approvalId : undefined;
      const expiresAt = event.type === "approval.requested" && isObject(payload) && typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
      if (event.type === "approval.requested" && (approvalId === undefined || expiresAt === undefined)) throw new Error("e2e: event izin tanpa approvalId atau expiresAt");
      const envelope = {
        v: event.v,
        id: event.id,
        machineId: event.machineId,
        sessionId: event.sessionId,
        seq: event.seq,
        ts: event.ts,
        agent: event.agent,
        type: event.type,
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
      const sealed = sealEvent(s, { dataKey: currentDataKey(s, current), kid: current.kid, envelope, plaintext, signPrivateKey: fromB64(s, current.sign.privateKey) });
      if (event.type === "approval.requested" && approvalId !== undefined && expiresAt !== undefined && isObject(payload)) {
        rememberApproval(approvalId, { sessionId: event.sessionId, eventId: event.id, h: approvalHash(s, plaintext), expiresAt: Date.parse(expiresAt), truncated: payload.truncated === true });
      }
      return { ...envelope, payload: sealed } as unknown as Envelope;
    },

    openCommand(deviceId, body) {
      const current = state();
      if (!active()) return { ok: true, command: body };
      // E2E aktif: perintah polos tidak diterima (tidak ada mode "baca keduanya"); perintah dari HP lama berujung ke alur izin normal di terminal.
      if (!current) return reject("berkas kunci tidak bisa dibaca");
      let plaintext: Uint8Array;
      try {
        const known = phoneKeys(current, deviceId);
        if (!known) return reject("HP tidak dikenal atau sudah dicabut");
        plaintext = openSigned(s, known.keys.rx, known.phoneSign, { direction: "command", machineId, deviceId }, body);
      } catch {
        return reject("tidak terenkripsi, tanda tangan tidak sah, atau diubah");
      }
      let command: unknown;
      try {
        command = JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        return reject("isi bukan JSON");
      }
      if (!isObject(command)) return reject("isi bukan objek");
      const commandId = command.commandId;
      if (typeof commandId !== "string" || commandId === "" || commandId.length > MAX_COMMAND_ID) return reject("tanpa nomor perintah");
      if (!markSeen(commandId)) return reject("nomor perintah sudah pernah dipakai (diputar ulang)");

      if (command.type !== "approval.decision") return { ok: true, command };

      // Keputusan: izinnya harus yang laptop kirim, belum kedaluwarsa, dan HP harus melihat isi yang sama persis (H).
      const { sessionId, eventId, h, ...clean } = command;
      const approvalId = typeof clean.approvalId === "string" ? clean.approvalId : "";
      const invalidReply = { type: "approval.result", commandId, approvalId, outcome: "invalid" };
      const unknownReply = { type: "approval.result", commandId, approvalId, outcome: "unknown" };
      const record = remembered.get(approvalId);
      if (!record) return reject("izin tidak dikenal laptop", approvalId ? unknownReply : undefined);
      if (now() >= record.expiresAt) return reject("izin sudah kedaluwarsa (jam laptop)", unknownReply);
      if (sessionId !== record.sessionId || eventId !== record.eventId) return reject("sesi atau nomor event tidak cocok", invalidReply);
      let sentHash: Uint8Array;
      try {
        sentHash = fromB64(s, typeof h === "string" ? h : "");
      } catch {
        return reject("H rusak", invalidReply);
      }
      if (!bytesEqual(s, sentHash, record.h)) return reject("H tidak cocok: HP melihat isi yang berbeda dari yang laptop kirim", invalidReply);
      // Izin yang isinya terpotong (terlalu besar untuk dikirim utuh) tidak boleh disetujui; larangannya ada di laptop, bukan hanya di HP.
      if (record.truncated && clean.decision !== "deny") return reject("izin terpotong tidak boleh disetujui", invalidReply);
      return { ok: true, command: clean };
    },

    sealReply(deviceId, body) {
      const current = state();
      if (!current) return undefined;
      let known;
      try {
        known = phoneKeys(current, deviceId);
      } catch {
        return undefined;
      }
      if (!known) return undefined;
      const box = sealSigned(s, known.keys.tx, fromB64(s, current.sign.privateKey), { direction: "reply", machineId, deviceId }, utf8(JSON.stringify(body)));
      return { n: box.n, c: box.c, s: box.s };
    },
  };
}
