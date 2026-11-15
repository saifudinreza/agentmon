// =====================================================================================
// FILE INI: pemicu notifikasi = "PETUGAS JAGA" yang memutuskan KAPAN HP perlu dibangunkan, dan seberapa sering.
// =====================================================================================
//
// Pengirim push (push.ts) hanya tahu CARA mengirim. Modul ini tahu KAPAN: dua kejadian yang layak membangunkan HP,
// dan semua keputusan "kirim atau tidak" ada di sini, di satu tempat.
//
//   - approval.requested  -> "ada izin yang menunggu keputusan"            (FR-30)
//   - agent.stopped       -> "agent selesai"                                (FR-31)
//
// SEPULUH PERMINTAAN BERUNTUN TIDAK BOLEH MENJADI SEPULUH NOTIFIKASI. Caranya, per sesi dan per jenis:
//   1. Kejadian pertama langsung dikirim (HP berbunyi seketika).
//   2. Selama jendela waktu berjalan (izin 10 detik, selesai 60 detik), kejadian berikutnya hanya MENANDAI "ada yang
//      baru" dan tidak mengirim apa pun.
//   3. Saat jendela berakhir dan ada yang baru, SATU pesan ringkasan dikirim (jumlah terkini), lalu jendela baru dimulai.
//   Notifikasinya memakai tag per sesi, jadi pesan ringkasan MENGGANTIKAN yang sebelumnya, bukan menumpuk. Hasilnya
//   sepuluh permintaan dalam sekejap menjadi paling banyak dua notifikasi, dan satu pesan per sesi per jendela.
//   Jendela hanya dibuka bila sesuatu benar-benar dikirim: kiriman yang tidak menghasilkan apa-apa (semua izin sudah
//   selesai, ditolak penyaring, tidak ada HP yang mau) membuat kejadian berikutnya kembali menjadi kiriman langsung,
//   bukan menunggu sepuluh detik tanpa notifikasi apa pun. Kiriman satu sesi dirantai (tidak saling menyalip), supaya
//   ringkasan yang lebih baru tidak tertimpa kiriman lama yang tiba belakangan.
//   Himpunan izin dianggap "sudah diberitahukan" HANYA setelah penyaring mengizinkan dan pengiriman tidak gagal: yang
//   ditolak atau gagal tetap boleh dicoba lagi.
//
// ISI PUSH SELALU HANYA NOMOR DAN JUMLAH (FR-34). Modul ini sengaja TIDAK membaca isi event (payload): ia hanya melihat
// jenis, nomor laptop, dan nomor sesi. Perintah, kode, atau nama berkas tidak mungkin ikut terkirim karena tidak pernah
// dibaca. Jumlah izin yang menunggu dihitung dari riwayat lewat `pending`.
//
// POLICY (#037): setiap keputusan lewat `filter`. Satu titik untuk menyaring ("jangan bangunkan untuk risiko rendah",
// "jam tenang", dan seterusnya) tanpa menyentuh bagian lain.
//
// YANG TIDAK DILAKUKAN: menghapus notifikasi dari jauh ketika izin sudah diputuskan di perangkat lain. iOS mewajibkan
// SETIAP push menampilkan notifikasi; push "senyap" untuk menghapus justru membuat notifikasi baru di tiap keputusan,
// dan bisa membuat Apple mencabut langganan. Sebagai gantinya: (1) notifikasi diganti per sesi; (2) service worker menutup
// notifikasi izin yang sudah melewati batas waktu izin setiap kali push berikutnya tiba; dan (3) aplikasi membersihkannya
// saat dibuka (web/src/push/stale.tsx). TTL Web Push BUKAN pembersih: ia hanya mengatur berapa lama layanan push menyimpan
// pesan yang belum terkirim, dan notifikasi yang sudah tampil tidak hilang karenanya.
import type { Envelope, PendingApproval, PushPayload } from "@agentmon/shared";
import { APPROVAL_EVENT_TYPES, APPROVAL_LOOKBACK_MS, computePendingApprovals } from "./approvals";
import type { Store } from "./db/store";
import { silentLogger, type Logger } from "./logger";
import type { PushService } from "./push";

export type NotifyKind = "approval" | "done";

/** Satu keputusan "bangunkan HP" yang akan dikirim. Dilihat `filter` sebelum benar-benar dikirim. */
export type NotifyDecision = {
  kind: NotifyKind;
  machineId: string;
  sessionId: string;
  count?: number;
  /** Risiko TERTINGGI di antara izin yang menunggu (hanya untuk jenis izin dan bila ada izin yang berisiko dinilai). Bukan isi permintaan. */
  risk?: "low" | "medium" | "high";
};
export type NotifyFilter = (decision: NotifyDecision) => boolean | Promise<boolean>;

type Cancelable = { cancel(): void };

export type NotifierOptions = {
  push: Pick<PushService, "notifyMachine">;
  /** Permintaan izin yang masih menunggu di satu sesi (dihitung dari riwayat; lihat approvals.ts). */
  pending: (machineId: string, sessionId: string) => Promise<readonly PendingApproval[]>;
  /** Titik penyaring kebijakan. Bawaan: semua dikirim. Gagal menyaring (melempar) berarti TIDAK dikirim. */
  filter?: NotifyFilter;
  logger?: Logger;
  /** Jendela penggabungan untuk izin. Bawaan 10 detik. */
  approvalWindowMs?: number;
  /** Jendela penggabungan untuk "agent selesai". Bawaan 60 detik: Claude Code berhenti di akhir setiap giliran. */
  doneWindowMs?: number;
  /** Hanya untuk test: pengatur waktu. Bawaannya setTimeout (tidak menahan proses tetap hidup). */
  schedule?: (callback: () => void, ms: number) => Cancelable;
};

export type Notifier = {
  /** Dipanggil SETELAH sebuah event BARU tersimpan (bukan kiriman ulang). Tidak pernah melempar dan tidak menunggu. */
  onEvent(event: Pick<Envelope, "type" | "machineId" | "sessionId">): void;
  /** Membatalkan semua jendela yang masih berjalan (saat relay berhenti). */
  stop(): void;
  /** Berapa sesi yang sedang punya jendela atau catatan (untuk pemantauan dan test: harus kembali nol saat sepi). */
  activeSessions(): number;
};

export const DEFAULT_APPROVAL_WINDOW_MS = 10_000;
export const DEFAULT_DONE_WINDOW_MS = 60_000;

type Slot = { timer?: Cancelable; dirty: boolean; lastSignature?: string; tail: Promise<unknown> };

// Batas panjang nomor di isi push (sama dengan skema push). Nomor yang lebih panjang tidak boleh membuang seluruh notifikasi.
const MAX_PUSH_ID_LENGTH = 200;
const fits = (id: string) => id.length > 0 && id.length <= MAX_PUSH_ID_LENGTH;
const RISK_RANK = { high: 0, medium: 1, low: 2 } as const;

const defaultSchedule: NonNullable<NotifierOptions["schedule"]> = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

export function createNotifier(options: NotifierOptions): Notifier {
  const logger = options.logger ?? silentLogger;
  const schedule = options.schedule ?? defaultSchedule;
  const windows: Record<NotifyKind, number> = {
    approval: options.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS,
    done: options.doneWindowMs ?? DEFAULT_DONE_WINDOW_MS,
  };
  const slots = new Map<string, Slot>();
  let stopped = false;

  type Built = { payload: PushPayload; signature?: string; risk?: NotifyDecision["risk"] };

  // Membangun isi push. HANYA dari nomor dan jumlah: tidak ada tempat untuk isi event masuk ke sini.
  async function build(kind: NotifyKind, machineId: string, sessionId: string, slot: Slot): Promise<Built | undefined> {
    const session = fits(sessionId) ? { sessionId } : {};
    if (kind === "done") return { payload: { v: 1, kind: "done", machineId, ...session } };
    const waiting = await options.pending(machineId, sessionId);
    if (waiting.length === 0) {
      // Semuanya sudah diputuskan sebelum jendela berakhir. Dicatat satu baris, karena jam laptop yang tertinggal lebih dari
      // batas waktu izin membuat SEMUA izin tampak kedaluwarsa dan notifikasi diam-diam tidak pernah keluar.
      logger.info("notifikasi izin dilewati: tidak ada izin yang menunggu (sudah diputuskan, kedaluwarsa, atau jam laptop tidak sinkron)");
      return undefined;
    }
    // Tanda tangan himpunan permintaan: bila sama dengan yang terakhir DIBERITAHUKAN, pesan ringkasan tidak ada gunanya.
    const signature = waiting.map((p) => p.approvalId).sort().join("\u0000");
    if (signature === slot.lastSignature) return undefined;
    const only = waiting.length === 1 ? waiting[0] : undefined;
    const ranks = waiting.flatMap((p) => (p.risk ? [RISK_RANK[p.risk.level]] : []));
    const risk = ranks.length > 0 ? (["high", "medium", "low"] as const)[Math.min(...ranks)] : undefined;
    return {
      payload: { v: 1, kind: "approval", machineId, ...session, count: Math.min(waiting.length, 9999), ...(only && fits(only.approvalId) ? { approvalId: only.approvalId } : {}) },
      signature,
      ...(risk ? { risk } : {}),
    };
  }

  /**
   * Satu kiriman. Mengembalikan true bila HP benar-benar dicoba dihubungi (atau gagal di tengah jalan: jendela tetap
   * dibuka supaya layanan yang sedang bermasalah tidak dihujani), false bila tidak ada yang dikirim sama sekali.
   */
  async function send(kind: NotifyKind, machineId: string, sessionId: string, slot: Slot): Promise<boolean> {
    try {
      const built = await build(kind, machineId, sessionId, slot);
      if (!built) return false;
      let allowed: boolean;
      try {
        const decision: NotifyDecision = { kind, machineId, sessionId, ...(built.payload.count !== undefined ? { count: built.payload.count } : {}), ...(built.risk ? { risk: built.risk } : {}) };
        allowed = (await options.filter?.(decision)) ?? true;
      } catch {
        allowed = false; // penyaring yang rusak berarti diam, bukan membanjiri
      }
      if (!allowed) return false;
      const result = await options.push.notifyMachine(machineId, built.payload);
      // Dianggap sudah diberitahukan hanya bila tidak ada yang gagal: yang gagal boleh dicoba lagi pada ringkasan berikutnya.
      if (built.signature !== undefined && result.failed === 0) slot.lastSignature = built.signature;
      return result.attempted > 0;
    } catch (error) {
      // Notifikasi bukan alasan agent atau relay berhenti. Hanya jenis galatnya yang dicatat, tanpa isi.
      logger.error(`notifikasi ${kind} gagal dikirim: ${error instanceof Error ? error.name : "galat"}`);
      return true;
    }
  }

  function startWindow(key: string, kind: NotifyKind, machineId: string, sessionId: string, slot: Slot): void {
    slot.timer = schedule(() => {
      slot.timer = undefined;
      if (!slot.dirty) {
        if (slots.get(key) === slot) slots.delete(key); // sepi satu jendela penuh: lupakan sesi ini
        return;
      }
      slot.dirty = false;
      run(key, kind, machineId, sessionId, slot); // jendela berikutnya, supaya tetap satu pesan per jendela
    }, windows[kind]);
  }

  // Tidak ada yang dikirim: tutup jendela. Kejadian yang datang sambil menunggu dievaluasi langsung, sisanya dilupakan.
  function closeWindow(key: string, kind: NotifyKind, machineId: string, sessionId: string, slot: Slot): void {
    slot.timer?.cancel();
    slot.timer = undefined;
    if (slot.dirty && !stopped) {
      slot.dirty = false;
      run(key, kind, machineId, sessionId, slot);
      return;
    }
    if (slots.get(key) === slot) slots.delete(key);
  }

  function run(key: string, kind: NotifyKind, machineId: string, sessionId: string, slot: Slot): void {
    if (stopped) return;
    startWindow(key, kind, machineId, sessionId, slot);
    // Dirantai: kiriman satu sesi tidak saling menyalip, jadi ringkasan terbaru tidak tertimpa kiriman lama yang tiba belakangan.
    slot.tail = slot.tail
      .then(() => send(kind, machineId, sessionId, slot))
      .then((sent) => {
        if (!sent) closeWindow(key, kind, machineId, sessionId, slot);
      });
  }

  function trigger(kind: NotifyKind, machineId: string, sessionId: string): void {
    if (stopped) return;
    const key = `${kind}\u0000${machineId}\u0000${sessionId}`;
    let slot = slots.get(key);
    if (slot?.timer) {
      slot.dirty = true; // di dalam jendela: hanya menandai
      return;
    }
    if (!slot) {
      slot = { dirty: false, tail: Promise.resolve() };
      slots.set(key, slot);
    }
    run(key, kind, machineId, sessionId, slot); // kejadian pertama: langsung
  }

  return {
    onEvent(event) {
      if (event.type === "approval.requested") trigger("approval", event.machineId, event.sessionId);
      else if (event.type === "agent.stopped") trigger("done", event.machineId, event.sessionId);
    },
    stop() {
      stopped = true;
      for (const slot of slots.values()) slot.timer?.cancel();
      slots.clear();
    },
    activeSessions: () => slots.size,
  };
}

/**
 * Membungkus penyimpan event: pemicu dipanggil HANYA untuk event yang benar-benar baru tersimpan. Event kiriman ulang
 * (daemon mengirim lagi setelah koneksi putus) `inserted: false` dan tidak boleh membunyikan HP dua kali. Galat di
 * pemicu tidak pernah menggagalkan penyimpanan (yang di-ack ke laptop), dan hasil penyimpanan diteruskan apa adanya.
 */
export function notifyAfterSave<R extends { inserted: boolean } | void>(
  save: (event: Envelope) => Promise<R>,
  notifier: Pick<Notifier, "onEvent">,
): (event: Envelope) => Promise<R> {
  return async (event) => {
    const stored = await save(event);
    if (!stored || stored.inserted) {
      try {
        notifier.onEvent(event);
      } catch {
        // pemicu tidak boleh menggagalkan penyimpanan
      }
    }
    return stored;
  };
}

/** Pencari permintaan izin yang menunggu di satu sesi, dihitung dari riwayat yang sama dengan API HP (approvals.ts). */
export function pendingLookup(store: Pick<Store, "listRecentByType">, now: () => Date = () => new Date()): NotifierOptions["pending"] {
  return async (machineId, sessionId) => {
    const at = now();
    const events = await store.listRecentByType(machineId, [...APPROVAL_EVENT_TYPES], new Date(at.getTime() - APPROVAL_LOOKBACK_MS));
    return computePendingApprovals(events, at).filter((approval) => approval.sessionId === sessionId);
  };
}
