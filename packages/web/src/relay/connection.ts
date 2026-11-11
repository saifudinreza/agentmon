// =====================================================================================
// FILE INI: sambungan real-time HP ke relay = "TELEPON YANG TERUS TERSAMBUNG" untuk menerima event.
// =====================================================================================
//
// HP membuka WebSocket ke relay dan menyebut siapa dirinya (hello + token). Setelah itu relay mendorong
// event baru dari laptop yang dipasangkan, tanpa HP perlu bertanya terus-menerus.
//
// Sambungan bisa putus kapan saja (sinyal hilang, HP dikunci). Karena itu:
//   - setiap kali tersambung (termasuk sambung ulang), `onReady` dipanggil sehingga pemakainya bisa
//     MENGAMBIL yang terlewat lewat API riwayat. Event yang datang saat putus tidak hilang; hanya diambil
//     belakangan;
//   - sambung ulang otomatis dengan jeda yang berlipat (0,5 detik sampai 15 detik) dan sedikit acak;
//   - saat halaman kembali terlihat (HP dibuka dari kunci) atau jaringan kembali, sambungan LANGSUNG
//     dibuat ulang tanpa menunggu jeda. Setelah HP dikunci, soket bisa sudah mati tanpa kabar apa pun
//     (tidak ada event close), jadi lebih aman membukanya ulang daripada mempercayainya;
//   - token yang ditolak relay (perangkat dicabut) menghentikan percobaan: mengulang tidak akan menolong.
//
// WebSocket bawaan browser berbeda antar versi dalam memicu `close` untuk koneksi yang gagal (lihat catatan
// di bridge/relay-client.ts), jadi `error`, `close`, dan batas waktu semuanya dianggap koneksi gagal.
import { EnvelopeSchema, ServerFrameSchema, type Envelope } from "@agentmon/shared";

export type ConnectionStatus = "connecting" | "online" | "offline" | "revoked";

export type DeviceConnectionOptions = {
  relayUrl: string;
  token: string;
  onEvent: (event: Envelope) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Dipanggil setiap kali koneksi siap (pertama kali dan setiap sambung ulang). */
  onReady: () => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  helloTimeoutMs?: number;
  /** Pantau halaman: sambung ulang saat terlihat lagi atau jaringan kembali. Bawaan menyala. */
  watchPage?: boolean;
  // Hanya untuk test.
  createSocket?: (url: string) => WebSocket;
  random?: () => number;
};

export type DeviceConnection = {
  /** Membuka ulang sambungan sekarang juga (tanpa menunggu jeda), walau kelihatannya masih tersambung. */
  reconnectNow(): void;
  status(): ConnectionStatus;
  close(): void;
};

/** Mengubah alamat relay (http/https) menjadi alamat WebSocket. Mengembalikan undefined bila tidak sah. */
export function toWebSocketUrl(relayUrl: string): string | undefined {
  try {
    const url = new URL(relayUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function createDeviceConnection(options: DeviceConnectionOptions): DeviceConnection {
  const wsUrl = toWebSocketUrl(options.relayUrl);
  const reconnectMin = options.reconnectMinMs ?? 500;
  const reconnectMax = options.reconnectMaxMs ?? 15_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const random = options.random ?? Math.random;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  let status: ConnectionStatus = "connecting";
  let socket: WebSocket | undefined;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus(next);
  };

  const clearTimers = () => {
    clearTimeout(reconnectTimer);
    clearTimeout(helloTimer);
    reconnectTimer = helloTimer = undefined;
  };

  // Melepas soket yang ada tanpa memicu penanganan "putus" darinya (yang sudah tidak relevan).
  const dropSocket = () => {
    const old = socket;
    socket = undefined;
    if (old) {
      try {
        old.close();
      } catch {
        // sudah tertutup
      }
    }
  };

  function scheduleReconnect() {
    if (closed || status === "revoked") return;
    setStatus("offline");
    const base = Math.min(reconnectMax, reconnectMin * 2 ** Math.min(attempts, 20));
    const delay = Math.round(base * (0.5 + random() * 0.5)); // 50%-100% supaya banyak HP tidak menyerbu bersamaan
    attempts++;
    reconnectTimer = setTimeout(connect, delay);
  }

  // Koneksi `current` sudah tidak berguna (ditolak, putus, atau tak menjawab).
  function down(current: WebSocket) {
    if (socket !== current) return;
    clearTimers();
    dropSocket();
    scheduleReconnect();
  }

  function connect() {
    if (closed || status === "revoked") return;
    if (wsUrl === undefined) {
      setStatus("offline");
      return;
    }
    clearTimers();
    dropSocket();
    if (status !== "online") setStatus("connecting");

    let current: WebSocket;
    try {
      current = createSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    // Batas waktu untuk SELURUH tahap menyambung (terbuka lalu dijawab welcome).
    helloTimer = setTimeout(() => down(current), helloTimeoutMs);

    current.addEventListener("open", () => {
      if (socket !== current) return;
      try {
        current.send(JSON.stringify({ kind: "hello", role: "device", token: options.token }));
      } catch {
        down(current);
      }
    });

    current.addEventListener("message", (message) => {
      if (socket !== current || typeof (message as MessageEvent).data !== "string") return;
      let json: unknown;
      try {
        json = JSON.parse((message as MessageEvent).data as string);
      } catch {
        return;
      }
      const frame = ServerFrameSchema.safeParse(json);
      if (!frame.success) return; // bingkai dari versi relay yang lebih baru: diabaikan

      switch (frame.data.kind) {
        case "welcome":
          if (frame.data.role !== "device") return;
          clearTimeout(helloTimer);
          helloTimer = undefined;
          attempts = 0;
          setStatus("online");
          options.onReady();
          return;
        case "event": {
          const event = EnvelopeSchema.safeParse(frame.data.event);
          if (event.success) options.onEvent(event.data);
          return;
        }
        case "error":
          // Token ditolak: perangkat dicabut atau tidak dikenal. Mencoba lagi tidak akan menolong.
          if (frame.data.code === "unauthorized") {
            clearTimers();
            dropSocket();
            setStatus("revoked");
          }
          return;
        default:
          return; // ack dan command tidak ditujukan ke HP
      }
    });

    current.addEventListener("error", () => down(current));
    current.addEventListener("close", () => down(current));
  }

  // ---- Memantau halaman ----
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") reconnectNow();
  };
  const onOnline = () => reconnectNow();
  function reconnectNow() {
    if (closed || status === "revoked") return;
    attempts = 0;
    connect();
  }
  if (options.watchPage ?? true) {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
  }

  connect();

  return {
    reconnectNow,
    status: () => status,
    close() {
      closed = true;
      clearTimers();
      dropSocket();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    },
  };
}
