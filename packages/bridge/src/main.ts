// Titik masuk untuk menjalankan daemon dari terminal: `pnpm --filter @agentmon/bridge daemon`.
// Perintah `agentmon` yang rapi (setup, status, dan seterusnya) dibuat di issue berikutnya.
import { createClaudeCodeHandler } from "./adapters/claude-code-handler";
import { createCheckpointService, type CheckpointService } from "./checkpoint";
import { createRollbackService } from "./rollback";
import { createSessionActivity } from "./session-activity";
import { DaemonAlreadyRunningError, DEFAULT_PORT, startDaemon, type RunningDaemon } from "./daemon";
import { join } from "node:path";
import type { EventType } from "@agentmon/shared";
import { agentmonHome, loadOrCreateMachineId, paths } from "./home";
import { createLogger } from "./logger";
import { createRelayClient, type RelayClient } from "./relay-client";
import { resolveRelayConfig, type ResolvedRelayConfig } from "./relay-config";
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
    // Alamat dan token relay: dari lingkungan, atau dari berkas yang disimpan perintah `register`. Berkas yang rusak hanya
    // mematikan relay (dengan penjelasan); daemon tetap jalan, karena relay tidak boleh menjadi alasan agent berhenti bekerja.
    let relayConfig: ResolvedRelayConfig | undefined;
    try {
      relayConfig = resolveRelayConfig(process.env, agentmonHome());
    } catch (error) {
      console.error(`Relay TIDAK dipakai: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Klien relay (menyambung ke relay agar HP bisa melihat dan menjawab) dibuat SETELAH daemon
    // menyala, karena butuh approval engine-nya. Sampai itu siap, event hanya tidak diteruskan.
    let relay: RelayClient | undefined;
    // Checkpoint dan rollback. Aktivitas sesi dipakai rollback untuk menolak saat agent masih berjalan.
    const activity = createSessionActivity();
    let checkpoints: CheckpointService | undefined;
    if (process.env.AGENTMON_CHECKPOINT !== "0") {
      const logger = createLogger(paths(agentmonHome()).log);
      checkpoints = createCheckpointService({ registryFile: join(agentmonHome(), "checkpoints.json"), log: (message) => logger.info(message) });
    }
    const ref: { daemon?: RunningDaemon } = {};
    let emitOwnEvent: ((type: EventType, payload: Record<string, unknown>, sessionId: string) => void) | undefined;
    const rollback = checkpoints
      ? createRollbackService({
          checkpoints,
          // Berjalan = ada aktivitas terbaru, ATAU masih ada izin yang menunggu keputusan di sesi itu (sesi yang
          // menunggu lama tidak boleh dianggap diam).
          isSessionRunning: (sessionId) => activity.isRunning(sessionId) || (ref.daemon?.approvals.listPending().some((p) => p.sessionId === sessionId) ?? false),
          log: (message) => createLogger(paths(agentmonHome()).log).info(message),
          onRestored: ({ checkpointId, safetyCheckpointId, sessionId }) => {
            if (sessionId) emitOwnEvent?.("checkpoint.restored", { checkpointId, ...(safetyCheckpointId ? { safetyCheckpointId } : {}) }, sessionId);
          },
        })
      : undefined;
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
      canAnswer: () => (relayConfig ? (relay?.canReachPhone() ?? false) : true),
      onHook: createClaudeCodeHandler({
        // Checkpoint git sebelum alat pengubah berkas. Matikan dengan AGENTMON_CHECKPOINT=0.
        ...(checkpoints ? { checkpoint: (cwd: string, sessionId: string) => (checkpoints as CheckpointService).create(cwd, { sessionId }) } : {}),
        // Perintah baru dari pengguna ke agent berarti agent mulai bekerja walau belum ada event alat.
        onHookInput: (input) => {
          if (input.hook_event_name === "UserPromptSubmit" && typeof input.session_id === "string") activity.touch(input.session_id);
        },
        registerEmitter: (emit) => {
          emitOwnEvent = emit;
        },
        // Event dicatat di timeline (ringkasan tanpa isi), di log (jenis dan urutannya), dan dititipkan
        // ke klien relay. Menitipkan selalu seketika dan tidak pernah gagal ke pemanggilnya.
        emit: (event, { logger }) => {
          timeline.record(event);
          activity.record(event);
          logger.info(`event ${event.type} seq=${event.seq}`);
          relay?.send(event);
        },
      }),
    });

    ref.daemon = daemon;

    // Terhubung ke relay bila laptop sudah terdaftar (perintah `register`) atau alamat dan token diisi lewat lingkungan.
    const relayUrl = relayConfig?.relayUrl;
    const relayToken = relayConfig?.token;
    if (relayUrl && relayToken) {
      try {
        relay = createRelayClient({
          url: relayUrl,
          token: relayToken,
          machineId: loadOrCreateMachineId(daemon.home),
          // Keputusan dari HP diserahkan ke approval engine yang sama dengan perintah `approve` dan `deny`.
          decide: (input) => daemon.approvals.decide(input),
          // Perintah lain dari HP (rollback) ditangani rollback; tanpa checkpoint, perintahnya diabaikan.
          ...(rollback ? { onCommand: (body: Record<string, unknown>) => rollback.handle(body) } : {}),
          logger: createLogger(paths(daemon.home).log),
          // Sambungan tanpa enkripsi ke host selain komputer ini ditolak kecuali dinyalakan dengan sadar.
          allowInsecure: process.env.AGENTMON_RELAY_INSECURE === "1",
        });
        console.log(`Relay: menyambung ke ${relayUrl} (nomor laptop ini: ${loadOrCreateMachineId(daemon.home)}; pengaturan dari ${relayConfig?.source === "file" ? "berkas" : "lingkungan"})`);
      } catch (error) {
        // Alamat relay yang salah hanya mematikan relay. Daemon tetap jalan, karena relay tidak
        // boleh menjadi alasan agent berhenti bekerja.
        console.error(`Relay TIDAK dipakai: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log("Relay: tidak dipakai (daftarkan laptop ini dengan perintah register, atau isi AGENTMON_RELAY_URL dan AGENTMON_RELAY_TOKEN)");
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
