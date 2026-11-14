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
//        VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//                                 kunci Web Push (buat dengan `pnpm --filter @agentmon/server push:keys`);
//                                 subjek berupa https:// atau mailto:. Tanpa ketiganya push mati.
//        PUSH_ALLOWED_HOSTS       (opsional) akhiran host layanan push tambahan, dipisah koma
//        ADMIN_SECRET             rahasia pemilik relay (minimal 32 karakter) untuk mendaftarkan laptop lewat
//                                 POST /admin/machines (perintah `register` di laptop). Tanpa ini pendaftaran tertutup.
//
//   2. MODE PENGEMBANGAN (tanpa database): direktori hanya di memori dengan satu laptop dan satu HP
//      yang tokennya diambil dari variabel lingkungan. Untuk mencoba relay secara manual.
//      Pairing TIDAK tersedia di mode ini.
import { createDbDirectory, createMachineRegistry, createPairingService, createPushStore, createStore, openPostgres, startRetention, type DatabaseHandle } from "./db";
import { createMemoryDirectory, type RelayDirectory } from "./directory";
import { createConsoleLogger } from "./logger";
import { startRelayServer, type RelayServerOptions } from "./node";
import { parseAdminSecret } from "./admin-http";
import { createEndpointPolicy, parseVapidConfig, withPushPresence } from "./push";

const logger = createConsoleLogger();

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT tidak valid: ${process.env.PORT}`);
  process.exit(1);
}

let directory: RelayDirectory;
let database: DatabaseHandle | undefined;
let pairing: RelayServerOptions["pairing"];
let persist: RelayServerOptions["persist"];
let deviceApi: RelayServerOptions["deviceApi"];
let admin: RelayServerOptions["admin"];
let retention: ReturnType<typeof startRetention> | undefined;

if (process.env.DATABASE_URL) {
  database = openPostgres(process.env.DATABASE_URL, { logger });
  await database.migrate();
  // Penghapusan otomatis (sekali saat mulai, lalu tiap 6 jam): riwayat lebih dari 30 hari serta
  // kode pairing yang sudah terpakai atau kedaluwarsa. Tanpa ini kode pairing menumpuk selamanya.
  const eventStore = createStore(database.db);
  retention = startRetention({ store: eventStore, logger });
  const dbDirectory = createDbDirectory(database.db);
  // Asal PWA yang boleh memanggil relay dari browser (pairing dan API baca riwayat).
  const allowedOrigins = (process.env.PAIRING_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  pairing = {
    pairing: createPairingService(database.db),
    directory: dbDirectory,
    allowedOrigins,
    trustProxy: process.env.TRUST_PROXY === "1",
  };
  // Event dari laptop disimpan sebelum diteruskan dan di-ack, dan HP membaca riwayatnya lewat /api/*.
  persist = (event) => eventStore.saveEvent(event);
  // Web Push: menyala hanya bila ketiga VAPID_* diisi dan benar. Selain itu relay tetap jalan tanpa push.
  const vapid = parseVapidConfig(process.env);
  if (vapid.problem) logger.error(`Web Push mati: ${vapid.problem}`);
  else if (!vapid.config) logger.info("Web Push mati: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, dan VAPID_SUBJECT belum diisi");
  const push = {
    store: createPushStore(database.db),
    isAllowedEndpoint: createEndpointPolicy((process.env.PUSH_ALLOWED_HOSTS ?? "").split(",")),
    ...(vapid.config ? { vapidPublicKey: vapid.config.publicKey } : {}),
  };
  deviceApi = { directory: dbDirectory, store: eventStore, devices: pairing.pairing, allowedOrigins, trustProxy: process.env.TRUST_PROXY === "1", push };
  // Pendaftaran laptop (POST /admin/machines): terbuka hanya bila ADMIN_SECRET diisi dan cukup panjang.
  const adminSecret = parseAdminSecret(process.env);
  if (adminSecret.problem) logger.error(adminSecret.problem);
  else if (adminSecret.secret) {
    admin = { secret: adminSecret.secret, registry: createMachineRegistry(database.db), logger, trustProxy: process.env.TRUST_PROXY === "1" };
  } else logger.info("Pendaftaran laptop ditutup: ADMIN_SECRET belum diisi");
  // Push mati: langganan yang masih tersimpan tidak dihitung sebagai HP yang bisa dihubungi (lihat withPushPresence).
  directory = withPushPresence(dbDirectory, vapid.config !== undefined);
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

const relay = await startRelayServer({
  directory,
  port,
  logger,
  ...(pairing ? { pairing } : {}),
  ...(persist ? { persist } : {}),
  ...(deviceApi ? { deviceApi } : {}),
  ...(admin ? { admin } : {}),
});
console.log(
  database
    ? `Relay (database, pairing QR menyala) berjalan di port ${relay.port}. Alamat WebSocket: /ws`
    : `Relay (MODE PENGEMBANGAN, tanpa database, tanpa pairing) berjalan di port ${relay.port}. Alamat WebSocket: /ws`,
);

const shutdown = () => {
  retention?.stop();
  void relay
    .stop()
    .then(() => database?.close())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
