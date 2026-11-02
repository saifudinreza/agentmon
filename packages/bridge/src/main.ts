// Titik masuk untuk menjalankan daemon dari terminal: `pnpm --filter @agentmon/bridge daemon`.
// Perintah `agentmon` yang rapi (setup, status, dan seterusnya) dibuat di issue berikutnya.
import { DaemonAlreadyRunningError, DEFAULT_PORT, startDaemon } from "./daemon";

function portFromEnv(): number {
  const raw = process.env.AGENTMON_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AGENTMON_PORT tidak valid: ${raw}`);
  }
  return port;
}

async function main() {
  try {
    const daemon = await startDaemon({ port: portFromEnv() });
    console.log(`AgentMon daemon berjalan di http://127.0.0.1:${daemon.port}`);
    console.log(`Data dan log: ${daemon.home}`);

    const shutdown = () => {
      void daemon.stop().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      // Bukan kesalahan: menjalankan daemon dua kali tidak merusak yang pertama.
      console.log(error.message);
      process.exit(0);
    }
    console.error(`Gagal menjalankan daemon: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
