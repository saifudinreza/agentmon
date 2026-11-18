// =====================================================================================
// FILE INI: panel kontrol daemon = "SAKLAR" untuk menahan aksi agent.
// =====================================================================================
//
// Ada dua saklar yang menentukan apakah daemon boleh menahan aksi agent sampai ada keputusan:
//
//   1. holdEnabled (dipasang saat daemon dinyalakan)
//        Sampai ada HP yang bisa menjawab (relay, tahap 2), menahan aksi sebaiknya MATI.
//        Kalau menyala tanpa ada yang bisa menjawab, setiap aksi tertahan sampai batas
//        waktu (9 menit) sebelum prompt di terminal muncul. Bawaan: mati.
//
//   2. paused (diubah pengguna lewat perintah `pause` dan `resume`)
//        Pengguna sedang duduk di depan laptop dan ingin menjawab di terminal seperti biasa.
//        Saat dijeda, tidak ada aksi yang ditahan, dan aksi yang SEDANG menunggu langsung
//        dilepas supaya prompt terminal muncul saat itu juga.
//
// Aksi hanya ditahan bila holdEnabled menyala DAN tidak sedang dijeda.
import type { FileDiff } from "@agentmon/shared";
import type { ApprovalEngine } from "./approvals";

export type PendingSummary = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  createdAt: string;
  expiresAt: string;
  // Ringkasan perubahan dalam satu baris, misalnya "+3 -1 (2 hunk)". Tanpa isi berkas.
  change?: string;
  // Kode alasan path ditandai sensitif, misalnya ["env_file"].
  sensitive?: string[];
};

// Keadaan yang ditampilkan perintah `status`. Sengaja tidak memuat isi input alat
// (bisa berisi kode atau rahasia), hanya nama alatnya.
/** Keadaan sambungan ke relay, untuk perintah `status`. Tidak memuat alamat atau token. */
export type RelayStatus = {
  configured: boolean;
  state: "off" | "connecting" | "ready" | "disconnected" | "closed";
  /** Ada HP yang sedang online dan bisa dihubungi. */
  phoneReachable: boolean;
};

export type DaemonStatus = {
  paused: boolean;
  holdEnabled: boolean;
  pending: PendingSummary[];
  message: string;
  relay?: RelayStatus;
};

export type DaemonControl = {
  readonly holdEnabled: boolean;
  isPaused(): boolean;
  // Aksi boleh ditahan sekarang? (menyala dan tidak sedang dijeda)
  canHold(): boolean;
  // Menjeda. Mengembalikan jumlah izin yang menunggu dan langsung dilepas.
  pause(): number;
  resume(): void;
  status(): DaemonStatus;
};

// Ringkasan satu baris untuk sebuah diff, SENGAJA tanpa isi berkas (bisa berisi kode atau rahasia):
// hanya jenis perubahan dan jumlahnya.
export function summarizeDiff(diff: FileDiff): string {
  const change = diff.change;
  switch (change.type) {
    case "text":
      return `${change.isNew ? "berkas baru " : ""}+${change.added} -${change.removed} (${change.hunks.length} hunk)`;
    case "unchanged":
      return change.formatChanged ? "isi sama, hanya format yang berubah" : "tidak ada perubahan";
    case "binary":
      return "berkas biner";
    case "too_large":
      return change.added !== undefined ? `terlalu besar (~+${change.added} -${change.removed ?? 0})` : "terlalu besar";
    case "mismatch":
      return `tidak cocok: ${change.reason}`;
  }
}

export function createDaemonControl(options: {
  holdEnabled: boolean;
  approvals: ApprovalEngine;
  /** Adakah yang bisa menjawab? Bila salah, aksi tidak ditahan. Bawaan: selalu ada (jawaban lewat CLI atau halaman lokal). */
  canAnswer?: () => boolean;
  /** Keadaan relay untuk `status`. Bawaan: tidak dilaporkan. */
  relayStatus?: () => RelayStatus;
}): DaemonControl {
  const { holdEnabled, approvals } = options;
  const canAnswer = options.canAnswer ?? (() => true);
  let paused = false;

  // Kalimat status dalam bahasa manusia. Urutannya dari yang paling menentukan.
  function describe(pendingToolNames: string[]): string {
    if (paused) {
      return "Dijeda: AgentMon tidak menahan aksi agent. Jawab di terminal seperti biasa. Jalankan `resume` untuk menyalakan lagi.";
    }
    if (!holdEnabled) {
      return "Menahan aksi dimatikan, jadi agent berjalan seperti tanpa AgentMon. Nyalakan dengan AGENTMON_HOLD=1 saat menjalankan daemon.";
    }
    if (!canAnswer()) {
      return "Tidak ada HP yang bisa dihubungi (belum dipasangkan, relay tidak terjangkau, atau tidak ada yang online). Agent berjalan seperti tanpa AgentMon: jawab di terminal.";
    }
    if (pendingToolNames.length > 0) {
      const count = pendingToolNames.length;
      return `AgentMon sedang menunggu keputusan dari HP untuk ${count} permintaan (alat: ${[...new Set(pendingToolNames)].join(", ")}). Untuk menjawab di terminal, jalankan \`pause\`.`;
    }
    return "Aktif. Tidak ada permintaan yang sedang menunggu.";
  }

  return {
    holdEnabled,
    isPaused: () => paused,
    canHold: () => holdEnabled && !paused && canAnswer(),
    pause() {
      paused = true;
      // Izin yang sedang menunggu dilepas: hook-nya dijawab "tanpa keputusan", sehingga
      // prompt terminal muncul sekarang juga, bukan 9 menit lagi.
      return approvals.cancelAll();
    },
    resume() {
      paused = false;
    },
    status() {
      const pending = approvals.listPending().map(
        (a): PendingSummary => ({
          approvalId: a.approvalId,
          sessionId: a.sessionId,
          toolName: a.toolName,
          createdAt: a.createdAt,
          expiresAt: a.expiresAt,
          ...(a.diff ? { change: summarizeDiff(a.diff) } : {}),
          ...(a.diff && a.diff.sensitive.length > 0 ? { sensitive: a.diff.sensitive.map((r) => r.code) } : {}),
        }),
      );
      return { paused, holdEnabled, pending, message: describe(pending.map((p) => p.toolName)), ...(options.relayStatus ? { relay: options.relayStatus() } : {}) };
    },
  };
}
