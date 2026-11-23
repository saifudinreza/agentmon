// =====================================================================================
// FILE INI: gerbang E2E di HP = "PETUGAS PEMERIKSA SURAT MASUK DAN KELUAR" (docs/security-e2e.md bagian 4.3, 4.4, 4.5).
// =====================================================================================
//
// SEMUA yang masuk dari relay (event langsung, halaman riwayat, antrean izin) dan semua yang keluar (perintah) lewat sini, sehingga
// layar tidak perlu tahu apa-apa soal kripto. Aturan yang dijaga:
//   - Laptop yang dipasangkan secara E2E: event WAJIB terenkripsi dan bertanda tangan laptop itu. Event polos DITOLAK walau terlihat
//     sah (penurunan versi tidak boleh: relay jahat tidak bisa menyuruh HP menerima isi polos).
//   - Verifikasi tanda tangan dulu, baru dekripsi. Gagal apa pun = event dibuang dan dihitung, tidak pernah ditampilkan setengah jadi.
//   - Event langsung dengan `kid` lebih rendah dari yang terbaru dikenal ditolak (kunci lama tidak boleh dihidupkan lagi).
//   - Event izin: `approvalId` dan `expiresAt` di amplop (dipakai notifikasi tanpa membuka isi) HARUS sama dengan isinya. Relay tidak bisa
//     membuat notifikasi atau tenggat palsu yang tampak benar di layar.
//   - Keputusan ditandatangani HP dan membawa `H` = hash SELURUH payload izin yang HP lihat, nomor event, dan sesi. Izin yang tidak pernah
//     dilihat HP (tidak ada catatannya) tidak bisa diputuskan.
//   - Balasan laptop harus terenkripsi dan bertanda tangan laptop; yang polos dari laptop E2E ditolak.
// Laptop yang TIDAK dipasangkan secara E2E (pairing lama) diteruskan apa adanya.
import { computePendingApprovals, type Envelope, type PendingApproval } from "@agentmon/shared";
import { approvalHash, openEvent, openSigned, sealSigned, SealedPayloadSchema, toB64, utf8, type SignedBox, type Sodium } from "@agentmon/shared/crypto";
import type { RelayApi } from "../relay/api";
import type { Keyring } from "./keyring";

export type GateStats = {
  /** Event E2E yang dibuang: tanda tangan salah, kunci tidak ada, diubah, atau bentuk rusak. */
  rejected: number;
  /** Event polos dari laptop E2E yang dibuang (penurunan versi). */
  plaintextRejected: number;
};

export type SealResult = { ok: true; body: SignedBox } | { ok: false; reason: "unknown-approval" | "no-keys" };

export type E2eGate = {
  isSecured(machineId: string): boolean;
  /** True bila ada laptop yang dipasangkan secara E2E (antrean izin harus dihitung dari event terbuka). */
  anySecured(): boolean;
  /** Membuka satu event. `live` = datang lewat sambungan langsung (kid lama ditolak). undefined = ditolak. */
  open(envelope: Envelope, live: boolean): Envelope | undefined;
  openAll(envelopes: readonly Envelope[], live: boolean): Envelope[];
  /** Menutup dan menandatangani perintah untuk satu laptop E2E. Keputusan diperkaya dengan `sessionId`, `eventId`, dan `h`. */
  sealCommand(machineId: string, body: Record<string, unknown>): SealResult;
  /** Membuka balasan laptop. undefined = ditolak (polos, tanda tangan salah, diubah). */
  openReply(machineId: string, body: unknown): Record<string, unknown> | undefined;
  /** Antrean izin dari event mentah: laptop E2E dihitung dari event yang terbuka; sisanya memakai antrean dari relay. */
  pendingApprovals(relayApproved: readonly PendingApproval[], rawEvents: readonly Envelope[], now: Date): PendingApproval[];
  stats(): GateStats;
};

const MAX_REMEMBERED = 1000;

type Remembered = { sessionId: string; eventId: string; h: Uint8Array };

export function createGate(s: Sodium, keyring: Keyring): E2eGate {
  const stats: GateStats = { rejected: 0, plaintextRejected: 0 };
  // Izin yang pernah dilihat HP: kunci = laptop + nomor izin. Dibatasi supaya sesi panjang tidak memenuhi memori.
  const remembered = new Map<string, Remembered>();
  const rememberKey = (machineId: string, approvalId: string) => `${machineId}\u0000${approvalId}`;
  const remember = (machineId: string, approvalId: string, value: Remembered) => {
    remembered.delete(rememberKey(machineId, approvalId));
    remembered.set(rememberKey(machineId, approvalId), value);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
  };

  const reject = (): undefined => {
    stats.rejected += 1;
    return undefined;
  };

  function open(envelope: Envelope, live: boolean): Envelope | undefined {
    const machine = keyring.machine(envelope.machineId);
    if (!machine) return envelope; // pairing lama: apa adanya
    if (!SealedPayloadSchema.safeParse(envelope.payload).success) {
      stats.plaintextRejected += 1;
      return undefined;
    }
    const approvalId = (envelope as { approvalId?: unknown }).approvalId;
    const expiresAt = (envelope as { expiresAt?: unknown }).expiresAt;
    let plaintext: Uint8Array;
    let kid: number;
    try {
      const opened = openEvent(s, {
        payload: envelope.payload,
        envelope: {
          v: envelope.v,
          id: envelope.id,
          machineId: envelope.machineId,
          sessionId: envelope.sessionId,
          seq: envelope.seq,
          ts: envelope.ts,
          agent: envelope.agent,
          type: envelope.type,
          ...(typeof approvalId === "string" ? { approvalId } : {}),
          ...(typeof expiresAt === "string" ? { expiresAt } : {}),
        },
        expectedMachineId: envelope.machineId,
        dataKeys: (id) => machine.dataKeys.get(id),
        signPublicKey: machine.laptopSignPublicKey,
      });
      plaintext = opened.plaintext;
      kid = opened.kid;
    } catch {
      return reject();
    }
    if (live && kid < machine.kid) return reject(); // kunci lama tidak boleh dipakai untuk event baru

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return reject();
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return reject();
    const inner = payload as Record<string, unknown>;

    if (envelope.type === "approval.requested") {
      // Amplop (yang dipakai notifikasi tanpa membuka isi) HARUS sama dengan isinya.
      if (typeof inner.approvalId !== "string" || approvalId !== inner.approvalId || typeof inner.expiresAt !== "string" || expiresAt !== inner.expiresAt) return reject();
      remember(envelope.machineId, inner.approvalId, { sessionId: envelope.sessionId, eventId: envelope.id, h: approvalHash(s, plaintext) });
    } else if (approvalId !== undefined && inner.approvalId !== approvalId) {
      return reject();
    }
    return { ...envelope, payload: inner };
  }

  const openAll = (envelopes: readonly Envelope[], live: boolean): Envelope[] => envelopes.flatMap((e) => {
    const opened = open(e, live);
    return opened ? [opened] : [];
  });

  return {
    isSecured: (machineId) => keyring.secured(machineId),
    anySecured: () => keyring.anySecured(),
    open,
    openAll,
    sealCommand(machineId, body) {
      const machine = keyring.machine(machineId);
      const phone = keyring.phone();
      if (!machine || !phone) return { ok: false, reason: "no-keys" };
      let message: Record<string, unknown> = body;
      if (body.type === "approval.decision") {
        const known = typeof body.approvalId === "string" ? remembered.get(rememberKey(machineId, body.approvalId)) : undefined;
        if (!known) return { ok: false, reason: "unknown-approval" };
        message = { ...body, sessionId: known.sessionId, eventId: known.eventId, h: toB64(s, known.h) };
      }
      return { ok: true, body: sealSigned(s, machine.tx, phone.sign.privateKey, { direction: "command", machineId, deviceId: machine.deviceId }, utf8(JSON.stringify(message))) };
    },
    openReply(machineId, body) {
      const machine = keyring.machine(machineId);
      if (!machine) return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
      try {
        const plaintext = openSigned(s, machine.rx, machine.laptopSignPublicKey, { direction: "reply", machineId, deviceId: machine.deviceId }, body);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
      } catch {
        stats.rejected += 1;
        return undefined;
      }
    },
    pendingApprovals(relayApproved, rawEvents, now) {
      const secured = rawEvents.filter((e) => keyring.secured(e.machineId));
      const computed = computePendingApprovals(openAll(secured, false), now);
      return [...relayApproved.filter((a) => !keyring.secured(a.machineId)), ...computed];
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * Membungkus API relay supaya semua yang dibaca HP melewati gerbang: halaman riwayat dibuka (event yang gagal dibuang), dan antrean izin
 * untuk laptop E2E dihitung di HP dari event terbuka (relay tidak bisa membaca isinya, jadi antrean dari relay kosong untuk laptop itu).
 */
export function gatedApi(api: RelayApi, gate: E2eGate, now: () => Date = () => new Date()): RelayApi {
  return {
    ...api,
    events: async (machineId, sessionId, afterSeq, limit) => {
      const page = await api.events(machineId, sessionId, afterSeq, limit);
      return { ...page, events: gate.openAll(page.events, false) };
    },
    eventsAfter: async (machineId, sessionId, afterSeq, onPage) => {
      const all: Envelope[] = [];
      await api.eventsAfter(machineId, sessionId, afterSeq, (page) => {
        const opened = gate.openAll(page, false);
        all.push(...opened);
        onPage?.(opened);
      });
      return all;
    },
    approvals: async () => {
      if (!gate.anySecured()) return api.approvals();
      const raw = await api.approvalsWithEvents();
      return gate.pendingApprovals(raw.approvals, raw.events, now());
    },
  };
}
