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
//
// Yang WAJIB diperhatikan penerima:
// - Pemanggilan berurutan sesuai `seq`, tetapi penyelesaian penerima asinkron bisa tidak
//   berurutan. Susun ulang berdasarkan `seq` bila urutan penting.
// - Event yang gagal dikirim hanya dicatat di log, tidak dicoba lagi. Penerima yang butuh
//   kelengkapan (misalnya klien relay) harus punya antrean dan percobaan ulang sendiri;
//   di sini yang dijaga hanya satu hal: agent tidak boleh menunggu penerima.
// - `seq` bisa punya celah bila pengiriman gagal, dan mulai dari 0 lagi bila daemon dimulai ulang.
export type EventSink = (event: AgentMonEvent, context: HookContext) => void | Promise<void>;

export type ClaudeCodeHandlerOptions = {
  emit: EventSink;
  // Bisa diganti di test supaya hasilnya pasti.
  now?: () => Date;
  newId?: () => string;
};

// Batas jumlah sesi yang nomor urutnya diingat sekaligus.
export const MAX_TRACKED_SESSIONS = 1000;

export function createClaudeCodeHandler(options: ClaudeCodeHandlerOptions): HookHandler {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  // Nomor urut berikutnya per sesi. Dimulai dari 0 dan dihapus saat sesi berakhir.
  // Catatan: ini hanya hidup selama daemon berjalan. Bila daemon dimulai ulang di tengah
  // sesi, urutan sesi itu mulai lagi dari 0; penerima mengandalkan `id` untuk menyaring
  // duplikat.
  //
  // Sesi yang berakhir mendadak (crash, SessionEnd tidak terkirim) tidak pernah dihapus
  // oleh SessionEnd, jadi jumlahnya dibatasi: yang paling lama tidak dipakai disingkirkan.
  const nextSeq = new Map<string, number>();
  const remember = (sessionId: string, seq: number) => {
    nextSeq.delete(sessionId); // dihapus lalu dipasang lagi = pindah ke posisi "terbaru"
    nextSeq.set(sessionId, seq);
    if (nextSeq.size > MAX_TRACKED_SESSIONS) {
      const oldest = nextSeq.keys().next().value;
      if (oldest !== undefined) nextSeq.delete(oldest);
    }
  };

  return (input, context) => {
    const { logger } = context;
    // Kegagalan apa pun di sini tidak boleh sampai ke agent. Server sudah menjawab {} bila
    // penangan melempar error, tetapi menangkapnya di sini membuat catatannya lebih jelas.
    try {
      // Membaca nomor urut TANPA menaikkannya. Dinaikkan di bawah, hanya bila hasilnya
      // benar-benar event, supaya data yang ditolak tidak meninggalkan celah.
      const result = mapClaudeCodeHook(input, (sessionId): Stamp => ({
        machineId: context.machineId,
        id: newId(),
        seq: nextSeq.get(sessionId) ?? 0,
        ts: now().toISOString(),
      }));

      switch (result.status) {
        case "event": {
          const event = result.event;
          remember(event.sessionId, event.seq + 1);
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
          // Belum ada yang menanganinya (approval engine dibuat di issue berikutnya). Dicatat
          // supaya jelas dari log bahwa permintaan izin memang sampai. Hanya nama alat.
          logger.info(`permintaan izin diterima: alat=${result.request.toolName} (belum ditangani)`);
          break;
        case "ignored":
          // Sengaja tidak dipakai.
          break;
      }
    } catch (error) {
      logger.error(`pemetaan hook gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  };
}
