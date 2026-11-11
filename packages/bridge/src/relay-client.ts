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
import { APPROVAL_DECISION_COMMAND, APPROVAL_RESULT_REPLY, ServerFrameSchema, type Envelope } from "@agentmon/shared";
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
  /** Jumlah event yang boleh dikirim tanpa menunggu ack. */
  maxInFlight?: number;
  /**
   * Laju kirim klien sendiri: lonjakan `sendBurst` event, lalu `maxEventsPerSecond` per detik.
   * Bawaannya sedikit di bawah batas relay (lonjakan 100, 50 per detik) supaya antrean besar
   * yang menumpuk selagi terputus terkuras tanpa memicu pemutusan karena terlalu cepat.
   */
  maxEventsPerSecond?: number;
  sendBurst?: number;
  /** Izinkan ws:// atau http:// ke host selain komputer ini. Token dikirim tanpa enkripsi; hanya untuk jaringan tepercaya. */
  allowInsecure?: boolean;
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
export const DEFAULT_EVENTS_PER_SECOND = 40;
export const DEFAULT_SEND_BURST = 50;
const DROP_LOG_WINDOW_MS = 5000;
const RATE_LIMIT_PAUSE_MS = 1000;

// Alamat yang menunjuk ke komputer ini sendiri: lalu lintasnya tidak keluar ke jaringan.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Mengubah alamat relay menjadi alamat WebSocket. Melempar RangeError bila bukan http(s) atau ws(s),
 * atau bila memakai sambungan tanpa enkripsi (http/ws) ke host selain komputer ini kecuali
 * `allowInsecure`: token laptop dikirim di pesan pertama, dan tidak boleh berjalan sebagai teks biasa
 * melewati internet hanya karena salah ketik `http://` di alamat relay.
 */
export function toWebSocketUrl(base: string, allowInsecure = false): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RangeError(`Alamat relay tidak valid: ${base}`);
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new RangeError("Alamat relay harus http(s) atau ws(s)");
  if (url.protocol === "ws:" && !allowInsecure && !isLoopbackHost(url.hostname)) {
    throw new RangeError(
      `Alamat relay ${url.hostname} tidak memakai enkripsi (http/ws), sehingga token laptop akan terkirim sebagai teks biasa. Pakai https:// atau wss://. Hanya untuk jaringan tepercaya, izinkan dengan AGENTMON_RELAY_INSECURE=1.`,
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Isi log tidak boleh memuat teks dari luar mentah-mentah (bisa membawa baris palsu atau escape).
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const wsUrl = toWebSocketUrl(options.url, options.allowInsecure ?? false);
  const logger = options.logger;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const maxEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
  const maxBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const eventsPerSecond = options.maxEventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
  const sendBurst = options.sendBurst ?? DEFAULT_SEND_BURST;
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
  // Pewaktu untuk melanjutkan pengiriman yang tertunda (jatah laju habis, atau jeda karena relay
  // menjawab rate_limited). Hanya satu; pump() yang menjadwalkannya lagi bila masih perlu.
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  let misconfigured = false;
  // Ember berlubang untuk laju kirim sendiri.
  let tokens = sendBurst;
  let tokensAt = now();

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
  // Menjadwalkan pump() nanti. Bila sudah ada jadwal, yang ada dipertahankan (pump() sendiri akan
  // menjadwalkan ulang bila setelah dijalankan masih ada yang tertunda).
  const schedulePump = (delayMs: number) => {
    if (pumpTimer !== undefined) return;
    pumpTimer = setTimeout(
      () => {
        pumpTimer = undefined;
        pump();
      },
      Math.max(1, Math.ceil(delayMs)),
    );
    pumpTimer.unref();
  };

  // Mengambil satu jatah kirim. Mengembalikan 0 bila dapat, atau berapa milidetik lagi jatah berikutnya ada.
  const takeSendToken = (): number => {
    const current = now();
    tokens = Math.min(sendBurst, tokens + (Math.max(0, current - tokensAt) / 1000) * eventsPerSecond);
    tokensAt = current;
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return ((1 - tokens) / eventsPerSecond) * 1000;
  };

  function pump() {
    if (state !== "ready" || !socket) return;
    // Sedang dijeda relay (rate_limited): lanjutkan setelah jeda, jangan ditinggalkan begitu saja.
    if (now() < pausedUntil) return schedulePump(pausedUntil - now());
    let inFlight = queue.filter((entry) => entry.sentAt !== undefined).length;
    for (const entry of queue) {
      if (inFlight >= maxInFlight) break;
      if (entry.sentAt !== undefined) continue;
      const wait = takeSendToken();
      if (wait > 0) return schedulePump(wait);
      try {
        socket.send(entry.text);
      } catch {
        // Soket rusak: lepaskan, lalu sambung ulang dan kirim ulang.
        down(socket);
        return;
      }
      entry.sentAt = now();
      inFlight++;
    }
  }

  // Semua yang sedang menunggu ack dikembalikan ke "belum terkirim" (koneksi putus, atau ack tak datang).
  const requeueInFlight = () => {
    for (const entry of queue) entry.sentAt = undefined;
  };

  const clearConnectionTimers = () => {
    clearTimeout(welcomeTimer);
    clearInterval(ackTimer);
    clearTimeout(pumpTimer);
    welcomeTimer = ackTimer = pumpTimer = undefined;
  };

  // ---- Perintah dari HP ----
  // Mengirim satu bingkai langsung bila koneksi siap. BEST-EFFORT: tidak diantrekan dan tidak diulang. Balasan
  // yang hilang berarti HP menunggu lalu bertanya ulang; tidak ada yang rusak.
  const sendNow = (frame: unknown) => {
    if (state !== "ready" || !socket) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // soket rusak; penanganan putus akan membereskannya
    }
  };

  const handleCommand = (deviceId: string, body: Record<string, unknown>) => {
    const { type, commandId, ...rest } = body;
    if (type !== APPROVAL_DECISION_COMMAND) {
      logger?.info(`relay: perintah tidak dikenal type=${printable(String(type))}`);
      return;
    }
    // Balasan hanya bila HP menyertakan nomor perintah (perintah lama tanpa nomor tetap diterapkan, tanpa balasan).
    const replyTo = typeof commandId === "string" && commandId !== "" ? commandId : undefined;
    const approvalId = typeof rest.approvalId === "string" ? rest.approvalId : "";
    const reply = (outcome: "applied" | "already_resolved" | "unknown" | "invalid", status?: string) => {
      if (replyTo === undefined || approvalId === "") return;
      sendNow({
        kind: "reply",
        deviceId,
        body: { type: APPROVAL_RESULT_REPLY, commandId: replyTo, approvalId, outcome, ...(status !== undefined ? { status } : {}) },
      });
    };
    try {
      const result = options.decide(rest) as { ok?: boolean; reason?: string; status?: string; approval?: { status?: string } } | undefined;
      // Hanya hasil dan alasannya yang dicatat, tidak pernah komentar atau isi keputusan.
      logger?.info(`relay: keputusan dari HP ${result?.ok ? "diterapkan" : `ditolak (${printable(String(result?.reason ?? "tidak diketahui"))})`}`);
      if (result?.ok) reply("applied", result.approval?.status);
      else if (result?.reason === "already_resolved") reply("already_resolved", result.status);
      else if (result?.reason === "unknown") reply("unknown");
      else reply("invalid");
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
          if (socket) down(socket);
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
        handleCommand(frame.deviceId, frame.body);
        return;
      case "error": {
        logger?.error(`relay menolak: ${frame.code}`);
        if (frame.code === "rate_limited") {
          // Terlalu cepat: berhenti sebentar. Yang ditolak tidak di-ack, jadi dikirim ulang setelah batas ack.
          pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
          schedulePump(RATE_LIMIT_PAUSE_MS);
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

    // Batas waktu untuk SELURUH tahap menyambung: terbuka lalu dijawab `welcome`. Perlu karena sebuah
    // percobaan bisa menggantung tanpa kabar apa pun (jaringan yang menelan paket, firewall).
    welcomeTimer = setTimeout(() => {
      logger?.error("relay: tidak ada jawaban hello tepat waktu");
      down(current);
    }, welcomeTimeoutMs);
    welcomeTimer.unref();

    current.addEventListener("open", () => {
      if (socket !== current) return;
      try {
        current.send(JSON.stringify({ kind: "hello", role: "machine", token: options.token }));
      } catch {
        down(current);
      }
    });
    current.addEventListener("message", (message) => {
      if (socket === current) handleFrame((message as MessageEvent).data);
    });
    // `error` dan `close` sama-sama dianggap koneksi ini sudah tidak ada. Tidak cukup menunggu
    // `close`: WebSocket bawaan Node 22 hanya memicu `error` (tanpa `close`) untuk koneksi yang
    // ditolak, sehingga klien menggantung selamanya di "menyambung" saat relay sedang mati.
    // `down` aman dipanggil berkali-kali untuk koneksi yang sama.
    current.addEventListener("error", () => down(current));
    current.addEventListener("close", () => down(current));
  }

  // Koneksi `current` sudah tidak berguna (ditolak, putus, atau tak menjawab): bersihkan lalu jadwalkan
  // penyambungan ulang. Hanya berlaku sekali untuk tiap koneksi.
  function down(current: WebSocket) {
    if (socket !== current) return;
    socket = undefined;
    clearConnectionTimers();
    requeueInFlight();
    if (state === "ready") logger?.info("relay: koneksi terputus, mencoba lagi");
    try {
      current.close();
    } catch {
      // sudah tertutup
    }
    scheduleReconnect();
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
