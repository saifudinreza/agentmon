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
import type { DeviceMachine, Envelope, SessionSummary } from "@agentmon/shared";
import { applyEventToSessions, mergeEvents } from "../timeline/events";
import { RelayApiError, type RelayApi } from "./api";
import { createDeviceConnection, type ConnectionStatus, type DeviceConnection, type DeviceConnectionOptions } from "./connection";

export type SessionLoad = "loading" | "ready" | "error" | "not-found";

export type RelayState = {
  status: ConnectionStatus;
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

export type RelayStore = {
  getState(): RelayState;
  subscribe(listener: () => void): () => void;
  /** Mengambil ulang laptop, sesi, dan event sesi yang terbuka. */
  refresh(): Promise<void>;
  openSession(machineId: string, sessionId: string): void;
  closeSession(machineId: string, sessionId: string): void;
  /** Mengulang pemuatan sesi yang gagal. */
  retrySession(machineId: string, sessionId: string): void;
  reconnectNow(): void;
  /** Membuka koneksi. Aman dipanggil berulang; setelah `stop` bisa dimulai lagi. */
  start(): void;
  stop(): void;
};

export type RelayStoreOptions = {
  relayUrl: string;
  token: string;
  api: RelayApi;
  /** Hanya untuk test: pengganti pembuat koneksi WebSocket. */
  connect?: (options: DeviceConnectionOptions) => DeviceConnection;
  watchPage?: boolean;
};

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

export function createRelayStore(options: RelayStoreOptions): RelayStore {
  const { api } = options;
  let state: RelayState = { status: "connecting", machines: [], machinesLoaded: false, sessions: {}, events: {}, load: {}, syncError: false };
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
  const handleEvent = (event: Envelope) => {
    set((s) => {
      const knownMachine = s.machines.some((m) => m.id === event.machineId);
      let next = s;
      // Ringkasan sesi diperbarui untuk laptop yang dikenal, supaya sesi baru langsung muncul di daftar.
      if (knownMachine) {
        const current = s.sessions[event.machineId] ?? [];
        const updated = applyEventToSessions(current, event);
        if (updated !== current) next = { ...next, sessions: { ...next.sessions, [event.machineId]: updated } };
      }
      const key = sessionKey(event.machineId, event.sessionId);
      if (open.has(key)) {
        const existing = s.events[key] ?? [];
        const merged = mergeEvents(existing, [event]);
        if (merged !== existing) next = { ...next, events: { ...next.events, [key]: merged } };
      }
      return next;
    });
  };

  const connect = () =>
    (options.connect ?? createDeviceConnection)({
      relayUrl: options.relayUrl,
      token: options.token,
      ...(options.watchPage !== undefined ? { watchPage: options.watchPage } : {}),
      onEvent: handleEvent,
      onStatus: (status) => set((s) => (s.status === "revoked" ? s : { ...s, status })),
      onReady: () => void refresh(),
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
    reconnectNow: () => connection?.reconnectNow(),
    start() {
      if (connection) return;
      stopped = false;
      connection = connect();
    },
    stop() {
      stopped = true;
      connection?.close();
      connection = undefined;
    },
  };
}
