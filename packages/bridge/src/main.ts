// Titik masuk untuk menjalankan daemon dari terminal: `pnpm --filter @agentmon/bridge daemon`.
// Perintah `agentmon` yang rapi (setup, status, dan seterusnya) dibuat di issue berikutnya.
import { createClaudeCodeHandler } from "./adapters/claude-code-handler";
import { createCheckpointService } from "./checkpoint";
import { DaemonAlreadyRunningError, DEFAULT_PORT, startDaemon } from "./daemon";
import { agentmonHome, loadOrCreateMachineId, paths } from "./home";
import { createLogger } from "./logger";
import { createRelayClient, type RelayClient } from "./relay-client";
import { createTimeline } from "./timeline";

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
    // Halaman web lokal: ALAT PENGEMBANGAN, bawaan mati. Tidak pernah menyala di lingkungan produksi
    // walau diminta, supaya satu variabel yang salah tidak membuka halaman ini di mana-mana.
    const devUiRequested = process.env.AGENTMON_DEV_UI === "1";
    const devUi = devUiRequested && process.env.NODE_ENV !== "production";
    const timeline = createTimeline();
    // Klien relay (menyambung ke relay agar HP bisa melihat dan menjawab) dibuat SETELAH daemon
    // menyala, karena butuh approval engine-nya. Sampai itu siap, event hanya tidak diteruskan.
    let relay: RelayClient | undefined;
    const daemon = await startDaemon({
      port: portFromEnv(),
      devUi,
      timeline,
      // Menahan aksi sampai ada keputusan. Bawaan MATI, karena belum ada HP yang bisa menjawab
      // (relay dibuat di tahap 2): bila menyala, setiap aksi tertahan 9 menit sebelum prompt
      // terminal muncul. Nyalakan dengan AGENTMON_HOLD=1, dan jawab lewat perintah `approve`
      // dan `deny`. Perintah `pause` melepas semuanya.
      holdEnabled,
      // Dengan relay terpasang, aksi hanya ditahan bila ada HP yang bisa menjawab; tanpa relay, jawaban lewat CLI atau halaman lokal.
      canAnswer: () => (process.env.AGENTMON_RELAY_URL && process.env.AGENTMON_RELAY_TOKEN ? (relay?.canReachPhone() ?? false) : true),
      onHook: createClaudeCodeHandler({
        // Checkpoint git sebelum alat pengubah berkas. Matikan dengan AGENTMON_CHECKPOINT=0.
        ...(process.env.AGENTMON_CHECKPOINT === "0"
          ? {}
          : (() => {
              const logger = createLogger(paths(agentmonHome()).log);
              const service = createCheckpointService({ log: (message) => logger.info(message) });
              return { checkpoint: (cwd: string) => service.create(cwd) };
            })()),
        // Event dicatat di timeline (ringkasan tanpa isi), di log (jenis dan urutannya), dan dititipkan
        // ke klien relay. Menitipkan selalu seketika dan tidak pernah gagal ke pemanggilnya.
        emit: (event, { logger }) => {
          timeline.record(event);
          logger.info(`event ${event.type} seq=${event.seq}`);
          relay?.send(event);
        },
      }),
    });

    // Terhubung ke relay bila alamat dan token laptop diisi (nilai yang sama dengan perintah `pair`).
    const relayUrl = process.env.AGENTMON_RELAY_URL;
    const relayToken = process.env.AGENTMON_RELAY_TOKEN;
    if (relayUrl && relayToken) {
      try {
        relay = createRelayClient({
          url: relayUrl,
          token: relayToken,
          machineId: loadOrCreateMachineId(daemon.home),
          // Keputusan dari HP diserahkan ke approval engine yang sama dengan perintah `approve` dan `deny`.
          decide: (input) => daemon.approvals.decide(input),
          logger: createLogger(paths(daemon.home).log),
          // Sambungan tanpa enkripsi ke host selain komputer ini ditolak kecuali dinyalakan dengan sadar.
          allowInsecure: process.env.AGENTMON_RELAY_INSECURE === "1",
        });
        console.log(`Relay: menyambung ke ${relayUrl} (nomor laptop ini: ${loadOrCreateMachineId(daemon.home)})`);
      } catch (error) {
        // Alamat relay yang salah hanya mematikan relay. Daemon tetap jalan, karena relay tidak
        // boleh menjadi alasan agent berhenti bekerja.
        console.error(`Relay TIDAK dipakai: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log("Relay: tidak dipakai (isi AGENTMON_RELAY_URL dan AGENTMON_RELAY_TOKEN untuk menyambung)");
    }
    console.log(`AgentMon daemon berjalan di http://127.0.0.1:${daemon.port}`);
    console.log(`Data dan log: ${daemon.home}`);
    console.log(
      holdEnabled
        ? "Menahan aksi: AKTIF (jawab dengan `approve` atau `deny`, atau `pause` untuk menjawab di terminal)"
        : "Menahan aksi: mati (nyalakan dengan AGENTMON_HOLD=1)",
    );
    if (devUiRequested && !devUi) {
      console.log("Halaman web lokal: TIDAK diaktifkan karena NODE_ENV=production (alat pengembangan).");
    } else if (devUi) {
      console.log("Halaman web lokal (alat pengembangan): AKTIF. Ambil alamat lengkapnya dengan: pnpm --filter @agentmon/bridge cli ui");
      if (!holdEnabled) {
        console.log("Peringatan: penahanan aksi mati, jadi halaman tidak akan menampilkan izin. Nyalakan dengan AGENTMON_HOLD=1.");
      }
    }

    const shutdown = () => {
      // Memberi relay kesempatan singkat (2 detik) menerima sisa antrean sebelum berhenti.
      void (relay ? relay.flush(2000) : Promise.resolve())
        .then(() => relay?.close())
        .then(() => daemon.stop())
        .then(() => process.exit(0));
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
