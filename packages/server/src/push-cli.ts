// Perintah operator relay untuk Web Push:
//
//   pnpm --filter @agentmon/server push:keys
//       Membuat pasangan kunci VAPID baru dan mencetaknya sebagai baris variabel lingkungan. KUNCI PRIBADI ikut
//       tercetak: jangan disalin ke chat, repo, atau log. Tempel langsung ke dashboard hosting, lalu bersihkan layar.
//
//   pnpm --filter @agentmon/server push:test <nomor-hp>
//       Mengirim satu notifikasi uji ke HP itu (butuh DATABASE_URL dan ketiga VAPID_*). Mencetak jumlahnya saja.
//       Nomor HP ada di `agentmon devices` di laptop.
import { createPushStore, openPostgres } from "./db";
import { silentLogger } from "./logger";
import { createEndpointPolicy, createPushService, generateVapidKeys, parseVapidConfig } from "./push";

const [command, argument] = process.argv.slice(2);

if (command === "keys") {
  const keys = generateVapidKeys();
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log("VAPID_SUBJECT=<alamat https:// PWA Anda, atau mailto:kontak>");
} else if (command === "test" && argument) {
  const { config, problem } = parseVapidConfig(process.env);
  if (!config || !process.env.DATABASE_URL) {
    console.error(problem ?? "Butuh DATABASE_URL dan ketiga VAPID_* di lingkungan.");
    process.exit(1);
  }
  const database = openPostgres(process.env.DATABASE_URL, { logger: silentLogger });
  try {
    const service = createPushService({
      store: createPushStore(database.db),
      vapid: config,
      isAllowedEndpoint: createEndpointPolicy((process.env.PUSH_ALLOWED_HOSTS ?? "").split(",")),
    });
    const result = await service.notifyDevice(argument, { v: 1, kind: "test", machineId: "test" });
    console.log(`Dicoba: ${result.attempted}, diterima layanan push: ${result.delivered}, gagal: ${result.failed}, langganan mati dihapus: ${result.removed}`);
    if (result.attempted === 0 && result.removed === 0) console.log("HP ini belum berlangganan (atau nomornya salah).");
  } finally {
    await database.close();
  }
} else {
  console.error("Pemakaian: push-cli keys | push-cli test <nomor-hp>");
  process.exit(1);
}
