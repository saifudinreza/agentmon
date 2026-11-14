// =====================================================================================
// FILE INI: inti relay = "MEJA OPERATOR TELEPON".
// =====================================================================================
//
// Hub mengurus SEMUA logika relay, dan tidak tahu apa pun soal jaringan:
//   - siapa yang sedang tersambung (laptop dan HP),
//   - memeriksa pesan: bentuknya, ukurannya, dan seberapa cepat dikirim,
//   - meneruskan pesan HANYA antara pihak yang sudah dipasangkan,
//   - menyapu koneksi yang mati atau tidak pernah menyebut dirinya.
//
// Jaringannya (WebSocket) ada di node.ts, yang hanya "mencolokkan" soket ke hub lewat antarmuka
// kecil `RelayConnection`. Karena dipisah begini:
//   - hub bisa dites cepat dengan koneksi tiruan, tanpa jaringan sungguhan;
//   - hosting bisa dipindah (misalnya ke Cloudflare Workers) dengan mengganti node.ts saja.
//
// ANALOGI: operator yang duduk di depan papan sambungan. Penelepon harus menyebut nama dan
// kata sandi dulu. Operator hanya membaca ALAMAT di amplop (laptop mana, HP mana), tidak isinya,
// dan hanya menyambungkan pasangan yang tercatat di buku telepon.
//
// ATURAN YANG DIJAGA:
//   1. Pesan tidak pernah sampai ke pihak yang tidak dipasangkan.
//   2. Laptop hanya boleh mengirim event ATAS NAMA DIRINYA sendiri (tidak bisa menyamar sebagai
//      laptop lain), dan HP hanya boleh mengirim perintah ke laptop yang dipasangkan dengannya.
//   3. Pemasangan diperiksa pada SETIAP pesan, jadi pencabutan perangkat langsung berlaku.
//   4. Kegagalan satu koneksi (pesan rusak, terlalu besar, terlalu cepat) tidak pernah
//      menjatuhkan hub atau mengganggu koneksi lain.
//   5. Log tidak pernah memuat isi pesan maupun token.
import { ClientFrameSchema, type Envelope, type RelayErrorCode, type RelayRole, type ServerFrame } from "@agentmon/shared";
import type { RelayDirectory } from "./directory";
import { silentLogger, type Logger } from "./logger";
import { createRateLimiter, type RateLimiter } from "./rate-limit";

// Sebuah koneksi dilihat hub hanya sebagai beberapa kemampuan sederhana: mengirim teks, menutup diri,
// dan (opsional) melaporkan berapa byte yang masih antre belum terkirim.
export type RelayConnection = {
  send(text: string): void;
  close(code: number, reason: string): void;
  // Jumlah byte yang sudah diserahkan ke soket tetapi belum sampai ke klien. Dipakai untuk
  // memutus penerima yang lambat; transport yang tidak bisa mengukurnya boleh tidak mengisinya.
  bufferedAmount?(): number;
};

export type RelayLimits = {
  maxMessageBytes: number; // pesan lebih besar dari ini ditolak
  rateCapacity: number; // lonjakan terbesar yang diizinkan (isi ember)
  rateRefillPerSecond: number; // laju rata-rata yang diizinkan
  maxRateViolations: number; // pesan ditolak karena terlalu cepat berturut-turut sebelum koneksi diputus
  helloTimeoutMs: number; // batas waktu menyebut peran dan token setelah tersambung
  idleTimeoutMs: number; // batas waktu tanpa tanda hidup sebelum koneksi dianggap mati
  maxBufferedBytes: number; // antrean kirim terbesar untuk satu penerima sebelum ia dianggap terlalu lambat
};

export const DEFAULT_LIMITS: RelayLimits = {
  maxMessageBytes: 1024 * 1024, // 1 MiB
  rateCapacity: 100,
  rateRefillPerSecond: 50,
  maxRateViolations: 5,
  helloTimeoutMs: 5_000,
  idleTimeoutMs: 70_000, // dua kali jarak ping 30 detik, ditambah kelonggaran
  maxBufferedBytes: 8 * 1024 * 1024, // 8 MiB antre untuk satu penerima
};

// Kode penutup WebSocket. 1000-1015 dipakai standar, 4000-4999 bebas dipakai aplikasi.
export const CLOSE = {
  tooLarge: 1009, // standar: pesan terlalu besar
  policy: 1008, // standar: melanggar aturan
  unauthenticated: 4001,
  helloTimeout: 4002,
  unauthorized: 4003,
  idle: 4004,
  replaced: 4005,
  slowConsumer: 4006, // penerima membaca terlalu lambat, antreannya melewati batas
} as const;

// Satu sesi = satu koneksi beserta keadaannya.
type Session = {
  conn: RelayConnection;
  openedAt: number;
  lastSeenAt: number;
  role: RelayRole | undefined; // belum diisi sampai `hello` berhasil
  id: string | undefined;
  limiter: RateLimiter;
  violations: number;
  closed: boolean;
  // Pesan satu koneksi diproses BERURUTAN, walau pemeriksaan token memakan waktu (async).
  queue: Promise<void>;
};

// Yang diserahkan hub ke transport untuk satu koneksi.
export type RelaySession = {
  /** Menerima satu pesan dari koneksi. Tidak pernah melempar error. */
  receive(data: string | Uint8Array): Promise<void>;
  /** Menandai koneksi masih hidup (dipanggil saat pong atau pesan tiba). */
  touch(): void;
  /** Memberi tahu hub bahwa koneksi sudah tertutup. */
  closed(): void;
};

export type RelayHubOptions = {
  directory: RelayDirectory;
  logger?: Logger;
  limits?: Partial<RelayLimits>;
  // Pembaca jam (milidetik). Bisa diganti di test supaya hasilnya pasti.
  now?: () => number;
  /**
   * Menyimpan event sebelum diteruskan dan di-ack. Bila diberikan, `ack` berarti event SUDAH TERSIMPAN,
   * bukan hanya diterima. Bila menyimpan gagal, event tidak diteruskan dan tidak di-ack, sehingga laptop
   * mengirimnya ulang. Mengembalikan `inserted: false` untuk event yang sudah pernah tersimpan (kiriman ulang):
   * dikonfirmasi lagi tanpa diteruskan dua kali.
   */
  persist?: (event: Envelope) => Promise<{ inserted: boolean } | void>;
};

export type RelayHub = ReturnType<typeof createRelayHub>;

export function createRelayHub(options: RelayHubOptions) {
  const { directory } = options;
  const logger = options.logger ?? silentLogger;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());

  const sessions = new Set<Session>();
  // Hanya yang sudah lolos `hello`. Satu nomor satu koneksi: yang baru menggantikan yang lama.
  const machines = new Map<string, Session>();
  const devices = new Map<string, Session>();

  // Nomor event yang baru-baru ini diterima, per laptop, untuk mengenali kiriman ulang. Jumlahnya
  // dibatasi (yang paling lama dilupakan); kiriman ulang yang sah selalu datang tak lama setelah
  // aslinya, jadi tidak perlu mengingat selamanya. Hanya ada di memori: setelah relay dimulai ulang,
  // penyimpan event (kunci unik per laptop dan nomor event) yang menjaga agar tidak ganda.
  const recentEvents = new Map<string, Set<string>>();
  const RECENT_EVENTS_PER_MACHINE = 2000;

  // Apakah nomor event ini baru-baru ini sudah diterima (kiriman ulang)?
  function wasSeen(machineId: string, eventId: string): boolean {
    return recentEvents.get(machineId)?.has(eventId) ?? false;
  }

  // Mencatat nomor event. Dipanggil SETELAH event berhasil diproses (disimpan), bukan sebelumnya: bila
  // menyimpan gagal, kiriman ulang dari laptop harus diproses lagi, bukan dianggap sudah selesai.
  function markSeen(machineId: string, eventId: string): void {
    let seen = recentEvents.get(machineId);
    if (!seen) {
      seen = new Set();
      recentEvents.set(machineId, seen);
    }
    seen.add(eventId);
    // Set mengingat urutan masuk, jadi yang pertama adalah yang paling lama.
    if (seen.size > RECENT_EVENTS_PER_MACHINE) seen.delete(seen.values().next().value as string);
  }

  // ---- Alat bantu ----------------------------------------------------------------------

  // Mengirim satu bingkai. Gagal mengirim (soket sudah putus) tidak boleh melempar error.
  function send(session: Session, frame: ServerFrame): void {
    if (session.closed) return;
    try {
      session.conn.send(JSON.stringify(frame));
    } catch (error) {
      logger.error(`gagal mengirim ke koneksi: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Menutup sebuah sesi dan menghapusnya dari semua catatan.
  function close(session: Session, code: number, reason: string): void {
    if (session.closed) return;
    forget(session);
    try {
      session.conn.close(code, reason);
    } catch {
      // soket sudah tertutup
    }
  }

  function forget(session: Session): void {
    session.closed = true;
    sessions.delete(session);
    if (session.id !== undefined) {
      const map = session.role === "machine" ? machines : devices;
      if (map.get(session.id) === session) {
        map.delete(session.id);
        if (session.role === "device") announcePresenceFor(session.id);
      }
    }
  }

  // Memberi tahu pengirim kenapa pesannya ditolak, lalu (bila diminta) memutus koneksinya.
  // Hanya KODE alasan yang dicatat di log, tidak pernah isi pesan.
  function reject(session: Session, code: RelayErrorCode, message: string, closeWith?: number): void {
    logger.info(`ditolak code=${code} role=${session.role ?? "belum-dikenal"}`);
    send(session, { kind: "error", code, message });
    if (closeWith !== undefined) close(session, closeWith, code);
  }

  // ---- Memproses satu pesan ------------------------------------------------------------

  async function handle(session: Session, data: string): Promise<void> {
    if (session.closed) return;

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return reject(session, "invalid_json", "isi pesan bukan JSON", session.role ? undefined : CLOSE.policy);
    }

    const parsed = ClientFrameSchema.safeParse(json);
    if (!parsed.success) {
      return reject(session, "invalid_frame", "bentuk pesan tidak dikenal", session.role ? undefined : CLOSE.policy);
    }
    const frame = parsed.data;

    // Sebelum `hello`, hanya `hello` yang boleh.
    if (session.role === undefined) {
      if (frame.kind !== "hello") return reject(session, "unauthenticated", "kirim hello lebih dulu", CLOSE.unauthenticated);
      return authenticate(session, frame.role, frame.token);
    }

    switch (frame.kind) {
      case "hello":
        return reject(session, "already_authenticated", "sudah terautentikasi");

      case "event": {
        // Hanya laptop yang boleh mengirim event.
        if (session.role !== "machine") return reject(session, "forbidden", "hanya laptop yang boleh mengirim event");
        // Laptop hanya boleh bicara atas nama dirinya. Tanpa pemeriksaan ini, satu laptop bisa
        // memalsukan event milik laptop orang lain.
        if (frame.event.machineId !== session.id) {
          return reject(session, "forbidden", "machineId tidak sama dengan identitas koneksi");
        }
        const paired = await directory.devicesOf(session.id as string);
        // Tidak ada `ack` bila koneksi sudah putus: laptop akan mengirim ulang setelah tersambung lagi.
        if (session.closed) return;

        // Event yang id-nya sudah pernah diterima (laptop mengirim ulang karena konfirmasi
        // sebelumnya tidak sempat sampai) cukup dikonfirmasi lagi, tanpa diteruskan dua kali.
        if (wasSeen(session.id as string, frame.event.id)) {
          return send(session, { kind: "ack", eventId: frame.event.id });
        }
        // Menyimpan SEBELUM meneruskan dan me-ack: yang di-ack pasti tersimpan, dan HP yang menyambung ulang
        // bisa mengambilnya dari riwayat. Gagal menyimpan = tidak diteruskan dan tidak di-ack (laptop mengulang).
        if (options.persist) {
          let stored: { inserted: boolean } | void;
          try {
            stored = await options.persist(frame.event);
          } catch (error) {
            logger.error(`gagal menyimpan event: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          if (session.closed) return; // putus selagi menyimpan: tidak di-ack; kiriman ulang dikenali sebagai sudah tersimpan
          markSeen(session.id as string, frame.event.id);
          // Sudah pernah tersimpan (mis. relay dimulai ulang lalu laptop mengirim ulang): cukup di-ack.
          if (stored && stored.inserted === false) return send(session, { kind: "ack", eventId: frame.event.id });
        } else {
          markSeen(session.id as string, frame.event.id);
        }
        // Yang diteruskan adalah objek ASLI yang baru saja lolos validasi, bukan hasil parse-nya.
        // Hasil parse membuang kolom amplop yang belum dikenal; daemon versi baru yang menambah
        // kolom akan kehilangan kolom itu diam-diam saat lewat relay lama. Dengan meneruskan yang
        // asli, kontrak bisa berkembang tanpa menunggu relay diperbarui. Ukurannya sudah dibatasi.
        const text = JSON.stringify({ kind: "event", event: (json as { event: unknown }).event });
        // Hanya HP yang dipasangkan DAN sedang tersambung yang menerima.
        for (const deviceId of paired) {
          const target = devices.get(deviceId);
          if (target) deliver(target, text);
        }
        send(session, { kind: "ack", eventId: frame.event.id });
        return;
      }

      case "reply": {
        // Balasan atas perintah HP (mis. hasil keputusan). Hanya laptop yang boleh, dan hanya ke HP yang
        // dipasangkan dengannya: tanpa pemeriksaan ini, satu laptop bisa mengirim apa saja ke HP orang lain.
        if (session.role !== "machine") return reject(session, "forbidden", "hanya laptop yang boleh membalas");
        const allowed = await directory.isPaired(session.id as string, frame.deviceId);
        if (session.closed) return;
        // Tidak dipasangkan: dibuang diam-diam (tanpa galat), supaya laptop tidak bisa mencari tahu HP mana yang ada.
        if (!allowed) return;
        const target = devices.get(frame.deviceId);
        if (target) deliver(target, JSON.stringify({ kind: "reply", machineId: session.id as string, body: frame.body } satisfies ServerFrame));
        return;
      }

      case "command": {
        // Hanya HP yang boleh mengirim perintah.
        if (session.role !== "device") return reject(session, "forbidden", "hanya HP yang boleh mengirim perintah");
        // Jawaban yang sama untuk "tidak dipasangkan" dan "laptop tidak ada", supaya penyerang
        // tidak bisa mencari tahu laptop mana yang terdaftar.
        const allowed = await directory.isPaired(frame.machineId, session.id as string);
        if (session.closed) return;
        if (!allowed) return reject(session, "forbidden", "tidak dipasangkan dengan laptop itu");
        const target = machines.get(frame.machineId);
        if (!target) return reject(session, "target_offline", "laptop sedang tidak tersambung");
        deliver(target, JSON.stringify({ kind: "command", deviceId: session.id as string, body: frame.body } satisfies ServerFrame));
        return;
      }
    }
  }

  // Meneruskan teks yang sudah jadi ke satu penerima.
  function deliver(target: Session, text: string): void {
    if (target.closed) return;
    // Penerima yang membaca lambat (atau sengaja tidak membaca) membuat antrean kirimnya menumpuk
    // di memori relay. Satu laptop boleh mengirim puluhan pesan per detik, jadi tanpa batas ini satu
    // penerima nakal bisa menghabiskan memori relay yang melayani semua orang. Penerima yang
    // antreannya melewati batas diputus; ia bisa menyambung lagi dan mengambil riwayat.
    const buffered = target.conn.bufferedAmount?.() ?? 0;
    if (buffered > limits.maxBufferedBytes) {
      logger.info(`penerima lambat diputus role=${target.role ?? "belum-dikenal"}`);
      close(target, CLOSE.slowConsumer, "slow_consumer");
      return;
    }
    try {
      target.conn.send(text);
    } catch (error) {
      logger.error(`gagal meneruskan: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- Kehadiran HP ----
  // Berapa HP yang dipasangkan dengan laptop ini dan bisa dihubungi: sedang tersambung, atau punya langganan push.
  async function reachableFor(machineId: string): Promise<number> {
    const paired = await directory.devicesOf(machineId);
    const push = directory.devicesWithPush ? await directory.devicesWithPush(machineId) : [];
    const reachable = new Set<string>(push);
    for (const id of paired) if (devices.has(id)) reachable.add(id);
    // Hanya yang masih dipasangkan: langganan push dari HP yang sudah dilepas tidak dihitung.
    return paired.filter((id) => reachable.has(id)).length;
  }

  // Memberi tahu satu laptop yang sedang tersambung. Gagal menghitung tidak boleh mengganggu siapa pun; laptop
  // yang tidak mendapat kabar menganggap tidak ada yang bisa dihubungi (kembali ke prompt terminal).
  // Nomor urut hitungan per laptop: hitungan async bisa selesai tidak berurutan, dan hanya yang TERBARU boleh dikirim.
  const presenceSeq = new Map<string, number>();
  async function announcePresence(machineId: string): Promise<void> {
    const target = machines.get(machineId);
    if (!target) return;
    const ticket = (presenceSeq.get(machineId) ?? 0) + 1;
    presenceSeq.set(machineId, ticket);
    let reachable = 0;
    try {
      reachable = await reachableFor(machineId);
    } catch (error) {
      // Gagal menghitung: kirim 0, bukan diam. Laptop yang masih memegang angka lama akan menahan aksi tanpa ada
      // yang bisa menjawab; 0 membuatnya kembali ke prompt terminal (aman).
      logger.error(`gagal menghitung kehadiran: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (presenceSeq.get(machineId) !== ticket) return; // ada hitungan yang lebih baru
    if (machines.get(machineId) === target) send(target, { kind: "presence", reachable });
  }

  // HP tersambung atau putus: hanya laptop yang dipasangkan dengan HP itu yang dihitung ulang.
  function announcePresenceFor(deviceId: string): void {
    for (const machineId of [...machines.keys()]) {
      void directory
        .isPaired(machineId, deviceId)
        .then((paired) => (paired ? announcePresence(machineId) : undefined))
        .catch(() => undefined);
    }
  }

  async function authenticate(session: Session, role: RelayRole, token: string): Promise<void> {
    let id: string | undefined;
    try {
      id = await directory.authenticate(role, token);
    } catch (error) {
      // Gagal memeriksa (misalnya database mati) diperlakukan sebagai DITOLAK, bukan diloloskan.
      logger.error(`gagal memeriksa token: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (session.closed) return; // koneksi sudah putus selagi menunggu
    if (id === undefined) return reject(session, "unauthorized", "token tidak dikenal", CLOSE.unauthorized);

    // Satu nomor, satu koneksi: koneksi baru dari pihak yang sama (misalnya setelah jaringan
    // putus) menggantikan yang lama, supaya tidak ada koneksi basi yang menerima pesan.
    const map = role === "machine" ? machines : devices;
    const old = map.get(id);
    if (old && old !== session) reject(old, "replaced", "digantikan koneksi baru", CLOSE.replaced);

    session.role = role;
    session.id = id;
    map.set(id, session);
    logger.info(`terautentikasi role=${role}`);
    send(session, { kind: "welcome", role, id });
    if (role === "machine") void announcePresence(id);
    else announcePresenceFor(id);
  }

  // ---- Yang dipakai transport ----------------------------------------------------------

  return {
    /** Mendaftarkan koneksi baru. Mengembalikan pegangan untuk menyalurkan pesannya. */
    accept(conn: RelayConnection): RelaySession {
      const session: Session = {
        conn,
        openedAt: now(),
        lastSeenAt: now(),
        role: undefined,
        id: undefined,
        limiter: createRateLimiter({ capacity: limits.rateCapacity, refillPerSecond: limits.rateRefillPerSecond, now }),
        violations: 0,
        closed: false,
        queue: Promise.resolve(),
      };
      sessions.add(session);
      logger.info(`koneksi dibuka (total ${sessions.size})`);

      return {
        receive(data) {
          if (session.closed) return Promise.resolve();
          session.lastSeenAt = now();

          // Pemeriksaan murah dilakukan SEGERA, sebelum masuk antrean, supaya banjir pesan tidak
          // menumpuk pekerjaan.
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (bytes > limits.maxMessageBytes) {
            reject(session, "too_large", "pesan terlalu besar", CLOSE.tooLarge);
            return Promise.resolve();
          }
          if (!session.limiter.take()) {
            session.violations++;
            reject(session, "rate_limited", "terlalu banyak pesan", session.violations >= limits.maxRateViolations ? CLOSE.policy : undefined);
            return Promise.resolve();
          }
          session.violations = 0;
          if (typeof data !== "string") {
            reject(session, "invalid_frame", "hanya pesan teks yang diterima", session.role ? undefined : CLOSE.policy);
            return Promise.resolve();
          }

          // Diproses berurutan. Kegagalan tak terduga hanya dicatat, dan antrean tetap berjalan.
          session.queue = session.queue
            .then(() => handle(session, data))
            .catch((error: unknown) => {
              logger.error(`kesalahan memproses pesan: ${error instanceof Error ? error.message : String(error)}`);
            });
          return session.queue;
        },
        touch() {
          session.lastSeenAt = now();
        },
        closed() {
          if (session.closed) return;
          forget(session);
          logger.info(`koneksi ditutup role=${session.role ?? "belum-dikenal"} (total ${sessions.size})`);
        },
      };
    },

    /**
     * Menyapu koneksi yang bermasalah. Dipanggil berkala oleh transport.
     *   - belum menyebut peran dan token dalam batas waktunya -> ditutup;
     *   - tidak ada tanda hidup (pesan atau pong) terlalu lama -> dianggap mati, ditutup.
     */
    sweep(): void {
      const current = now();
      for (const session of [...sessions]) {
        if (session.closed) continue;
        if (session.role === undefined && current - session.openedAt > limits.helloTimeoutMs) {
          reject(session, "hello_timeout", "tidak mengirim hello tepat waktu", CLOSE.helloTimeout);
        } else if (current - session.lastSeenAt > limits.idleTimeoutMs) {
          reject(session, "idle_timeout", "tidak ada tanda hidup", CLOSE.idle);
        }
      }
    },

    /** Menutup semua koneksi (saat server berhenti). */
    closeAll(code: number, reason: string): void {
      for (const session of [...sessions]) close(session, code, reason);
    },

    /** Jumlah koneksi saat ini, untuk pemantauan dan test. */
    stats() {
      return { connections: sessions.size, machines: machines.size, devices: devices.size };
    },

    /**
     * Memutus HP yang baru dicabut: koneksinya ditutup seketika (dengan kode "tidak berwenang", sama dengan token
     * ditolak), lalu semua laptop dihitung ulang kehadirannya. Dipanggil SETELAH pencabutan tersimpan di database,
     * supaya sambungan ulang langsung ditolak dan hitungan tidak lagi memuat HP itu.
     */
    disconnectDevice(deviceId: string): void {
      const session = devices.get(deviceId);
      if (session) close(session, CLOSE.unauthorized, "revoked");
      for (const machineId of [...machines.keys()]) void announcePresence(machineId);
    },

    /**
     * Memutus laptop yang tokennya baru diganti: sambungan lama (yang memakai token lama) ditutup seketika dengan kode
     * "tidak berwenang", supaya token yang mungkin bocor tidak tetap hidup sampai sambungannya putus sendiri. Dipanggil
     * SETELAH token baru tersimpan, sehingga sambungan ulang dengan token lama langsung ditolak.
     */
    disconnectMachine(machineId: string): void {
      const session = machines.get(machineId);
      if (session) close(session, CLOSE.unauthorized, "token-replaced");
    },

    /** Apakah laptop ini sedang tersambung ke relay? */
    isMachineOnline(machineId: string): boolean {
      return machines.has(machineId);
    },
  };
}
