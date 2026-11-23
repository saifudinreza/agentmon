// =====================================================================================
// FILE INI: pusat data satu relay di HP = "MEJA REDAKSI" yang menyatukan kabar dari dua jalur.
// =====================================================================================
//
// Kabar tiba dari dua jalur:
//   1. DORONGAN langsung lewat WebSocket (event baru, secepat mungkin);
//   2. PENGAMBILAN riwayat lewat API (saat layar dibuka, dan untuk menambal yang terlewat).
// Meja redaksi menyatukannya jadi satu keadaan yang rapi: laptop, sesi, dan event, tanpa ganda dan
// berurutan (lihat timeline/events.ts), lalu memberi tahu layar bila ada yang berubah.
//
// MENAMBAL YANG TERLEWAT: setiap kali koneksi siap (pertama kali, sambung ulang, atau HP dibuka dari kunci),
// daftar laptop dan sesi diambil ulang, dan untuk sesi yang sedang dibuka layar, event setelah nomor urut
// terakhir yang dimiliki diambil. Karena relay menyimpan event SEBELUM me-ack, semua yang pernah dikirim
// laptop ada di riwayat, jadi tidak ada yang hilang walau HP sedang offline.
//
// MEMORI: event hanya disimpan untuk sesi yang SEDANG DIBUKA. Sesi lain cukup ringkasannya (diperbarui dari
// event langsung), dan event-nya diambil saat sesi dibuka.
import {
  APPROVAL_DECISION_COMMAND,
  ApprovalReplySchema,
  type DeviceMachine,
  type Envelope,
  type FinalApprovalStatus,
  type PendingApproval,
  type SessionSummary,
} from "@agentmon/shared";
import { approvalFromEvent, approvalKey, mergeApprovals, resolutionFromEvent, type Resolution } from "../approvals/model";
import { applyEventToSessions, mergeEvents } from "../timeline/events";
import { gatedApi, type E2eGate } from "../e2e/gate";
import { RelayApiError, type RelayApi } from "./api";
import { createDeviceConnection, type ConnectionStatus, type DeviceConnection, type DeviceConnectionOptions } from "./connection";

export type SessionLoad = "loading" | "ready" | "error" | "not-found";

/**
 * Nasib sebuah keputusan yang dikirim dari HP ini:
 *   sending    sedang dikirim lewat koneksi
 *   sent       sudah dikirim, menunggu konfirmasi laptop
 *   applied    keputusan ini yang berlaku (`status` = hasilnya)
 *   conflict   perangkat lain (atau waktu habis) memutuskan lebih dulu; `status` = yang berlaku
 *   expired    permintaan sudah lewat batas waktu atau tidak dikenal laptop lagi
 *   failed     tidak sampai atau ditolak (`reason`): bisa dicoba lagi
 */
export type DecisionPhase = "sending" | "sent" | "applied" | "conflict" | "expired" | "failed";
export type DecisionFailure = "offline" | "laptop-offline" | "not-allowed" | "rate-limited" | "invalid" | "unconfirmed";
export type DecisionState = {
  phase: DecisionPhase;
  decision: "approve" | "deny";
  commandId: string;
  status?: Resolution;
  reason?: DecisionFailure;
};

export type RelayState = {
  status: ConnectionStatus;
  /** Permintaan izin yang menunggu keputusan, dari semua laptop relay ini. */
  approvals: readonly PendingApproval[];
  approvalsLoaded: boolean;
  /** Hasil izin yang sudah selesai (kunci = approvalKey), untuk menjelaskan layar yang masih terbuka. */
  resolved: Readonly<Record<string, Resolution>>;
  /** Keputusan yang dikirim dari HP ini (kunci = approvalKey). */
  decisions: Readonly<Record<string, DecisionState>>;
  machines: readonly DeviceMachine[];
  machinesLoaded: boolean;
  /** Ringkasan sesi per laptop. */
  sessions: Readonly<Record<string, readonly SessionSummary[]>>;
  /** Event per sesi, kuncinya `${machineId}/${sessionId}`. Hanya untuk sesi yang sedang dibuka. */
  events: Readonly<Record<string, readonly Envelope[]>>;
  load: Readonly<Record<string, SessionLoad>>;
  /** Pembaruan terakhir gagal (jaringan, relay); yang tampil adalah data terakhir yang diketahui. */
  syncError: boolean;
};

export type RequestFailure = "offline" | "laptop-offline" | "not-allowed" | "rate-limited" | "unconfirmed";
export type RequestResult = { ok: true; reply: Record<string, unknown> } | { ok: false; reason: RequestFailure };
/** Berapa lama `request` menunggu balasan laptop (rollback pada repo besar bisa memakan waktu). */
export const REQUEST_TIMEOUT_MS = 60_000;

export type RelayStore = {
  /** API baca/tulis ke relay, untuk layar yang butuh panggilan sendiri (mis. daftar perangkat). */
  readonly api: RelayApi;
  getState(): RelayState;
  subscribe(listener: () => void): () => void;
  /** Mengambil ulang laptop, sesi, dan event sesi yang terbuka. */
  refresh(): Promise<void>;
  openSession(machineId: string, sessionId: string): void;
  closeSession(machineId: string, sessionId: string): void;
  /** Mengulang pemuatan sesi yang gagal. */
  retrySession(machineId: string, sessionId: string): void;
  /** Mengirim keputusan sebuah izin ke laptop. Hasilnya tampil di `decisions`. */
  decide(machineId: string, approvalId: string, decision: "approve" | "deny", comment?: string): void;
  /**
   * Mengirim perintah ke laptop dan menunggu balasannya (dicocokkan lewat nomor perintah). Nomor perintah diisi store.
   * Tidak pernah menolak (reject): kegagalan jaringan, laptop mati, ditolak relay, dan waktu habis menjadi `ok: false`.
   */
  request(machineId: string, body: Record<string, unknown>, timeoutMs?: number): Promise<RequestResult>;
  reconnectNow(): void;
  /** Membuka koneksi. Aman dipanggil berulang; setelah `stop` bisa dimulai lagi. */
  start(): void;
  stop(): void;
};

export type RelayStoreOptions = {
  relayUrl: string;
  token: string;
  api: RelayApi;
  /**
   * Gerbang E2E (issue #033). Bila ada, SEMUA yang masuk dari relay (event langsung, riwayat, antrean izin, balasan) diperiksa dan dibuka
   * lebih dulu, dan semua perintah ke laptop E2E ditutup dan ditandatangani. Laptop yang tidak dipasangkan secara E2E lewat apa adanya.
   */
  e2e?: E2eGate;
  /** Hanya untuk test: pengganti pembuat koneksi WebSocket. */
  connect?: (options: DeviceConnectionOptions) => DeviceConnection;
  watchPage?: boolean;
  /** Hanya untuk test: pembuat nomor perintah dan batas menunggu konfirmasi laptop. */
  newId?: () => string;
  confirmTimeoutMs?: number;
};

const MAX_RESOLVED_KEPT = 200;
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
// Galat dari relay tidak menyebut perintah mana; dikaitkan dengan keputusan yang baru saja dikirim.
const ERROR_ATTRIBUTION_MS = 5000;

// Status yang berarti keputusan setuju atau tolak berlaku persis seperti yang diminta.
const EXPECTED_STATUS = { approve: "approved", deny: "denied" } as const;

export const sessionKey = (machineId: string, sessionId: string) => `${machineId}/${sessionId}`;

// Gabungan ringkasan dari relay dan yang diperbarui lokal oleh event langsung: yang lebih baru menang per sesi.
function mergeSessions(fetched: readonly SessionSummary[], local: readonly SessionSummary[]): readonly SessionSummary[] {
  const byId = new Map(fetched.map((s) => [s.sessionId, s]));
  for (const mine of local) {
    const theirs = byId.get(mine.sessionId);
    if (!theirs || mine.lastEventAt > theirs.lastEventAt) byId.set(mine.sessionId, mine);
  }
  return [...byId.values()].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
}

// Sebuah izin selesai: keluar dari antrean, hasilnya dicatat, dan keputusan HP ini yang masih menunggu dijelaskan.
function applyResolution(state: RelayState, machineId: string, approvalId: string, status: Resolution): RelayState {
  const key = approvalKey(machineId, approvalId);
  const approvals = state.approvals.filter((a) => approvalKey(a.machineId, a.approvalId) !== key);
  let resolved: Record<string, Resolution> = { ...state.resolved, [key]: status };
  const keys = Object.keys(resolved);
  if (keys.length > MAX_RESOLVED_KEPT) {
    resolved = Object.fromEntries(keys.slice(keys.length - MAX_RESOLVED_KEPT).map((k) => [k, resolved[k] as Resolution]));
  }

  let decisions = state.decisions;
  const mine = decisions[key];
  if (mine && (mine.phase === "sending" || mine.phase === "sent")) {
    // Belum ada balasan laptop, tetapi hasilnya sudah terlihat dari event: cocok dengan keputusan kita atau tidak.
    const matches = status === EXPECTED_STATUS[mine.decision];
    decisions = { ...decisions, [key]: { ...mine, phase: matches ? "applied" : "conflict", status } };
  }
  return { ...state, approvals, resolved, decisions };
}

export function createRelayStore(options: RelayStoreOptions): RelayStore {
  const gate = options.e2e;
  const api = gate ? gatedApi(options.api, gate) : options.api;
  let state: RelayState = {
    status: "connecting",
    approvals: [],
    approvalsLoaded: false,
    resolved: {},
    decisions: {},
    machines: [],
    machinesLoaded: false,
    sessions: {},
    events: {},
    load: {},
    syncError: false,
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const newId = options.newId ?? (() => crypto.randomUUID());
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  const open = new Map<string, { machineId: string; sessionId: string; count: number }>();
  let stopped = true; // belum dimulai
  let connection: DeviceConnection | undefined;

  const set = (patch: (current: RelayState) => RelayState) => {
    if (stopped) return;
    const next = patch(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  // ---- Pengambilan riwayat ----
  // Titik "sudah sinkron dari riwayat" per sesi: nomor urut terbesar yang sudah DIAMBIL lewat API. Sengaja
  // terpisah dari event yang dimiliki. Event langsung (dorongan) ikut menambah daftar event, tetapi tidak
  // boleh memajukan titik ini: bila event langsung bernomor 12 tiba selagi event 5-11 terlewat (HP baru
  // dibuka dari kunci), pengambilan "setelah 12" akan melompati 5-11 selamanya. Pengambilan selalu
  // dilanjutkan dari titik ini, dan event yang sudah ada digabung tanpa ganda.
  const synced = new Map<string, number>();

  // Mengembalikan true bila berhasil (agar pemanggil tahu apakah keadaan boleh dianggap sehat).
  const catchUp = async (machineId: string, sessionId: string): Promise<boolean> => {
    const key = sessionKey(machineId, sessionId);
    if (!synced.has(key)) set((s) => ({ ...s, load: { ...s.load, [key]: "loading" } }));
    try {
      await api.eventsAfter(machineId, sessionId, synced.get(key) ?? -1, (page) => {
        if (!open.has(key)) return; // layar sudah menutup sesi ini
        synced.set(key, Math.max(synced.get(key) ?? -1, ...page.map((e) => e.seq)));
        set((s) => ({ ...s, events: { ...s.events, [key]: mergeEvents(s.events[key] ?? [], page) } }));
      });
      if (open.has(key)) {
        if (!synced.has(key)) synced.set(key, -1); // sesi kosong: sudah sinkron, belum ada apa pun
        set((s) => ({ ...s, load: { ...s.load, [key]: "ready" } }));
      }
      return true;
    } catch (error) {
      if (error instanceof RelayApiError && error.kind === "unauthorized") {
        revoke();
        return false;
      }
      // Yang sudah tampil dipertahankan. Bila pemuatan pertama belum selesai, sesi ditandai gagal (agar
      // layar menawarkan coba lagi); bila hanya penambalan yang gagal, cukup memberi tanda galat.
      const failure: SessionLoad = error instanceof RelayApiError && error.kind === "not-found" ? "not-found" : "error";
      set((s) => (open.has(key) && s.load[key] !== "ready" ? { ...s, load: { ...s.load, [key]: failure } } : { ...s, syncError: true }));
      return false;
    }
  };

  const revoke = () => {
    connection?.close();
    set((s) => ({ ...s, status: "revoked" }));
  };

  let syncing: Promise<void> | undefined;
  let syncAgain = false;
  const refresh = (): Promise<void> => {
    if (syncing) {
      syncAgain = true; // permintaan baru saat masih berjalan: ulangi sekali setelahnya
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        try {
          const machines = await api.machines();
          set((s) => ({ ...s, machines, machinesLoaded: true }));
          await Promise.all(
            machines.map(async (machine) => {
              const fetched = await api.sessions(machine.id);
              set((s) => ({ ...s, sessions: { ...s.sessions, [machine.id]: mergeSessions(fetched, s.sessions[machine.id] ?? []) } }));
            }),
          );
          // Antrean izin yang menunggu. Yang diterima langsung selagi pengambilan berjalan tidak hilang.
          const approvals = await api.approvals();
          set((s) => ({ ...s, approvalsLoaded: true, approvals: mergeApprovals(approvals, s.approvals, s.resolved) }));
          const caughtUp = await Promise.all([...open.values()].map((o) => catchUp(o.machineId, o.sessionId)));
          // Hanya dianggap sehat bila SEMUA berhasil: gagal menambal satu sesi tidak boleh tersembunyi.
          if (caughtUp.every(Boolean)) set((s) => (s.syncError ? { ...s, syncError: false } : s));
        } catch (error) {
          if (error instanceof RelayApiError && error.kind === "unauthorized") return revoke();
          set((s) => ({ ...s, machinesLoaded: true, syncError: true }));
        }
      } while (syncAgain && !stopped);
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  };

  // ---- Event langsung ----
  const handleEvent = (incoming: Envelope) => {
    // Gerbang E2E: event dari laptop E2E hanya diterima bila terenkripsi dan bertanda tangan sah; yang gagal dibuang.
    const event = gate ? gate.open(incoming, true) : incoming;
    if (!event) return;
    set((s) => {
      const knownMachine = s.machines.some((m) => m.id === event.machineId);
      let next = s;
      // Ringkasan sesi diperbarui untuk laptop yang dikenal, supaya sesi baru langsung muncul di daftar.
      if (knownMachine) {
        const current = s.sessions[event.machineId] ?? [];
        const updated = applyEventToSessions(current, event);
        if (updated !== current) next = { ...next, sessions: { ...next.sessions, [event.machineId]: updated } };
      }
      // Permintaan izin baru menambah antrean; penyelesaiannya mengurangi dan menjelaskan keputusan yang sedang menunggu.
      const requested = approvalFromEvent(event);
      if (requested && knownMachine) {
        const merged = mergeApprovals(next.approvals, [requested], next.resolved);
        if (merged.length !== next.approvals.length || merged.some((a, i) => a !== next.approvals[i])) next = { ...next, approvals: merged };
      }
      const resolution = resolutionFromEvent(event);
      if (resolution) next = applyResolution(next, resolution.machineId, resolution.approvalId, resolution.status);

      const key = sessionKey(event.machineId, event.sessionId);
      if (open.has(key)) {
        const existing = s.events[key] ?? [];
        const merged = mergeEvents(existing, [event]);
        if (merged !== existing) next = { ...next, events: { ...next.events, [key]: merged } };
      }
      return next;
    });
  };

  // Balasan laptop atas keputusan HP ini: hasil yang sebenarnya berlaku.
  // Permintaan umum (request) yang menunggu balasan: nomor perintah -> penyelesai.
  const pendingRequests = new Map<string, { machineId: string; sentAt: number; done: (result: RequestResult) => void }>();

  const handleReply = (machineId: string, received: Record<string, unknown>) => {
    // Balasan dari laptop E2E harus terenkripsi dan bertanda tangan laptop itu; yang polos atau diubah dibuang.
    const body = gate ? gate.openReply(machineId, received) : received;
    if (!body) return;
    const waiting = typeof body.commandId === "string" ? pendingRequests.get(body.commandId) : undefined;
    // Balasan hanya diterima dari laptop yang kita kirimi perintahnya.
    if (waiting && waiting.machineId === machineId) {
      waiting.done({ ok: true, reply: body });
      return;
    }
    const parsed = ApprovalReplySchema.safeParse(body);
    if (!parsed.success) return;
    const reply = parsed.data;
    const key = approvalKey(machineId, reply.approvalId);
    set((s) => {
      const mine = s.decisions[key];
      if (!mine || mine.commandId !== reply.commandId) return s; // bukan balasan untuk keputusan yang kita tunggu
      const status = reply.status as FinalApprovalStatus | undefined;
      let phase: DecisionPhase;
      if (reply.outcome === "applied") phase = "applied";
      else if (reply.outcome === "already_resolved") phase = status === "timed_out" ? "expired" : "conflict";
      else if (reply.outcome === "unknown") phase = "expired";
      else phase = "failed";
      const decision: DecisionState = { ...mine, phase, ...(status !== undefined ? { status } : {}), ...(phase === "failed" ? { reason: "invalid" as const } : {}) };
      // Izin yang tidak dikenal laptop lagi tidak akan pernah selesai lewat event: keluarkan dari antrean.
      const approvals = phase === "expired" ? s.approvals.filter((a) => approvalKey(a.machineId, a.approvalId) !== key) : s.approvals;
      return { ...s, approvals, decisions: { ...s.decisions, [key]: decision } };
    });
  };

  // Relay menolak sesuatu yang dikirim HP ini. Tidak menyebut perintah mana, jadi dikaitkan dengan keputusan yang
  // baru saja dikirim dan masih menunggu.
  const sentAtByCommand = new Map<string, number>();
  const handleRelayError = (code: string) => {
    const reason: DecisionFailure | undefined = code === "target_offline" ? "laptop-offline" : code === "forbidden" ? "not-allowed" : code === "rate_limited" ? "rate-limited" : undefined;
    if (!reason) return;
    const now = Date.now();
    // Permintaan umum yang baru dikirim ikut gagal dengan alasan yang sama.
    for (const waiting of [...pendingRequests.values()]) {
      if (now - waiting.sentAt < ERROR_ATTRIBUTION_MS) waiting.done({ ok: false, reason });
    }
    set((s) => {
      let decisions = s.decisions;
      for (const [key, d] of Object.entries(s.decisions)) {
        if (d.phase === "sent" && now - (sentAtByCommand.get(d.commandId) ?? 0) < ERROR_ATTRIBUTION_MS) {
          decisions = { ...decisions, [key]: { ...d, phase: "failed", reason } };
        }
      }
      return decisions === s.decisions ? s : { ...s, decisions };
    });
  };

  // Perintah ke laptop E2E ditutup dan ditandatangani; ke laptop lain apa adanya. undefined = tidak bisa disegel (tidak boleh dikirim).
  const sealForMachine = (machineId: string, body: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!gate || !gate.isSecured(machineId)) return body;
    const sealed = gate.sealCommand(machineId, body);
    return sealed.ok ? { ...sealed.body } : undefined;
  };

  const connect = () =>
    (options.connect ?? createDeviceConnection)({
      relayUrl: options.relayUrl,
      token: options.token,
      ...(options.watchPage !== undefined ? { watchPage: options.watchPage } : {}),
      onEvent: handleEvent,
      onStatus: (status) => set((s) => (s.status === "revoked" ? s : { ...s, status })),
      onReady: () => void refresh(),
      onReply: handleReply,
      onError: handleRelayError,
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    openSession(machineId, sessionId) {
      const key = sessionKey(machineId, sessionId);
      const entry = open.get(key);
      if (entry) {
        entry.count++;
        return;
      }
      open.set(key, { machineId, sessionId, count: 1 });
      void catchUp(machineId, sessionId);
    },
    closeSession(machineId, sessionId) {
      const key = sessionKey(machineId, sessionId);
      const entry = open.get(key);
      if (!entry) return;
      if (--entry.count > 0) return;
      open.delete(key);
      synced.delete(key);
      // Melepas event sesi ini dari memori; diambil ulang saat dibuka lagi.
      set((s) => {
        const events = { ...s.events };
        const load = { ...s.load };
        delete events[key];
        delete load[key];
        return { ...s, events, load };
      });
    },
    retrySession(machineId, sessionId) {
      void catchUp(machineId, sessionId);
    },
    api,
    decide(machineId, approvalId, decision, comment) {
      const key = approvalKey(machineId, approvalId);
      const commandId = newId();
      const trimmed = comment?.trim().slice(0, 2000);
      set((s) => ({ ...s, decisions: { ...s.decisions, [key]: { phase: "sending", decision, commandId } } }));

      const plain = { type: APPROVAL_DECISION_COMMAND, commandId, approvalId, decision, ...(trimmed ? { comment: trimmed } : {}) };
      const wire = sealForMachine(machineId, plain);
      if (!wire) {
        // Laptop E2E tetapi tidak ada catatan izin ini di HP (belum pernah dilihat/diverifikasi): tidak boleh diputuskan.
        set((s) => ({ ...s, decisions: { ...s.decisions, [key]: { phase: "failed", decision, commandId, reason: "invalid" } } }));
        return;
      }
      const sent = connection?.send({ kind: "command", machineId, body: wire });
      if (!sent) {
        set((s) => ({ ...s, decisions: { ...s.decisions, [key]: { phase: "failed", decision, commandId, reason: "offline" } } }));
        return;
      }
      sentAtByCommand.set(commandId, Date.now());
      set((s) => (s.decisions[key]?.commandId === commandId ? { ...s, decisions: { ...s.decisions, [key]: { phase: "sent", decision, commandId } } } : s));

      // Tanpa balasan dalam batas waktu: jangan menggantung selamanya.
      const timer = setTimeout(() => {
        timers.delete(timer);
        sentAtByCommand.delete(commandId);
        set((s) => {
          const mine = s.decisions[key];
          return mine?.commandId === commandId && mine.phase === "sent" ? { ...s, decisions: { ...s.decisions, [key]: { ...mine, phase: "failed", reason: "unconfirmed" } } } : s;
        });
      }, confirmTimeoutMs);
      timers.add(timer);
    },
    request(machineId, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      return new Promise<RequestResult>((resolve) => {
        const commandId = newId();
        const hold: { timer?: ReturnType<typeof setTimeout> } = {};
        const done = (result: RequestResult) => {
          if (!pendingRequests.delete(commandId)) return;
          if (hold.timer) {
            clearTimeout(hold.timer);
            timers.delete(hold.timer);
          }
          resolve(result);
        };
        pendingRequests.set(commandId, { machineId, sentAt: Date.now(), done });
        const wire = sealForMachine(machineId, { ...body, commandId });
        if (!wire) return done({ ok: false, reason: "not-allowed" }); // tidak bisa disegel (tidak ada kunci): tidak dikirim polos
        const sent = connection?.send({ kind: "command", machineId, body: wire });
        if (!sent) return done({ ok: false, reason: "offline" });
        hold.timer = setTimeout(() => done({ ok: false, reason: "unconfirmed" }), timeoutMs);
        timers.add(hold.timer);
      });
    },
    reconnectNow: () => connection?.reconnectNow(),
    start() {
      if (connection) return;
      stopped = false;
      connection = connect();
    },
    stop() {
      stopped = true;
      for (const waiting of [...pendingRequests.values()]) waiting.done({ ok: false, reason: "offline" });
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      connection?.close();
      connection = undefined;
    },
  };
}
