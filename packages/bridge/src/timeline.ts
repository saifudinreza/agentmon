// =====================================================================================
// FILE INI: timeline = "BUKU HARIAN SINGKAT" tentang apa yang terjadi di daemon.
// =====================================================================================
//
// Setiap event baku (alat diminta, izin dibuka, izin diputuskan, dan seterusnya) dicatat satu
// baris pendek, supaya halaman web lokal bisa menampilkan urutan kejadiannya.
//
// DUA ATURAN PENTING:
//   1. Hanya RINGKASAN, tidak pernah isi. Event asli memuat input alat (isi berkas, perintah)
//      dan komentar pengguna; semua itu bisa berisi kode atau rahasia. Timeline hanya menyimpan
//      jenis kejadian, nama alat, dan status. Isi yang perlu dilihat untuk memutuskan (diff,
//      perintah) tampil lewat izin yang menunggu, bukan lewat timeline.
//   2. Jumlahnya dibatasi. Yang paling lama dibuang, jadi memori daemon tidak bertambah
//      terus walau berjalan berminggu-minggu. Timeline ini sengaja tidak disimpan ke disk.
import type { AgentMonEvent } from "@agentmon/shared";

export type TimelineEntry = {
  ts: string;
  type: string;
  sessionId: string;
  seq: number;
  // Satu kalimat pendek, tanpa isi.
  summary: string;
  // Nomor izin, bila kejadiannya menyangkut izin. Untuk mencocokkan dengan izin yang menunggu.
  approvalId?: string;
};

export const DEFAULT_TIMELINE_SIZE = 200;

/** Ringkasan satu event dalam satu kalimat. Hanya memakai kolom yang aman (jenis, nama alat, status). */
export function summarizeEvent(event: AgentMonEvent): string {
  switch (event.type) {
    case "session.started":
      return "sesi dimulai";
    case "tool.requested":
      return `alat diminta: ${event.payload.toolName}`;
    case "tool.completed":
      return `alat selesai: ${event.payload.toolName}${event.payload.ok ? "" : " (dihentikan)"}`;
    case "approval.requested":
      return `menunggu keputusan: ${event.payload.toolName}`;
    case "approval.resolved":
      return `keputusan: ${event.payload.status}`;
    case "approval.auto_resolved":
      return `keputusan otomatis: ${event.payload.status}`;
    case "agent.notification":
      return "pesan dari agent"; // isi pesannya sengaja tidak disimpan
    case "agent.stopped":
      return "agent selesai satu giliran";
    case "turn.review_requested":
      return "review giliran diminta";
    case "checkpoint.created":
      return "checkpoint dibuat";
    case "checkpoint.restored":
      return "checkpoint dipulihkan";
    case "session.recap":
      return "rekap sesi";
  }
}

export type Timeline = ReturnType<typeof createTimeline>;

export function createTimeline(max = DEFAULT_TIMELINE_SIZE) {
  const entries: TimelineEntry[] = [];

  return {
    /** Mencatat satu event. Tidak pernah melempar error. */
    record(event: AgentMonEvent): void {
      const approvalId = "approvalId" in event.payload ? event.payload.approvalId : undefined;
      entries.push({
        ts: event.ts,
        type: event.type,
        sessionId: event.sessionId,
        seq: event.seq,
        summary: summarizeEvent(event),
        ...(typeof approvalId === "string" ? { approvalId } : {}),
      });
      if (entries.length > max) entries.shift();
    },

    /** Salinan isi timeline, dari yang paling lama ke yang paling baru. */
    list(): TimelineEntry[] {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}
