// =====================================================================================
// FILE INI: approval engine = "BUKU ANTREAN IZIN" milik daemon.
// =====================================================================================
//
// Setiap kali agent minta izin, daemon membuka satu "kartu" di buku ini. Kartu itu hidup
// dengan aturan sederhana:
//
//   pending (menunggu) --+--> approved            (disetujui)
//                        +--> partially_approved  (disetujui sebagian)
//                        +--> denied              (ditolak)
//                        +--> timed_out           (waktu habis, kembali ke alur normal)
//                        +--> cancelled           (daemon berhenti / sesi berakhir)
//
// Begitu kartu keluar dari "pending", ia SELESAI. Tidak bisa berubah lagi. Keputusan
// pertama yang masuk yang menentukan; yang kedua, atau yang telat, ditolak.
//
// Tiga janji yang dijaga file ini:
//   1. Hook yang menunggu SELALU mendapat jawaban (disetujui, ditolak, waktu habis, atau
//      dibatalkan). Tidak ada jalan di mana jawabannya menggantung selamanya.
//   2. Keputusan pertama yang berlaku (FR-28). Dua keputusan yang datang bersamaan, atau
//      keputusan yang datang berbarengan dengan habisnya waktu: hasilnya tetap SATU.
//   3. Kegagalan tidak pernah menjadi persetujuan. Waktu habis dan pembatalan adalah
//      "tanpa keputusan", bukan "setuju".
//
// File ini tidak tahu apa pun soal Claude Code, HTTP, atau HP. Ia hanya mengelola kartu.
// Menyambungkannya ke hook dikerjakan issue berikutnya (008).
import { randomUUID } from "node:crypto";
import {
  ApprovalDecisionSchema,
  formatIssues,
  type ApprovalStatus,
  type FinalApprovalStatus,
  type HunkDecision,
  type Risk,
} from "@agentmon/shared";
import type { Logger } from "./logger";

// ---- ATURAN PERPINDAHAN STATUS ---------------------------------------------------------

// Tabel resmi: dari status X boleh pindah ke mana saja. `Record<ApprovalStatus, ...>`
// memaksa TypeScript memeriksa bahwa SEMUA status punya baris di sini; kalau nanti ada
// status baru di paket shared, file ini langsung gagal dikompilasi sampai tabelnya diisi.
//
// Hanya "pending" yang boleh pindah. Status akhir tidak punya jalan keluar.
// auto_approved dan auto_denied tidak pernah lewat "pending" (langsung dari policy),
// jadi tidak ada perpindahan masuk maupun keluar untuk keduanya di mesin ini.
const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["approved", "partially_approved", "denied", "timed_out", "cancelled"],
  approved: [],
  partially_approved: [],
  denied: [],
  timed_out: [],
  cancelled: [],
  auto_approved: [],
  auto_denied: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---- TIPE ------------------------------------------------------------------------------

// Bahan untuk membuka satu kartu.
export type ApprovalRequestInput = {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  // Diteruskan apa adanya untuk event `approval.requested` nanti (diisi penilai risiko).
  risk?: Risk;
  summary?: string;
  // Lama menunggu dalam milidetik. Bawaan: DEFAULT_APPROVAL_TIMEOUT_MS.
  timeoutMs?: number;
};

// Jawaban akhir yang diterima hook yang menunggu.
export type ApprovalOutcome = {
  status: FinalApprovalStatus;
  comment?: string;
  hunks?: HunkDecision[];
};

// Foto keadaan satu kartu (salinan, aman dibaca; mengubahnya tidak memengaruhi mesin).
export type ApprovalSnapshot = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  risk?: Risk;
  summary?: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  comment?: string;
  hunks?: HunkDecision[];
};

// Hasil permintaan: nomor kartu, batas waktunya, dan "janji jawaban" (Promise) yang
// DIJAMIN selesai dan TIDAK PERNAH gagal (reject).
export type ApprovalTicket = {
  approvalId: string;
  expiresAt: string;
  outcome: Promise<ApprovalOutcome>;
};

// Hasil mencoba memutuskan sebuah kartu. Selalu salah satu dari empat bentuk.
export type DecideResult =
  | { ok: true; approval: ApprovalSnapshot }
  // Bentuk keputusan salah (misalnya "partial" tanpa rincian hunk).
  | { ok: false; reason: "invalid"; message: string }
  // Nomor kartu tidak dikenal (belum pernah ada, atau sudah terlalu lama dilupakan).
  | { ok: false; reason: "unknown" }
  // Kartu sudah selesai: keputusan kedua, atau yang datang terlambat. `status` memberi
  // tahu hasil yang SEBENARNYA berlaku, supaya HP bisa menampilkannya.
  | { ok: false; reason: "already_resolved"; status: FinalApprovalStatus };

// Kabar perubahan untuk pihak lain (timeline, relay): kartu dibuka, atau diselesaikan.
export type ApprovalChange = { type: "requested" | "resolved"; approval: ApprovalSnapshot };

export type ApprovalEngineOptions = {
  // Pembaca jam dan pembuat nomor kartu. Bisa diganti di test supaya hasilnya pasti.
  now?: () => number;
  newId?: () => string;
  logger?: Logger;
  onChange?: (change: ApprovalChange) => void;
  defaultTimeoutMs?: number;
};

// Batas menunggu bawaan: 540 detik (9 menit). SENGAJA lebih pendek dari batas hook di
// konfigurasi Claude Code (600 detik, hook-config.ts). Dengan begitu daemon yang
// memutuskan "waktu habis" lebih dulu dan menjawab dengan benar, bukan Claude Code yang
// menyerah dan memutus koneksi. Sisa 60 detik adalah ruang aman. Ada test yang menjaga
// angka ini tetap lebih kecil.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 540_000;

// Kartu yang sudah selesai disimpan sebentar supaya keputusan yang terlambat bisa dijawab
// "sudah selesai, hasilnya X" dan bukan sekadar "tidak dikenal". Jumlahnya dibatasi.
export const MAX_RESOLVED_KEPT = 1000;

// ---- MESIN ----------------------------------------------------------------------------

// Isi internal satu kartu: foto + alat untuk menyelesaikannya.
type Entry = {
  snapshot: ApprovalSnapshot;
  settle: (outcome: ApprovalOutcome) => void; // menyelesaikan "janji jawaban"
  timer: ReturnType<typeof setTimeout> | undefined;
  expiresAtMs: number;
};

export type ApprovalEngine = ReturnType<typeof createApprovalEngine>;

export function createApprovalEngine(options: ApprovalEngineOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? randomUUID;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const pending = new Map<string, Entry>(); // kartu yang masih menunggu
  const resolved = new Map<string, ApprovalSnapshot>(); // kartu selesai (dibatasi jumlahnya)
  let closed = false; // true setelah close(): tidak menerima kartu baru

  const copy = (snapshot: ApprovalSnapshot): ApprovalSnapshot => structuredClone(snapshot);

  // Memberi kabar ke pihak lain. Kesalahan di pendengar TIDAK boleh merusak mesin.
  function notify(type: ApprovalChange["type"], snapshot: ApprovalSnapshot) {
    try {
      options.onChange?.({ type, approval: copy(snapshot) });
    } catch (error) {
      options.logger?.error(`pendengar persetujuan gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // SATU-SATUNYA tempat sebuah kartu diselesaikan. Semua jalur (keputusan, waktu habis,
  // pembatalan) lewat sini, jadi aturan "hanya sekali" dan "hanya dari pending" cukup dijaga
  // di satu tempat. Mengembalikan false bila kartu sudah selesai lebih dulu.
  function settle(approvalId: string, status: FinalApprovalStatus, extra: { comment?: string; hunks?: HunkDecision[] } = {}): boolean {
    const entry = pending.get(approvalId);
    if (!entry || !canTransition(entry.snapshot.status, status)) return false;

    pending.delete(approvalId); // keluar dari antrean SEBELUM apa pun, jadi tidak bisa terulang
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    entry.snapshot.status = status;
    entry.snapshot.resolvedAt = new Date(now()).toISOString();
    if (extra.comment !== undefined) entry.snapshot.comment = extra.comment;
    if (extra.hunks !== undefined) entry.snapshot.hunks = extra.hunks;

    // Simpan sebentar sebagai "kartu selesai"; buang yang paling lama bila kebanyakan.
    resolved.set(approvalId, entry.snapshot);
    if (resolved.size > MAX_RESOLVED_KEPT) {
      const oldest = resolved.keys().next().value;
      if (oldest !== undefined) resolved.delete(oldest);
    }

    options.logger?.info(`persetujuan ${status} alat=${entry.snapshot.toolName}`);
    // Jawab hook yang menunggu, lalu kabari pihak lain.
    entry.settle({
      status,
      ...(extra.comment !== undefined ? { comment: extra.comment } : {}),
      ...(extra.hunks !== undefined ? { hunks: extra.hunks } : {}),
    });
    notify("resolved", entry.snapshot);
    return true;
  }

  // Membatalkan semua kartu yang menunggu. Mengembalikan jumlahnya.
  const cancelAll = (): number => {
    let count = 0;
    for (const approvalId of [...pending.keys()]) {
      if (settle(approvalId, "cancelled")) count++;
    }
    return count;
  };

  return {
    /**
     * Membuka satu kartu. Hook menunggu di `outcome`.
     * Bila mesin sudah ditutup (daemon berhenti), kartu langsung dibatalkan, jadi hook
     * yang telat masuk tetap mendapat jawaban.
     */
    request(input: ApprovalRequestInput): ApprovalTicket {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new RangeError(`Batas waktu persetujuan tidak valid: ${timeoutMs}`);
      }

      const createdMs = now();
      const approvalId = newId();
      const snapshot: ApprovalSnapshot = {
        approvalId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        toolInput: structuredClone(input.toolInput),
        ...(input.risk !== undefined ? { risk: input.risk } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        status: "pending",
        createdAt: new Date(createdMs).toISOString(),
        expiresAt: new Date(createdMs + timeoutMs).toISOString(),
      };

      let settleOutcome: (outcome: ApprovalOutcome) => void = () => undefined;
      // Janji ini hanya punya jalur "selesai" (resolve), tidak ada jalur gagal. Itulah
      // yang membuat jawabannya terjamin.
      const outcome = new Promise<ApprovalOutcome>((resolve) => {
        settleOutcome = resolve;
      });

      const entry: Entry = { snapshot, settle: settleOutcome, timer: undefined, expiresAtMs: createdMs + timeoutMs };
      pending.set(approvalId, entry);
      notify("requested", snapshot);

      if (closed) {
        settle(approvalId, "cancelled");
      } else {
        entry.timer = setTimeout(() => settle(approvalId, "timed_out"), timeoutMs);
        // unref: timer ini sendirian tidak boleh menahan proses tetap hidup.
        if (typeof entry.timer === "object") entry.timer.unref();
      }
      return { approvalId, expiresAt: snapshot.expiresAt, outcome };
    },

    /**
     * Mencoba memutuskan sebuah kartu. `input` datang dari HP lewat jaringan, jadi
     * diperlakukan sebagai data tak tepercaya dan diperiksa dulu (`unknown`).
     */
    decide(input: unknown): DecideResult {
      const parsed = ApprovalDecisionSchema.safeParse(input);
      if (!parsed.success) {
        // Pesan menyebut kolom mana yang salah (misalnya "hunks: ..."), supaya penolakan mudah
        // dilacak. Pesan Zod hanya menyebut jenis kesalahan dan nama kolom, bukan nilai yang dikirim.
        return { ok: false, reason: "invalid", message: `keputusan tidak sesuai kontrak: ${formatIssues(parsed.error)}` };
      }
      const decision = parsed.data;

      const entry = pending.get(decision.approvalId);
      if (!entry) {
        const done = resolved.get(decision.approvalId);
        if (done) return { ok: false, reason: "already_resolved", status: done.status as FinalApprovalStatus };
        return { ok: false, reason: "unknown" };
      }

      // Kartu yang waktunya sudah lewat tidak boleh diputuskan (FR-29), walau timer-nya
      // belum sempat berjalan. Selesaikan sebagai timed_out dulu, baru tolak keputusan ini.
      if (now() >= entry.expiresAtMs) {
        settle(decision.approvalId, "timed_out");
        return { ok: false, reason: "already_resolved", status: "timed_out" };
      }

      const status: FinalApprovalStatus =
        decision.decision === "approve" ? "approved" : decision.decision === "deny" ? "denied" : "partially_approved";
      settle(decision.approvalId, status, {
        ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
        ...(decision.hunks !== undefined ? { hunks: decision.hunks } : {}),
      });
      const done = resolved.get(decision.approvalId);
      return done ? { ok: true, approval: copy(done) } : { ok: false, reason: "unknown" };
    },

    // Membatalkan semua kartu milik satu sesi (sesi berakhir). Mengembalikan jumlahnya.
    cancelSession(sessionId: string): number {
      let count = 0;
      for (const [approvalId, entry] of [...pending]) {
        if (entry.snapshot.sessionId === sessionId && settle(approvalId, "cancelled")) count++;
      }
      return count;
    },

    cancelAll,

    // Dipanggil saat daemon berhenti: batalkan semua yang menunggu DAN tolak kartu baru
    // (kartu baru langsung dibatalkan). Aman dipanggil berulang.
    close(): number {
      closed = true;
      return cancelAll();
    },

    // Foto satu kartu, baik yang menunggu maupun yang sudah selesai.
    get(approvalId: string): ApprovalSnapshot | undefined {
      const found = pending.get(approvalId)?.snapshot ?? resolved.get(approvalId);
      return found ? copy(found) : undefined;
    },

    // Kartu yang masih menunggu, yang paling lama dibuka di depan. Pengurutan menurut
    // risiko (FR-27) dilakukan lapisan tampilan setelah penilai risiko ada.
    listPending(): ApprovalSnapshot[] {
      return [...pending.values()].map((entry) => copy(entry.snapshot));
    },
  };
}
