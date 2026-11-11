// =====================================================================================
// FILE INI: klien relay di daemon = "KURIR" yang mengantar event ke relay dan membawa pulang keputusan.
// =====================================================================================
//
// Posisi dalam alur:
//
//   agent --hook--> handler --emit--> [FILE INI: antrean] ==WebSocket==> relay ==> HP
//                                                                          |
//   approval engine <--decide-- [FILE INI] <==== command (keputusan) ======+
//
// ANALOGI: kurir yang mengambil paket dari kotak surat kantor (handler) dan mengantarnya ke kantor
// pos (relay).
//   - Kurir TIDAK membuat kantor menunggu: menaruh paket ke kotak selalu selesai seketika, apa pun
//     keadaan jalan raya. Relay mati, jaringan putus, atau lambat, agent tetap bekerja.
//   - Paket baru dibuang dari catatan kurir setelah kantor pos memberi TANDA TERIMA (`ack`).
//     "Sudah kuserahkan" belum cukup, karena koneksi bisa putus tepat setelah penyerahan.
//   - Paket yang belum bertanda terima diantar ulang setelah jalan pulih. Kantor pos mengenali
//     nomor paket dan tidak meneruskan paket yang sama dua kali. Hasilnya: tidak hilang, tidak ganda.
//   - Kotak kurir ada batasnya. Kalau penuh (relay mati berjam-jam), paket TERLAMA dibuang dan
//     dicatat di log, karena yang terbaru paling berguna dan memori laptop tidak boleh jebol.
//
// PENYAMBUNGAN ULANG: dicoba lagi dengan jeda yang makin panjang (0,5 detik, 1, 2, 4, ... sampai 30
// detik) dan sedikit acak, supaya ratusan laptop yang kehilangan relay bersamaan tidak menyerbu
// relay di detik yang sama saat relay pulih.
//
// KEPUTUSAN DARI HP: relay meneruskannya sebagai `command` dari HP yang dipasangkan. Isinya
// diserahkan ke approval engine (`decide`), yang memeriksa bentuknya sendiri. Perintah dari relay
// diperlakukan sebagai data tak tepercaya.
//
// KETERBATASAN: antrean hanya di memori. Bila daemon dimatikan atau macet saat relay tidak
// terjangkau, event yang belum terkirim hilang. Menyimpannya ke disk bisa ditambahkan nanti.
import { ServerFrameSchema, type Envelope } from "@agentmon/shared";
import type { Logger } from "./logger";

export type RelayClientOptions = {
  /** Alamat relay: http(s)://host atau ws(s)://host. Jalur /ws ditambahkan otomatis. */
  url: string;
  /** Token laptop ini di relay. Tidak pernah dicatat di log. */
  token: string;
  /** Identitas laptop di relay; harus sama dengan `machineId` pada event. */
  machineId: string;
  /** Menyerahkan keputusan dari HP ke approval engine. */
  decide: (input: unknown) => unknown;
  logger?: Logger;

  /** Batas antrean. Yang terlama dibuang bila terlampaui. */
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
  /** Event yang lebih besar dari ini tidak akan diterima relay, jadi langsung dibuang. */
  maxEventBytes?: number;
  /** Jumlah event yang boleh dikirim tanpa menunggu ack. Menjaga laju kirim tetap di bawah batas relay. */
  maxInFlight?: number;
  /** Event yang tidak di-ack selama ini dikirim ulang. */
  ackTimeoutMs?: number;
  /** Batas menunggu `welcome` setelah `hello`. */
  welcomeTimeoutMs?: number;
  /** Jeda penyambungan ulang: mulai dari `min`, berlipat dua, tertinggi `max`. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;

  // Bagian di bawah ini hanya untuk test.
  createSocket?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
};

export type RelayClientState = "connecting" | "ready" | "disconnected" | "closed";

export type RelayClientStats = {
  state: RelayClientState;
  /** Event yang menunggu dikirim. */
  queued: number;
  /** Event yang sudah dikirim tetapi belum di-ack. */
  inFlight: number;
  /** Total event yang sudah di-ack relay. */
  acked: number;
  /** Total event yang dibuang (antrean penuh atau terlalu besar). */
  dropped: number;
  /** Berapa kali koneksi putus lalu dicoba lagi. */
  reconnects: number;
};

export type RelayClient = {
  /** Menitipkan event. Selalu seketika, tidak pernah melempar error, tidak menunggu jaringan. */
  send(event: Envelope): void;
  stats(): RelayClientStats;
  /** Menunggu antrean kosong (semua di-ack) paling lama `timeoutMs`. Mengembalikan true bila kosong. */
  flush(timeoutMs: number): Promise<boolean>;
  close(): void;
};

type Entry = { event: Envelope; text: string; bytes: number; sentAt: number | undefined };

export const DEFAULT_MAX_QUEUED_EVENTS = 5000;
export const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
// Sedikit di bawah batas pesan relay (1 MiB) supaya bingkai pembungkusnya tetap muat.
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024 - 4096;
export const DEFAULT_MAX_IN_FLIGHT = 50;
const DROP_LOG_WINDOW_MS = 5000;
const RATE_LIMIT_PAUSE_MS = 1000;

/** Mengubah alamat relay menjadi alamat WebSocket. Melempar RangeError bila bukan http(s) atau ws(s). */
export function toWebSocketUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RangeError(`Alamat relay tidak valid: ${base}`);
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new RangeError("Alamat relay harus http(s) atau ws(s)");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Isi log tidak boleh memuat teks dari luar mentah-mentah (bisa membawa baris palsu atau escape).
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const wsUrl = toWebSocketUrl(options.url);
  const logger = options.logger;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const maxEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
  const maxBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const welcomeTimeoutMs = options.welcomeTimeoutMs ?? 10_000;
  const reconnectMin = options.reconnectMinMs ?? 500;
  const reconnectMax = options.reconnectMaxMs ?? 30_000;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  // Antrean berurutan; yang di depan paling dulu dikirim. `byId` mencegah event yang sama masuk dua kali.
  const queue: Entry[] = [];
  const byId = new Map<string, Entry>();
  let queuedBytes = 0;

  let state: RelayClientState = "connecting";
  let socket: WebSocket | undefined;
  let attempts = 0;
  let acked = 0;
  let dropped = 0;
  let reconnects = 0;
  let pausedUntil = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  let ackTimer: ReturnType<typeof setInterval> | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let misconfigured = false;

  // ---- Pencatatan pembuangan: tidak membanjiri log saat ribuan event dibuang beruntun ----
  let dropWindowOpen = false;
  let dropsInWindow = 0;
  const noteDrop = (count: number, reason: string) => {
    dropped += count;
    if (!dropWindowOpen) {
      logger?.error(`relay: ${count} event dibuang (${reason}); total dibuang ${dropped}`);
      dropWindowOpen = true;
      dropsInWindow = 0;
      const timer = setTimeout(() => {
        dropWindowOpen = false;
        if (dropsInWindow > 0) logger?.error(`relay: ${dropsInWindow} event lagi dibuang (${reason}); total dibuang ${dropped}`);
      }, DROP_LOG_WINDOW_MS);
      timer.unref();
    } else {
      dropsInWindow += count;
    }
  };

  // ---- Antrean ----
  const remove = (entry: Entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    byId.delete(entry.event.id);
    queuedBytes -= entry.bytes;
  };

  const enqueue = (entry: Entry) => {
    // Disisipkan menurut `seq` di dalam sesi yang sama: penerima asinkron bisa menyelesaikan
    // pekerjaannya tidak berurutan, dan sisipan ini merapikannya sebelum dikirim. Hanya yang
    // belum terkirim yang digeser.
    let position = queue.length;
    while (position > 0) {
      const before = queue[position - 1] as Entry;
      if (before.sentAt !== undefined || before.event.sessionId !== entry.event.sessionId || before.event.seq <= entry.event.seq) break;
      position--;
    }
    queue.splice(position, 0, entry);
    byId.set(entry.event.id, entry);
    queuedBytes += entry.bytes;
  };

  const enforceLimits = () => {
    let removed = 0;
    while (queue.length > maxEvents || queuedBytes > maxBytes) {
      const oldest = queue[0];
      if (!oldest) break;
      remove(oldest);
      removed++;
    }
    if (removed > 0) noteDrop(removed, "antrean penuh, yang terlama dibuang");
  };

  // ---- Mengirim ----
  const pump = () => {
    if (state !== "ready" || !socket || now() < pausedUntil) return;
    let inFlight = queue.filter((entry) => entry.sentAt !== undefined).length;
    for (const entry of queue) {
      if (inFlight >= maxInFlight) break;
      if (entry.sentAt !== undefined) continue;
      try {
        socket.send(entry.text);
      } catch {
        // Soket rusak: tutup, penutupan memicu penyambungan ulang dan pengiriman ulang.
        socket.close();
        return;
      }
      entry.sentAt = now();
      inFlight++;
    }
  };

  // Semua yang sedang menunggu ack dikembalikan ke "belum terkirim" (koneksi putus, atau ack tak datang).
  const requeueInFlight = () => {
    for (const entry of queue) entry.sentAt = undefined;
  };

  const clearConnectionTimers = () => {
    clearTimeout(welcomeTimer);
    clearInterval(ackTimer);
    clearTimeout(pauseTimer);
    welcomeTimer = ackTimer = pauseTimer = undefined;
  };

  // ---- Perintah dari HP ----
  const handleCommand = (body: Record<string, unknown>) => {
    const { type, ...rest } = body;
    if (type !== "approval.decision") {
      logger?.info(`relay: perintah tidak dikenal type=${printable(String(type))}`);
      return;
    }
    try {
      const result = options.decide(rest) as { ok?: boolean; reason?: string } | undefined;
      // Hanya hasil dan alasannya yang dicatat, tidak pernah komentar atau isi keputusan.
      logger?.info(`relay: keputusan dari HP ${result?.ok ? "diterapkan" : `ditolak (${printable(String(result?.reason ?? "tidak diketahui"))})`}`);
    } catch (error) {
      logger?.error(`relay: gagal menerapkan keputusan: ${error instanceof Error ? printable(error.message) : "galat tak dikenal"}`);
    }
  };

  const handleFrame = (data: unknown) => {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerFrameSchema.safeParse(json);
    if (!parsed.success) return; // bingkai dari versi relay yang lebih baru: diabaikan
    const frame = parsed.data;

    switch (frame.kind) {
      case "welcome": {
        if (frame.role !== "machine") return;
        clearTimeout(welcomeTimer);
        // Relay menolak event yang `machineId`-nya berbeda dari identitas koneksi. Lebih baik
        // berhenti dengan pesan yang jelas daripada mengirim event yang pasti ditolak selamanya.
        if (frame.id !== options.machineId) {
          misconfigured = true;
          logger?.error(
            "relay: nomor laptop di relay berbeda dari nomor laptop ini (berkas machine-id). Daftarkan laptop di relay dengan nomor yang sama. Pengiriman dihentikan.",
          );
          socket?.close(1000, "machine id berbeda");
          return;
        }
        state = "ready";
        attempts = 0;
        logger?.info("relay: tersambung");
        ackTimer = setInterval(() => {
          const limit = now() - ackTimeoutMs;
          let stale = false;
          for (const entry of queue) {
            if (entry.sentAt !== undefined && entry.sentAt <= limit) {
              entry.sentAt = undefined;
              stale = true;
            }
          }
          if (stale) pump();
        }, Math.max(10, Math.floor(ackTimeoutMs / 2)));
        ackTimer.unref();
        pump();
        return;
      }
      case "ack": {
        const entry = byId.get(frame.eventId);
        if (!entry) return; // ack untuk event yang sudah dibuang atau pernah di-ack
        remove(entry);
        acked++;
        pump();
        return;
      }
      case "command":
        handleCommand(frame.body);
        return;
      case "error": {
        logger?.error(`relay menolak: ${frame.code}`);
        if (frame.code === "rate_limited") {
          // Terlalu cepat: berhenti sebentar. Yang ditolak tidak di-ack, jadi dikirim ulang setelah batas ack.
          pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
          clearTimeout(pauseTimer);
          pauseTimer = setTimeout(pump, RATE_LIMIT_PAUSE_MS);
          pauseTimer.unref();
        }
        return;
      }
      case "event":
        return; // laptop tidak menerima event
    }
  };

  // ---- Koneksi ----
  const scheduleReconnect = () => {
    if (state === "closed") return;
    state = "disconnected";
    if (misconfigured) return; // salah pengaturan: mencoba lagi tidak akan menolong
    const base = Math.min(reconnectMax, reconnectMin * 2 ** Math.min(attempts, 20));
    // Acak antara 50% dan 100% dari jeda, supaya banyak laptop tidak menyerbu bersamaan.
    const delay = Math.round(base * (0.5 + random() * 0.5));
    attempts++;
    reconnects++;
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref();
  };

  function connect() {
    if (state === "closed") return;
    state = "connecting";
    let current: WebSocket;
    try {
      current = createSocket(wsUrl);
    } catch (error) {
      logger?.error(`relay: gagal membuka koneksi: ${error instanceof Error ? printable(error.message) : "galat tak dikenal"}`);
      scheduleReconnect();
      return;
    }
    socket = current;

    current.addEventListener("open", () => {
      if (socket !== current) return;
      try {
        current.send(JSON.stringify({ kind: "hello", role: "machine", token: options.token }));
      } catch {
        current.close();
        return;
      }
      welcomeTimer = setTimeout(() => {
        logger?.error("relay: tidak ada jawaban hello tepat waktu");
        current.close();
      }, welcomeTimeoutMs);
      welcomeTimer.unref();
    });
    current.addEventListener("message", (message) => {
      if (socket === current) handleFrame((message as MessageEvent).data);
    });
    // Galat selalu disusul penutupan; yang dikerjakan di penutupan saja.
    current.addEventListener("error", () => undefined);
    current.addEventListener("close", () => {
      if (socket !== current) return;
      socket = undefined;
      clearConnectionTimers();
      requeueInFlight();
      if (state === "ready") logger?.info("relay: koneksi terputus, mencoba lagi");
      scheduleReconnect();
    });
  }

  connect();

  return {
    send(event) {
      try {
        if (state === "closed" || byId.has(event.id)) return;
        const text = JSON.stringify({ kind: "event", event });
        const bytes = Buffer.byteLength(text);
        if (bytes > maxEventBytes) {
          noteDrop(1, "terlalu besar untuk relay");
          return;
        }
        enqueue({ event, text, bytes, sentAt: undefined });
        enforceLimits();
        pump();
      } catch (error) {
        // Titipan tidak boleh pernah mengganggu agent.
        logger?.error(`relay: gagal menitipkan event: ${error instanceof Error ? printable(error.message) : "galat tak dikenal"}`);
      }
    },

    stats() {
      const inFlight = queue.filter((entry) => entry.sentAt !== undefined).length;
      return { state, queued: queue.length - inFlight, inFlight, acked, dropped, reconnects };
    },

    async flush(timeoutMs) {
      const deadline = now() + timeoutMs;
      while (queue.length > 0 && now() < deadline && state !== "closed") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return queue.length === 0;
    },

    close() {
      state = "closed";
      clearTimeout(reconnectTimer);
      clearConnectionTimers();
      try {
        socket?.close(1000, "daemon berhenti");
      } catch {
        // sudah tertutup
      }
      socket = undefined;
    },
  };
}
