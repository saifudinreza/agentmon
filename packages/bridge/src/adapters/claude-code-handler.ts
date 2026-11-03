// Penangan hook untuk Claude Code: menghubungkan adapter (pemetaan) dengan daemon.
//
// Untuk setiap input hook: petakan, beri identitas (id, urutan per sesi, waktu), kirim
// event ke penerima (sink), lalu JAWAB SEGERA tanpa keputusan. Pengiriman event berjalan
// di belakang layar; agent tidak menunggunya.
//
// Menahan aksi sampai ada keputusan (PreToolUse dan PermissionRequest) dikerjakan issue
// berikutnya. Di sini semua jawaban adalah `undefined` = "tidak ada keputusan", sehingga
// alur izin normal Claude Code berjalan seperti biasa.
import { randomUUID } from "node:crypto";
import type { AgentMonEvent } from "@agentmon/shared";
import type { HookContext, HookHandler } from "../server";
import { mapClaudeCodeHook, type Stamp } from "./claude-code";

// Penerima event. Nanti diisi klien relay (issue relay) dan penyimpan timeline. Boleh
// sinkron atau asinkron; keduanya tidak menahan jawaban ke Claude Code.
export type EventSink = (event: AgentMonEvent, context: HookContext) => void | Promise<void>;

export type ClaudeCodeHandlerOptions = {
  emit: EventSink;
  // Bisa diganti di test supaya hasilnya pasti.
  now?: () => Date;
  newId?: () => string;
};

export function createClaudeCodeHandler(options: ClaudeCodeHandlerOptions): HookHandler {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  // Nomor urut berikutnya per sesi. Dimulai dari 0 dan dihapus saat sesi berakhir.
  // Catatan: ini hanya hidup selama daemon berjalan. Bila daemon dimulai ulang di tengah
  // sesi, urutan sesi itu mulai lagi dari 0; penerima mengandalkan `id` untuk menyaring
  // duplikat.
  const nextSeq = new Map<string, number>();

  return (input, context) => {
    const { logger } = context;
    // Kegagalan apa pun di sini tidak boleh sampai ke agent. Server sudah menjawab {} bila
    // penangan melempar error, tetapi menangkapnya di sini membuat catatannya lebih jelas.
    try {
      const result = mapClaudeCodeHook(input, (sessionId): Stamp => {
        const seq = nextSeq.get(sessionId) ?? 0;
        nextSeq.set(sessionId, seq + 1);
        return { machineId: context.machineId, id: newId(), seq, ts: now().toISOString() };
      });

      switch (result.status) {
        case "event": {
          const event = result.event;
          // Pengiriman dijadwalkan lalu ditinggalkan: lambat atau gagalnya penerima tidak
          // boleh menunda jawaban ke agent. Kegagalannya hanya dicatat.
          void Promise.resolve()
            .then(() => options.emit(event, context))
            .catch((error: unknown) => {
              logger.error(`gagal mengirim event ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
            });
          break;
        }
        case "session_ended":
          nextSeq.delete(result.sessionId);
          break;
        case "unknown":
          // Hanya nama event yang dicatat, tidak pernah isinya.
          logger.info(`event hook tidak dikenal: ${result.hookEvent} (diabaikan)`);
          break;
        case "invalid":
          logger.error(`input hook ${result.hookEvent} tidak sah: ${result.message}`);
          break;
        case "permission_request":
        case "ignored":
          // Dipakai issue berikutnya (permission_request) atau memang tidak dipakai (ignored).
          break;
      }
    } catch (error) {
      logger.error(`pemetaan hook gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  };
}
