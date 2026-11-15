// =====================================================================================
// FILE INI: klien API baca riwayat = "PETUGAS YANG MENGAMBIL ARSIP" dari relay.
// =====================================================================================
//
// HP memakai ini untuk membaca laptop terpasang, daftar sesi, dan event sebuah sesi. Semua jawaban
// diperiksa dengan skema bersama (@agentmon/shared) sebelum dipakai: relay versi lain atau jawaban rusak
// tidak boleh membuat tampilan gagal dengan cara yang membingungkan.
//
// Galat dikelompokkan dalam beberapa jenis supaya tampilan bisa memilih pesan yang tepat, dan tidak
// pernah memuat token maupun isi jawaban.
import {
  ApprovalsResponseSchema,
  DevicesResponseSchema,
  type ListedDevice,
  EventsResponseSchema,
  MachinesResponseSchema,
  PushConfigResponseSchema,
  PushPreferencesSchema,
  SessionsResponseSchema,
  type DeviceMachine,
  type Envelope,
  type PendingApproval,
  type PushConfigResponse,
  type PushPreferences,
  type PushPreferencesUpdate,
  type PushSubscriptionRequest,
  type SessionSummary,
} from "@agentmon/shared";

export type RelayApiErrorKind =
  | "unauthorized" // token HP ditolak (misalnya perangkat dicabut)
  | "not-found" // laptop tidak (lagi) dipasangkan
  | "rate-limited"
  | "unreachable" // jaringan putus atau batas waktu
  | "bad-response" // jawaban tidak sesuai kontrak
  | "server"; // galat relay

export class RelayApiError extends Error {
  constructor(readonly kind: RelayApiErrorKind) {
    super(kind);
    this.name = "RelayApiError";
  }
}

export type RelayApi = {
  machines(): Promise<DeviceMachine[]>;
  /** Permintaan izin yang masih menunggu, dari semua laptop yang dipasangkan. */
  approvals(): Promise<PendingApproval[]>;
  /** Perangkat yang berbagi laptop dengan HP ini (termasuk dirinya, ditandai `current`). */
  devices(): Promise<ListedDevice[]>;
  /** Mencabut sebuah perangkat. Berlaku seketika di relay. */
  revokeDevice(deviceId: string): Promise<void>;
  /** Apakah relay menyalakan push, dan kunci publik VAPID untuk berlangganan. */
  pushConfig(): Promise<PushConfigResponse>;
  /** Mendaftarkan langganan push HP ini (menggantikan yang lama). Gagal `bad-response` bila relay menolak bentuknya. */
  savePushSubscription(subscription: PushSubscriptionRequest): Promise<void>;
  /** Berhenti menerima notifikasi di HP ini. */
  removePushSubscription(): Promise<void>;
  /** Jenis notifikasi yang diinginkan HP ini. Gagal `not-found` bila belum berlangganan. */
  pushPreferences(): Promise<PushPreferences>;
  /** Mengubah jenis notifikasi (yang tidak disebut tetap) dan mengembalikan hasilnya. */
  savePushPreferences(update: PushPreferencesUpdate): Promise<PushPreferences>;
  sessions(machineId: string): Promise<SessionSummary[]>;
  events(machineId: string, sessionId: string, afterSeq: number, limit?: number): Promise<{ events: Envelope[]; hasMore: boolean }>;
  /** Semua event sesudah `afterSeq`, mengikuti halaman sampai habis. `onPage` dipanggil tiap halaman supaya layar bisa terisi bertahap. */
  eventsAfter(machineId: string, sessionId: string, afterSeq: number, onPage?: (events: Envelope[]) => void): Promise<Envelope[]>;
};

export type RelayApiOptions = {
  relayUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;
// Pengaman: sesi dengan jutaan event tidak boleh membuat HP mengunduh tanpa henti.
const MAX_PAGES = 200;

export function createRelayApi(options: RelayApiOptions): RelayApi {
  const base = options.relayUrl.replace(/\/+$/, "");
  const http = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get<T>(path: string, parse: (json: unknown) => T, method: "GET" | "DELETE" | "PUT" = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await http(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${options.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RelayApiError("unreachable");
    }
    if (response.status === 401) throw new RelayApiError("unauthorized");
    if (response.status === 404) throw new RelayApiError("not-found");
    if (response.status === 429) throw new RelayApiError("rate-limited");
    if (!response.ok) throw new RelayApiError("server");
    try {
      return parse(await response.json());
    } catch {
      throw new RelayApiError("bad-response");
    }
  }

  const events: RelayApi["events"] = (machineId, sessionId, afterSeq, limit = PAGE_SIZE) =>
    get(
      `/api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
      (json) => EventsResponseSchema.parse(json),
    );

  return {
    machines: () => get("/api/machines", (json) => MachinesResponseSchema.parse(json).machines),
    devices: () => get("/api/devices", (json) => DevicesResponseSchema.parse(json).devices),
    revokeDevice: (deviceId) =>
      get(`/api/devices/${encodeURIComponent(deviceId)}`, () => undefined, "DELETE"),
    approvals: () => get("/api/approvals", (json) => ApprovalsResponseSchema.parse(json).approvals),
    pushConfig: () => get("/api/push/key", (json) => PushConfigResponseSchema.parse(json)),
    savePushSubscription: (subscription) => get("/api/push/subscription", () => undefined, "PUT", subscription),
    removePushSubscription: () => get("/api/push/subscription", () => undefined, "DELETE"),
    pushPreferences: () => get("/api/push/preferences", (json) => PushPreferencesSchema.parse(json)),
    savePushPreferences: (update) => get("/api/push/preferences", (json) => PushPreferencesSchema.parse(json), "PUT", update),
    sessions: (machineId) => get(`/api/machines/${encodeURIComponent(machineId)}/sessions`, (json) => SessionsResponseSchema.parse(json).sessions),
    events,
    async eventsAfter(machineId, sessionId, afterSeq, onPage) {
      const all: Envelope[] = [];
      let after = afterSeq;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await events(machineId, sessionId, after);
        if (result.events.length > 0) {
          all.push(...result.events);
          onPage?.(result.events);
          after = Math.max(after, ...result.events.map((e) => e.seq));
        }
        // Berhenti bila halaman tidak penuh, atau bila halaman penuh tetapi tidak maju (relay yang rusak).
        if (!result.hasMore || result.events.length === 0) break;
      }
      return all;
    },
  };
}
