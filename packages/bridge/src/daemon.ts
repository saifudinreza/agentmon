// Menyalakan dan mematikan daemon: menyiapkan folder data, token, log, lalu membuka port.
//
// Hanya satu daemon yang boleh berjalan. Caranya: port TCP. Sistem operasi menjamin
// hanya satu proses yang berhasil membuka sebuah port, jadi tidak ada berkas kunci yang
// bisa tertinggal basi atau berebut. Karena alamat hook di pengaturan Claude Code harus
// tetap, port-nya juga tetap (bawaan 47821, bisa diganti lewat AGENTMON_PORT).
import { request } from "node:http";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApprovalEngine, type ApprovalEngine } from "./approvals";
import { agentmonHome, loadOrCreateMachineId, loadOrCreateToken, paths } from "./home";
import { createLogger } from "./logger";
import { createDaemonServer, type HookHandler } from "./server";

export const DEFAULT_PORT = 47821;
export const DAEMON_VERSION = "0.0.0";
const HOST = "127.0.0.1";
// Lama maksimum menunggu hook yang sedang berjalan sebelum koneksi dipaksa tutup saat berhenti.
const DRAIN_TIMEOUT_MS = 3000;

export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly pid: number | undefined,
    readonly port: number,
  ) {
    super(`Daemon sudah berjalan di port ${port}${pid === undefined ? "" : ` (pid ${pid})`}.`);
  }
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Port ${port} dipakai program lain, atau oleh daemon dengan data yang berbeda. ` +
        "Ganti dengan AGENTMON_PORT.",
    );
  }
}

export type DaemonOptions = {
  home?: string;
  // 0 = biarkan sistem memilih port kosong (dipakai test).
  port?: number;
  onHook?: HookHandler;
  maxBodyBytes?: number;
  logMaxBytes?: number;
};

export type RunningDaemon = {
  port: number;
  approvals: ApprovalEngine;
  home: string;
  token: string;
  stop(): Promise<void>;
};

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Alamat 127.0.0.1 = hanya bisa dicapai dari laptop ini, tidak dari jaringan.
    server.listen({ port, host: HOST, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// Bertanya ke port yang sedang dipakai: apakah itu daemon AgentMon dengan token yang sama?
function probeDaemon(port: number, token: string): Promise<{ pid: number } | undefined> {
  return new Promise((resolve) => {
    const req = request(
      { host: HOST, port, path: "/health", headers: { authorization: `Bearer ${token}` }, timeout: 1000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { status?: string; pid?: number };
            resolve(res.statusCode === 200 && parsed.status === "ok" && typeof parsed.pid === "number" ? { pid: parsed.pid } : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = options.home ?? agentmonHome();
  const requestedPort = options.port ?? DEFAULT_PORT;
  const token = loadOrCreateToken(home);
  const file = paths(home);
  const logger = createLogger(file.log, options.logMaxBytes);

  // Buku antrean izin: satu untuk seluruh daemon. Ikut berhenti saat daemon berhenti.
  const approvals = createApprovalEngine({ logger });

  const { server, drain } = createDaemonServer({
    token,
    logger,
    version: DAEMON_VERSION,
    machineId: loadOrCreateMachineId(home),
    approvals,
    onHook: options.onHook,
    maxBodyBytes: options.maxBodyBytes,
  });

  try {
    await listen(server, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const running = await probeDaemon(requestedPort, token);
      if (running) throw new DaemonAlreadyRunningError(running.pid, requestedPort);
      throw new PortInUseError(requestedPort);
    }
    throw error;
  }

  const port = (server.address() as AddressInfo).port;
  writeFileSync(
    file.state,
    `${JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), version: DAEMON_VERSION }, null, 2)}\n`,
  );
  logger.info(`daemon mulai di ${HOST}:${port} (pid ${process.pid})`);

  return {
    port,
    approvals,
    home,
    token,
    async stop() {
      // Urutan penting: (1) batalkan semua izin yang menunggu, sehingga hook yang menunggu
      // mendapat jawaban "tanpa keputusan"; (2) tunggu jawaban itu selesai terkirim; baru
      // (3) tutup koneksi. Tanpa langkah 2, koneksi diputus sebelum hook sempat dijawab.
      approvals.close();
      await drain(DRAIN_TIMEOUT_MS);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Koneksi yang masih terbuka (keep-alive) akan menahan penutupan, jadi diputus.
        server.closeAllConnections();
      });
      // Hapus catatan status hanya bila memang milik proses ini.
      try {
        const state = JSON.parse(readFileSync(file.state, "utf8")) as { pid?: number };
        if (state.pid === process.pid) unlinkSync(file.state);
      } catch {
        // sudah tidak ada
      }
      logger.info("daemon berhenti");
    },
  };
}
