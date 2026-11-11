// =====================================================================================
// FILE INI: transport relay untuk Node.js = "KABEL" yang mencolokkan jaringan ke hub.
// =====================================================================================
//
// Tugasnya sempit dan sengaja tanpa logika bisnis:
//   - HTTP lewat Hono: sekarang hanya `GET /health` untuk pemeriksaan hosting;
//   - WebSocket di alamat `/ws`: tiap soket dicolokkan ke hub (hub.ts) lewat antarmuka kecil;
//   - mengirim "ping" berkala dan menyapu koneksi yang mati;
//   - berhenti dengan rapi.
// Semua keputusan (siapa boleh bicara dengan siapa, validasi, batas) ada di hub. Bila nanti
// hosting dipindah (misalnya ke Cloudflare Workers), cukup ganti file ini.
import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { RelayDirectory } from "./directory";
import { mountDeviceApi, type DeviceApiOptions } from "./device-api";
import { createRelayHub, DEFAULT_LIMITS, type RelayHub, type RelayHubOptions, type RelayLimits } from "./hub";
import { silentLogger, type Logger } from "./logger";
import { mountPairingRoutes, type PairingRoutesOptions } from "./pairing-http";

export type RelayServerOptions = {
  directory: RelayDirectory;
  port?: number; // 0 = biarkan sistem memilih port kosong (dipakai test)
  host?: string;
  logger?: Logger;
  limits?: Partial<RelayLimits>;
  // Jarak ping dan penyapuan. Hub menganggap koneksi mati bila tak ada tanda hidup selama
  // `limits.idleTimeoutMs`, jadi nilai ini harus jauh lebih kecil darinya.
  heartbeatMs?: number;
  // Pairing lewat QR (HTTP). Tanpa ini endpoint /pair/* tidak ada (404).
  pairing?: PairingRoutesOptions;
  // API baca riwayat untuk HP (HTTP). Tanpa ini endpoint /api/* tidak ada (404).
  deviceApi?: Omit<DeviceApiOptions, "isMachineOnline">;
  // Menyimpan event sebelum diteruskan dan di-ack (lihat hub.ts).
  persist?: RelayHubOptions["persist"];
};

export type RunningRelay = {
  port: number;
  hub: RelayHub;
  stop(): Promise<void>;
};

export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Jarak penyapuan koneksi. HARUS lebih rapat daripada jarak ping dan daripada batas `hello`: kalau
 * disapu hanya tiap jarak ping (30 detik), koneksi yang tidak pernah menyebut `hello` bisa bertahan
 * sampai 35 detik walau batasnya 5 detik. Dipakai setengah dari batas `hello`, dengan batas bawah
 * supaya tidak menyapu terlalu sering.
 */
export function sweepIntervalMs(heartbeatMs: number, helloTimeoutMs: number): number {
  return Math.max(10, Math.min(heartbeatMs, Math.floor(helloTimeoutMs / 2)));
}

export async function startRelayServer(options: RelayServerOptions): Promise<RunningRelay> {
  const logger = options.logger ?? silentLogger;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const hub = createRelayHub({ directory: options.directory, logger, limits, ...(options.persist ? { persist: options.persist } : {}) });

  // ---- HTTP (Hono) ----
  const app = new Hono();
  // Hanya "ok". Jumlah laptop dan HP yang tersambung adalah bahan pengintaian yang tidak dibutuhkan
  // pemeriksaan hosting; statistik tetap bisa dibaca di dalam proses lewat hub.stats().
  app.get("/health", (c) => c.json({ status: "ok" }));
  if (options.pairing) mountPairingRoutes(app, options.pairing);
  if (options.deviceApi) mountDeviceApi(app, { ...options.deviceApi, isMachineOnline: (id) => hub.isMachineOnline(id) });
  // Galat tak terduga (misalnya database sesaat tidak terjangkau): jawab 500 yang polos dan catat.
  // Tidak ada rincian ke klien, dan pairing tetap gagal tertutup (tidak ada kredensial yang keluar).
  app.onError((error, c) => {
    logger.error(`galat HTTP: ${error.message}`);
    return c.json({ error: "internal" }, 500);
  });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;

  // ---- WebSocket ----
  // maxPayload: soket yang menerima pesan lebih besar dari batas langsung ditutup (kode 1009)
  // SEBELUM seluruh pesan dibaca ke memori. Itu yang menjaga relay tetap hidup walau ada yang
  // mengirim pesan raksasa. Hub memeriksa ukuran lagi sebagai lapis kedua.
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (path !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    const session = hub.accept({
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      // Berapa byte yang masih antre belum terkirim ke klien; hub memakainya untuk memutus penerima lambat.
      bufferedAmount: () => ws.bufferedAmount,
    });
    ws.on("message", (data, isBinary) => {
      // Teks diteruskan sebagai teks. Biner diteruskan apa adanya agar hub yang menolaknya.
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      void session.receive(isBinary ? buffer : buffer.toString("utf8"));
    });
    ws.on("pong", () => session.touch()); // jawaban atas ping = koneksi masih hidup
    ws.on("close", () => session.closed());
    // WAJIB ada penangan galat: tanpa ini, galat soket (misalnya pesan melebihi maxPayload)
    // menjatuhkan seluruh proses. Pesan galat dari `ws` tidak memuat isi pesan.
    ws.on("error", (error) => logger.error(`kesalahan soket: ${error.message}`));
  });

  // ---- Detak: ping ke semua soket. Penyapuan berjalan di jadwalnya sendiri yang lebih rapat. ----
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      try {
        ws.ping();
      } catch {
        // soket sudah putus; akan disapu hub
      }
    }
  }, heartbeatMs);
  const sweeper = setInterval(() => hub.sweep(), sweepIntervalMs(heartbeatMs, limits.helloTimeoutMs));
  heartbeat.unref();
  sweeper.unref();

  // ---- Mulai mendengarkan ----
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  logger.info(`relay mendengarkan di port ${port}`);

  return {
    port,
    hub,
    async stop() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      hub.closeAll(1001, "server berhenti");
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      logger.info("relay berhenti");
    },
  };
}
