// Titik masuk MODE PENGEMBANGAN relay: `pnpm --filter @agentmon/server start`.
//
// Direktori pemasangan di sini hanya di memori dengan satu laptop dan satu HP yang tokennya
// diambil dari variabel lingkungan. Ini untuk mencoba relay secara manual. Versi sungguhan
// memakai database dan pairing lewat QR (issue berikutnya), dan menggantikan file ini.
import { createMemoryDirectory } from "./directory";
import { createConsoleLogger } from "./logger";
import { startRelayServer } from "./node";

const machineToken = process.env.RELAY_DEV_MACHINE_TOKEN;
const deviceToken = process.env.RELAY_DEV_DEVICE_TOKEN;

if (!machineToken || !deviceToken || machineToken.length < 16 || deviceToken.length < 16) {
  console.error(
    [
      "Mode pengembangan relay butuh dua variabel lingkungan (masing-masing minimal 16 karakter, acak):",
      "  RELAY_DEV_MACHINE_TOKEN   token untuk satu laptop (nomornya: dev-machine)",
      "  RELAY_DEV_DEVICE_TOKEN    token untuk satu HP (nomornya: dev-device)",
      "Contoh membuat token acak: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    ].join("\n"),
  );
  process.exit(1);
}

const directory = createMemoryDirectory();
directory.addMachine("dev-machine", machineToken);
directory.addDevice("dev-device", deviceToken);
directory.pair("dev-machine", "dev-device");

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT tidak valid: ${process.env.PORT}`);
  process.exit(1);
}

const relay = await startRelayServer({ directory, port, logger: createConsoleLogger() });
console.log(`Relay (MODE PENGEMBANGAN, tanpa database) berjalan di port ${relay.port}. Alamat WebSocket: /ws`);

const shutdown = () => {
  void relay.stop().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
