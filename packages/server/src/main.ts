// Titik masuk relay: `pnpm --filter @agentmon/server start`.
//
// Dua mode:
//
//   1. DENGAN DATABASE (DATABASE_URL diisi): direktori pemasangan di PostgreSQL, dan pairing lewat
//      QR menyala (/pair/*). Skema harus sudah dimigrasi: `pnpm --filter @agentmon/server db:migrate`.
//        PAIRING_ALLOWED_ORIGINS  asal PWA yang boleh menukar kode dari browser, dipisah koma
//                                 (misalnya https://app.contoh.com)
//        TRUST_PROXY=1            relay di belakang proxy hosting; IP penelepon dibaca dari
//                                 X-Forwarded-For. Jangan nyalakan bila relay terbuka langsung.
//
//   2. MODE PENGEMBANGAN (tanpa database): direktori hanya di memori dengan satu laptop dan satu HP
//      yang tokennya diambil dari variabel lingkungan. Untuk mencoba relay secara manual.
//      Pairing TIDAK tersedia di mode ini.
import { createDbDirectory, createPairingService, openPostgres, type DatabaseHandle } from "./db";
import { createMemoryDirectory, type RelayDirectory } from "./directory";
import { createConsoleLogger } from "./logger";
import { startRelayServer, type RelayServerOptions } from "./node";

const logger = createConsoleLogger();

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT tidak valid: ${process.env.PORT}`);
  process.exit(1);
}

let directory: RelayDirectory;
let database: DatabaseHandle | undefined;
let pairing: RelayServerOptions["pairing"];

if (process.env.DATABASE_URL) {
  database = openPostgres(process.env.DATABASE_URL, { logger });
  await database.migrate();
  const dbDirectory = createDbDirectory(database.db);
  directory = dbDirectory;
  pairing = {
    pairing: createPairingService(database.db),
    directory: dbDirectory,
    allowedOrigins: (process.env.PAIRING_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    trustProxy: process.env.TRUST_PROXY === "1",
  };
} else {
  const machineToken = process.env.RELAY_DEV_MACHINE_TOKEN;
  const deviceToken = process.env.RELAY_DEV_DEVICE_TOKEN;

  if (!machineToken || !deviceToken || machineToken.length < 16 || deviceToken.length < 16) {
    console.error(
      [
        "Tanpa DATABASE_URL, relay berjalan di mode pengembangan dan butuh dua variabel lingkungan",
        "(masing-masing minimal 16 karakter, acak):",
        "  RELAY_DEV_MACHINE_TOKEN   token untuk satu laptop (nomornya: dev-machine)",
        "  RELAY_DEV_DEVICE_TOKEN    token untuk satu HP (nomornya: dev-device)",
        "Contoh membuat token acak: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
        "Atau isi DATABASE_URL untuk memakai database dan pairing QR.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const memory = createMemoryDirectory();
  memory.addMachine("dev-machine", machineToken);
  memory.addDevice("dev-device", deviceToken);
  memory.pair("dev-machine", "dev-device");
  directory = memory;
}

const relay = await startRelayServer({ directory, port, logger, ...(pairing ? { pairing } : {}) });
console.log(
  database
    ? `Relay (database, pairing QR menyala) berjalan di port ${relay.port}. Alamat WebSocket: /ws`
    : `Relay (MODE PENGEMBANGAN, tanpa database, tanpa pairing) berjalan di port ${relay.port}. Alamat WebSocket: /ws`,
);

const shutdown = () => {
  void relay
    .stop()
    .then(() => database?.close())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
