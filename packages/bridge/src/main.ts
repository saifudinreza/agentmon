// Titik masuk untuk menjalankan daemon dari terminal: `pnpm --filter @agentmon/bridge daemon`.
// Perintah `agentmon` yang rapi (setup, status, dan seterusnya) dibuat di issue berikutnya.
import { createClaudeCodeHandler } from "./adapters/claude-code-handler";
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
    const holdEnabled = process.env.AGENTMON_HOLD === "1";
    const daemon = await startDaemon({
      port: portFromEnv(),
      // Menahan aksi sampai ada keputusan. Bawaan MATI, karena belum ada HP yang bisa menjawab
      // (relay dibuat di tahap 2): bila menyala, setiap aksi tertahan 9 menit sebelum prompt
      // terminal muncul. Nyalakan dengan AGENTMON_HOLD=1, dan jawab lewat perintah `approve`
      // dan `deny`. Perintah `pause` melepas semuanya.
      holdEnabled,
      onHook: createClaudeCodeHandler({
        // Sementara event hanya dicatat (jenis dan urutannya, bukan isinya). Relay dan
        // timeline menggantikan ini di issue berikutnya.
        emit: (event, { logger }) => logger.info(`event ${event.type} seq=${event.seq}`),
      }),
    });
    console.log(`AgentMon daemon berjalan di http://127.0.0.1:${daemon.port}`);
    console.log(`Data dan log: ${daemon.home}`);
    console.log(
      holdEnabled
        ? "Menahan aksi: AKTIF (jawab dengan `approve` atau `deny`, atau `pause` untuk menjawab di terminal)"
        : "Menahan aksi: mati (nyalakan dengan AGENTMON_HOLD=1)",
    );

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
