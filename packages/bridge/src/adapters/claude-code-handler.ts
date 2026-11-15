// =====================================================================================
// FILE INI: penangan hook Claude Code = "PETUGAS LOKET".
// =====================================================================================
//
// POSISI FILE INI DI ALUR PROYEK:
//
//   Claude Code --POST /hook--> server.ts --(input, konteks)--> [FILE INI]
//                                                                  |
//                              1. minta penerjemah (claude-code.ts) menerjemahkan
//                              2. beri nomor urut per sesi
//                              3. kirim event ke "kotak surat" (EventSink) DI BELAKANG LAYAR
//                              4. aksi yang perlu keputusan? TAHAN, tunggu approval engine
//                              5. jawab Claude Code: izinkan, tolak + alasan, atau tanpa keputusan
//
// ANALOGI: petugas loket di kantor pos.
//   - Penerjemah (claude-code.ts) hanya menerjemahkan. Ia tidak punya ingatan.
//   - Petugas loket (file ini) yang MENGINGAT nomor antrean tiap sesi, menempelkan
//     stempel, memasukkan surat ke kotak pos, lalu melayani tamu berikutnya tanpa
//     menunggu suratnya sampai tujuan.
//   - Untuk surat bertanda "perlu tanda tangan" (aksi yang mengubah berkas), petugas
//     menyimpannya di buku antrean izin (approvals.ts) dan MENUNGGU tanda tangan sebelum
//     mengembalikan jawaban ke tamu. Tamu lain tetap dilayani oleh petugas lain selama itu.
//
// ATURAN EMAS (anti-macet): AgentMon tidak boleh jadi alasan agent berhenti bekerja, dan
// tidak boleh meloloskan aksi karena gagal. Maka jawaban selalu salah satu dari tiga:
//   - izinkan      : HANYA bila pengguna menyetujui;
//   - tolak + alasan: bila pengguna menolak (komentarnya dibaca Claude);
//   - tanpa keputusan (`undefined`): untuk SEMUA yang lain (waktu habis, dibatalkan, dijeda,
//     error, dan hal yang belum didukung). Claude Code lalu bertanya di terminal seperti biasa.
//
// Menahan aksi hanya terjadi bila control.canHold() benar: penahanan menyala dan daemon tidak
// sedang dijeda (lihat control.ts).

// ---- IMPORT ---------------------------------------------------------------------------
//
// randomUUID: pembuat nomor unik acak (UUID) bawaan Node.js, untuk `id` tiap event.
// "node:crypto" = modul bawaan Node, tidak perlu dipasang dari internet.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
// Tipe event baku dari paket shared (hanya tipe, tidak ikut jalan di program akhir).
import type { AgentMonEvent, EventType, FileDiff, Risk } from "@agentmon/shared";
// Dari server.ts: HookContext = bekal dari daemon (pencatat log, identitas laptop, buku antrean
// izin, panel kontrol), HookHandler = bentuk fungsi penangan yang diminta server.
import { computeToolDiff, type ToolDiffInput } from "../diff";
import { assessRisk, type AssessInput } from "../risk";
import { summarizeDiff } from "../control";
import { buildDiffSummary } from "../diff-summary";
import type { HookContext, HookHandler } from "../server";
// Penerjemah dari file tetangga. "./claude-code" = file claude-code di folder yang sama.
import type { CheckpointResult } from "../checkpoint";
import { buildClaudeEvent, FILE_MUTATING_TOOLS, holdCandidate, mapClaudeCodeHook, toClaudeDecision, type HoldCandidate, type Stamp } from "./claude-code";

// ---- BATAS UKURAN ISI EVENT ------------------------------------------------------------
//
// Event izin dikirim ke relay, yang menolak pesan lebih dari 1 MiB. Bila terlalu besar, event DIBUANG dan HP
// tidak pernah melihat permintaannya, padahal daemon tetap menahan aksi sampai batas waktu. Maka isi yang
// berpotensi besar dipotong atau dihilangkan SEBELUM dikirim; yang ditahan daemon tetap utuh.
// Batas dihitung dalam BYTE (bukan karakter): teks multibyte bisa jauh lebih besar dari jumlah karakternya.
const MAX_INPUT_VALUE_BYTES = 150_000; // satu nilai input (misalnya isi berkas yang ditulis)
const MAX_DIFF_JSON_BYTES = 300_000; // seluruh diff
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const TRUNCATED_MARK = " …[dipotong: terlalu panjang untuk dikirim ke HP]";

// `truncated` = ada isi yang TIDAK sampai ke HP. HP lalu menolak menyetujui (yang disetujui harus sama dengan yang terlihat).
function boundToolInput(toolInput: Record<string, unknown>): { input: Record<string, unknown>; truncated: boolean } {
  const input: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === "string") {
      if (byteLength(value) > MAX_INPUT_VALUE_BYTES) {
        input[key] = `${Buffer.from(value, "utf8").subarray(0, MAX_INPUT_VALUE_BYTES).toString("utf8")}${TRUNCATED_MARK}`;
        truncated = true;
      } else input[key] = value;
    } else if (byteLength(JSON.stringify(value) ?? "") > MAX_INPUT_VALUE_BYTES) {
      input[key] = "[terlalu besar untuk dikirim ke HP]";
      truncated = true;
    } else input[key] = value;
  }
  return { input, truncated };
}

function fitsInEvent(diff: FileDiff): boolean {
  return byteLength(JSON.stringify(diff)) <= MAX_DIFF_JSON_BYTES;
}

// ---- TIPE -----------------------------------------------------------------------------

// Penerima event = "KOTAK SURAT". Nanti diisi klien relay (mengirim ke HP) dan penyimpan
// timeline. Sekarang isinya hanya mencatat ke log. Boleh sinkron (langsung selesai) atau
// asinkron (mengembalikan Promise = "janji hasil nanti"); keduanya tidak menahan jawaban
// ke Claude Code.
//
// "void | Promise<void>" dibaca: fungsi ini tidak mengembalikan nilai, dan boleh berupa
// pekerjaan yang selesai belakangan.
//
// Yang WAJIB diperhatikan penerima:
// - Pemanggilan berurutan sesuai `seq`, tetapi penyelesaian penerima asinkron bisa tidak
//   berurutan. Susun ulang berdasarkan `seq` bila urutan penting.
// - Event yang gagal dikirim hanya dicatat di log, tidak dicoba lagi. Penerima yang butuh
//   kelengkapan (misalnya klien relay) harus punya antrean dan percobaan ulang sendiri;
//   di sini yang dijaga hanya satu hal: agent tidak boleh menunggu penerima.
// - `seq` bisa punya celah bila pengiriman gagal, dan mulai dari 0 lagi bila daemon dimulai ulang.
export type EventSink = (event: AgentMonEvent, context: HookContext) => void | Promise<void>;

// Pengaturan saat membuat petugas loket.
//   emit  = kotak surat tujuan (wajib).
//   now   = pembaca jam. Tanda "?" = boleh tidak diisi. Bawaan: jam sungguhan.
//   newId = pembuat nomor unik. Bawaan: randomUUID.
// now dan newId bisa diganti di test supaya hasilnya pasti (jam dan id "dipalsukan").
export type ClaudeCodeHandlerOptions = {
  emit: EventSink;
  now?: () => Date;
  newId?: () => string;
  // Batas jumlah sesi yang diingat. Bawaan MAX_TRACKED_SESSIONS; test memakai angka kecil.
  maxTrackedSessions?: number;
  // Penghitung diff dan batas waktunya. Bawaan: computeToolDiff dan DIFF_TIMEOUT_MS. Bisa diganti di test.
  computeDiff?: (input: ToolDiffInput) => Promise<FileDiff | undefined>;
  diffTimeoutMs?: number;
  // Penilai risiko. Bawaan: assessRisk (berbasis aturan, murni) dengan realpath dan folder rumah sungguhan. Bisa diganti di test.
  assess?: (input: AssessInput) => Risk;
  // Pembuat checkpoint (foto keadaan proyek) yang diambil sebelum alat pengubah berkas dijalankan. Tanpa ini,
  // tidak ada checkpoint. Tidak boleh melempar, dan kegagalannya tidak pernah menghalangi agent.
  checkpoint?: (cwd: string, sessionId: string) => Promise<CheckpointResult>;
  // Menyerahkan "pemancar event" ke pemanggil, untuk event yang lahir di luar hook (mis. checkpoint.restored setelah
  // rollback dari HP). Nomor urut dan stempelnya tetap dari penangan ini, jadi urutan event sesi tidak bentrok.
  // Dipanggil untuk SETIAP hook yang masuk (sebelum diproses), mis. untuk tahu agent baru menerima perintah.
  onHookInput?: (input: Record<string, unknown>) => void;
  registerEmitter?: (emit: (type: EventType, payload: Record<string, unknown>, sessionId: string) => void) => void;
};

// Batas jumlah sesi yang nomor urutnya diingat sekaligus. Mencegah ingatan membengkak bila
// banyak sesi berakhir mendadak (crash) tanpa pernah mengirim SessionEnd.
export const MAX_TRACKED_SESSIONS = 1000;

// Batas waktu menghitung diff. Diff hanya bahan tampilan: menghitungnya tidak boleh menunda aksi
// lebih dari ini (misalnya berkas ada di jaringan yang lambat).
export const DIFF_TIMEOUT_MS = 2000;

// Berapa lama sebuah aksi yang "dilepas ke terminal" diingat. Lihat `released` di bawah.
export const RELEASED_TTL_MS = 60_000;
const MAX_RELEASED = 200;

// ---- FUNGSI UTAMA: pabrik petugas loket ------------------------------------------------
//
// Fungsi ini MEMBUAT sebuah penangan. Penangan itu sendiri adalah fungsi yang dipanggil
// server tiap kali ada hook masuk. Pola "fungsi yang mengembalikan fungsi" ini disebut
// CLOSURE: fungsi yang dikembalikan tetap "mengingat" variabel di sekitarnya (nextSeq, now,
// newId, options) walau pembuatnya sudah selesai. Analogi: petugas baru yang diberi buku
// catatan pribadi; buku itu ikut dibawa ke mana pun ia bertugas.
/** Menyelesaikan tautan simbolik; undefined bila jalurnya tidak ada atau tidak bisa dibaca. */
function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function createClaudeCodeHandler(options: ClaudeCodeHandlerOptions): HookHandler {
  // "??" = kalau yang kiri tidak diisi, pakai yang kanan.
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const maxTracked = options.maxTrackedSessions ?? MAX_TRACKED_SESSIONS;
  const computeDiff = options.computeDiff ?? computeToolDiff;
  const diffTimeoutMs = options.diffTimeoutMs ?? DIFF_TIMEOUT_MS;
  const assess = options.assess ?? ((input: AssessInput) => assessRisk(input, { realpath: safeRealpath, home: homedir() }));

  // BUKU NOMOR ANTREAN per sesi. Map = kamus: nama sesi -> nomor urut berikutnya.
  // Dimulai dari 0 dan dihapus saat sesi berakhir.
  // Catatan: ini hanya hidup selama daemon berjalan. Bila daemon dimulai ulang di tengah
  // sesi, urutan sesi itu mulai lagi dari 0; penerima mengandalkan `id` untuk menyaring
  // duplikat.
  //
  // Sesi yang berakhir mendadak (crash, SessionEnd tidak terkirim) tidak pernah dihapus
  // oleh SessionEnd, jadi jumlahnya dibatasi: yang paling lama tidak dipakai disingkirkan.
  const nextSeq = new Map<string, number>();

  // Mencatat nomor urut berikutnya sebuah sesi, sekaligus menjaga batas jumlah sesi.
  // Trik: Map mengingat URUTAN pemasukan. Dengan menghapus lalu memasang lagi, sesi yang
  // baru dipakai pindah ke posisi paling belakang. Jadi yang paling depan selalu yang paling
  // lama tidak dipakai (sistem ini disebut LRU = "least recently used").
  const remember = (sessionId: string, seq: number) => {
    nextSeq.delete(sessionId); // dihapus lalu dipasang lagi = pindah ke posisi "terbaru"
    nextSeq.set(sessionId, seq);
    if (nextSeq.size > maxTracked) {
      // keys() = daftar nama sesi sesuai urutan masuk; .next().value = yang paling depan.
      const oldest = nextSeq.keys().next().value;
      if (oldest !== undefined) nextSeq.delete(oldest);
    }
  };

  // CATATAN SESI untuk rekap saat sesi berakhir: kapan mulai, berkas apa yang diubah (disetujui), dan berapa yang
  // ditolak. Dibatasi seperti nomor antrean: sesi yang mati mendadak tidak boleh membuat ingatan membengkak.
  type SessionStats = { startedMs: number; files: Set<string>; rejected: number };
  const stats = new Map<string, SessionStats>();
  const MAX_RECAP_FILES = 200;
  const statsOf = (sessionId: string, startedMs: number): SessionStats => {
    let entry = stats.get(sessionId);
    if (!entry) {
      entry = { startedMs: Number.isFinite(startedMs) ? startedMs : now().getTime(), files: new Set(), rejected: 0 };
      stats.set(sessionId, entry);
      if (stats.size > maxTracked) {
        const oldest = stats.keys().next().value;
        if (oldest !== undefined) stats.delete(oldest);
      }
    }
    return entry;
  };
  // Sesi yang baru saja berakhir: SessionEnd yang terkirim dua kali tidak menghasilkan dua rekap.
  const recentlyEnded = new Set<string>();

  // Pemberi stempel untuk sebuah sesi. Membaca nomor urut TANPA menaikkannya: nomor baru
  // dinaikkan (remember) hanya setelah event benar-benar jadi, supaya data yang ditolak tidak
  // meninggalkan celah.
  const stampFor =
    (context: HookContext) =>
    (sessionId: string): Stamp => ({
      machineId: context.machineId,
      id: newId(),
      seq: nextSeq.get(sessionId) ?? 0, // sesi baru belum ada di buku -> mulai dari 0
      ts: now().toISOString(), // jam dalam format ISO 8601
    });

  // Pengiriman event ke kotak surat: dijadwalkan lalu DITINGGALKAN. Lambat atau gagalnya
  // penerima tidak boleh menunda jawaban ke agent. Kegagalannya hanya dicatat.
  //
  // Cara bacanya:
  //   Promise.resolve()  = janji yang langsung selesai (sekadar "pintu masuk" antrean).
  //   .then(...)         = "setelah itu, jalankan ini". Tugas ini baru berjalan SETELAH
  //                        fungsi utama selesai (di antrean tugas mikro), sehingga jawaban ke
  //                        agent tidak menunggunya. Bila emit melempar error, error itu ikut
  //                        tertangkap oleh .catch di bawah.
  //   .catch(...)        = bila ada yang gagal, hanya catat ke log.
  //   void               = pernyataan sengaja: "janji ini tidak ditunggu".
  const deliver = (event: AgentMonEvent, context: HookContext) => {
    remember(event.sessionId, event.seq + 1);
    statsOf(event.sessionId, Date.parse(event.ts)); // sesi mulai dihitung dari event pertama yang terlihat
    recentlyEnded.delete(event.sessionId);
    void Promise.resolve()
      .then(() => options.emit(event, context))
      .catch((error: unknown) => {
        // "error instanceof Error" memeriksa apakah ini objek error biasa yang punya
        // .message; kalau bukan, ubah apa pun itu menjadi teks.
        context.logger.error(`gagal mengirim event ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  // Membuat dan mengirim event yang LAHIR DI DAEMON (bukan dari hook), yaitu event persetujuan.
  const emitOwn = (type: EventType, payload: Record<string, unknown>, sessionId: string, context: HookContext) => {
    const built = buildClaudeEvent(type, payload, sessionId, stampFor(context));
    if (built.ok) deliver(built.event, context);
    else context.logger.error(`event ${type} tidak sah: ${built.message}`);
  };

  // AKSI YANG DILEPAS KE TERMINAL. Bila sebuah aksi sudah menunggu di PreToolUse lalu waktunya
  // habis (atau dibatalkan), Claude Code akan LANJUT bertanya lewat PermissionRequest untuk
  // aksi yang sama. Kalau kita menahan lagi di situ, pengguna menunggu dua kali (sampai 18
  // menit) sebelum prompt terminal muncul. Jadi aksi yang baru dilepas dicatat di sini, dan
  // PermissionRequest yang cocok langsung diteruskan tanpa ditahan.
  // Kunci = sesi + nama alat + isi input; nilainya batas kedaluwarsa (ms).
  const released = new Map<string, number>();
  const keyOf = (hold: HoldCandidate) => `${hold.sessionId}\u0000${hold.toolName}\u0000${JSON.stringify(hold.toolInput)}`;
  const markReleased = (hold: HoldCandidate) => {
    released.set(keyOf(hold), now().getTime() + RELEASED_TTL_MS);
    if (released.size > MAX_RELEASED) {
      const oldest = released.keys().next().value;
      if (oldest !== undefined) released.delete(oldest);
    }
  };
  // Mengembalikan true (dan menghapus catatannya) bila aksi ini baru saja dilepas.
  const wasReleased = (hold: HoldCandidate): boolean => {
    const key = keyOf(hold);
    const until = released.get(key);
    if (until === undefined) return false;
    released.delete(key);
    return until > now().getTime();
  };

  // Penilai tidak melempar galat, tetapi penggantinya (test) bisa. Gagal menilai berarti "sedang", tidak pernah "rendah".
  const assessSafely = (hold: HoldCandidate): Risk => {
    try {
      return assess({ toolName: hold.toolName, toolInput: hold.toolInput, ...(hold.cwd !== undefined ? { cwd: hold.cwd } : {}) });
    } catch {
      return { level: "medium", reasons: [{ code: "assessment-error", message: "Penilaian gagal; dianggap perlu ditinjau." }] };
    }
  };

  // Menghitung perubahan berkas yang diusulkan, sebagai bahan tampilan review. TIDAK PERNAH
  // menghalangi aksi: gagal, error, atau melewati batas waktu berarti aksi ditahan tanpa diff.
  const diffFor = async (hold: HoldCandidate, logger: HookContext["logger"]): Promise<FileDiff | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), diffTimeoutMs);
      });
      const diff = await Promise.race([
        computeDiff({ toolName: hold.toolName, toolInput: hold.toolInput, ...(hold.cwd !== undefined ? { cwd: hold.cwd } : {}) }),
        timeout,
      ]);
      if (diff) logger.info(`diff dihitung alat=${hold.toolName}: ${diff.change.type}`);
      return diff;
    } catch (error) {
      logger.error(`diff gagal dihitung: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  // Konteks hook terakhir: dipakai pemancar dari luar hook (identitas laptop dan pencatat log diambil dari sini).
  let lastContext: HookContext | undefined;
  options.registerEmitter?.((type, payload, sessionId) => {
    if (lastContext) emitOwn(type, payload, sessionId, lastContext);
  });

  // CHECKPOINT sebelum alat pengubah berkas. Berjalan di PreToolUse SEBELUM aksi ditahan atau dilepas, jadi
  // fotonya menangkap keadaan sebelum perubahan. Gagal, nonaktif (bukan repo git), atau lambat hanya dicatat:
  // agent tetap berjalan.
  const takeCheckpoint = async (input: Record<string, unknown>, context: HookContext) => {
    if (!options.checkpoint || input.hook_event_name !== "PreToolUse") return;
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    if (!FILE_MUTATING_TOOLS.has(toolName) || !sessionId || !cwd) return;
    try {
      const result = await options.checkpoint(cwd, sessionId);
      if (result.ok) {
        context.logger.info(`checkpoint ${result.id} dibuat dalam ${result.durationMs} ms (alat=${toolName})`);
        emitOwn("checkpoint.created", { checkpointId: result.id }, sessionId, context);
      } else {
        context.logger.info(`checkpoint tidak dibuat (${result.reason}): ${result.message}`);
      }
    } catch (error) {
      context.logger.error(`checkpoint gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // MENAHAN satu aksi sampai ada keputusan, lalu menerjemahkannya jadi jawaban.
  const holdForDecision = async (hold: HoldCandidate, context: HookContext) => {
    const { logger, approvals } = context;

    const diff = await diffFor(hold, logger);
    // Level risiko dihitung HANYA dari alat, input alat, dan folder kerja; penjelasan agent tidak dibaca (FR-73).
    const risk = assessSafely(hold);
    const bounded = boundToolInput(hold.toolInput);
    const diffOmitted = diff !== undefined && !fitsInEvent(diff);
    const ticket = approvals.request({
      sessionId: hold.sessionId,
      toolName: hold.toolName,
      toolInput: hold.toolInput,
      risk,
      ...(diff !== undefined ? { diff } : {}),
    });
    logger.info(`menahan ${hold.point} alat=${hold.toolName}, menunggu keputusan`);
    // Kabari timeline/HP bahwa ada permintaan baru.
    emitOwn(
      "approval.requested",
      {
        approvalId: ticket.approvalId,
        toolName: hold.toolName,
        toolInput: bounded.input,
        risk,
        ...(bounded.truncated || diffOmitted ? { truncated: true } : {}),
        // Ringkasan satu baris dan perubahan berkas untuk ditampilkan di HP sebelum memutuskan.
        ...(diff !== undefined ? { summary: summarizeDiff(diff), diffSummary: buildDiffSummary([diff]), ...(diffOmitted ? {} : { diff }) } : {}),
        expiresAt: ticket.expiresAt,
      },
      hold.sessionId,
      context,
    );

    // MENUNGGU. Janji ini dijamin selesai (keputusan, waktu habis, atau dibatalkan) dan tidak
    // pernah gagal; server tetap melayani hook lain selama kita menunggu di sini.
    const outcome = await ticket.outcome;

    emitOwn(
      "approval.resolved",
      {
        approvalId: ticket.approvalId,
        status: outcome.status,
        ...(outcome.comment !== undefined ? { comment: outcome.comment } : {}),
        ...(outcome.hunks !== undefined ? { hunks: outcome.hunks } : {}),
      },
      hold.sessionId,
      context,
    );
    logger.info(`keputusan ${hold.point} alat=${hold.toolName}: ${outcome.status}`);

    // Bahan rekap sesi: yang ditolak dihitung, yang disetujui dicatat berkasnya.
    const recap = statsOf(hold.sessionId, now().getTime());
    if (outcome.status === "denied") recap.rejected += 1;
    if (outcome.status === "approved" || outcome.status === "partially_approved") {
      for (const key of ["file_path", "notebook_path"]) {
        const value = hold.toolInput[key];
        if (typeof value === "string" && value.trim() !== "" && value.length <= 1000 && recap.files.size < MAX_RECAP_FILES) recap.files.add(value);
      }
    }

    // Bukan keputusan yang bisa diterapkan -> Claude Code akan lanjut ke prompt terminal.
    // Di PreToolUse itu berarti PermissionRequest menyusul; catat supaya tidak ditahan lagi.
    const response = toClaudeDecision(hold.point, outcome);
    if (response === undefined && hold.point === "PreToolUse") markReleased(hold);
    if (outcome.status === "partially_approved") {
      logger.info("terima sebagian belum didukung: kembali ke alur izin normal");
    }
    return response;
  };

  // Ini fungsi yang akan dipanggil server untuk SETIAP hook masuk.
  //   input   = kiriman mentah dari Claude Code
  //   context = bekal dari daemon: pencatat, identitas laptop, buku antrean izin, panel kontrol
  return async (input, context) => {
    const { logger } = context; // ambil pencatat dari bekal
    lastContext = context;
    try {
      options.onHookInput?.(input as Record<string, unknown>);
    } catch {
      // pengamat tidak boleh mengganggu hook
    }

    // try/catch = "coba kerjakan; kalau ada yang meledak, tangkap, jangan biarkan menjalar".
    // Kegagalan apa pun di sini tidak boleh sampai ke agent. Server sudah menjawab {} bila
    // penangan melempar error, tetapi menangkapnya di sini membuat catatannya lebih jelas.
    try {
      // MINTA PENERJEMAH bekerja. Parameter kedua adalah "callback" yang dipanggil penerjemah
      // hanya bila butuh stempel (lihat stampFor di atas).
      const result = mapClaudeCodeHook(input, stampFor(context));

      // Bertindak sesuai HASIL terjemahan. "switch" memilih satu cabang berdasarkan `status`.
      switch (result.status) {
        // Terjemahan berhasil menjadi event baku -> kirim ke kotak surat.
        case "event":
          deliver(result.event, context);
          break; // keluar dari switch, jangan lanjut ke cabang berikutnya
        // Sesi selesai -> (1) lupakan nomor antrean sesi itu supaya ingatan tidak menumpuk;
        // (2) batalkan izin yang masih menunggu dari sesi itu, karena agent-nya sudah tidak
        // ada untuk menerima jawaban. Hook yang menunggu izin itu langsung dijawab.
        case "session_ended": {
          // Rekap sesi: tanpa ini relay tidak pernah tahu sesinya selesai dan HP menampilkannya "Aktif" selamanya.
          // Dikirim SEBELUM nomor antrean dilupakan supaya nomor urutnya tetap berlanjut.
          if (!recentlyEnded.has(result.sessionId)) {
            const recap = stats.get(result.sessionId);
            emitOwn(
              "session.recap",
              {
                durationMs: recap ? Math.max(0, now().getTime() - recap.startedMs) : 0,
                filesChanged: recap ? [...recap.files] : [],
                rejected: recap?.rejected ?? 0,
                autoApproved: 0, // belum ada policy engine
              },
              result.sessionId,
              context,
            );
            recentlyEnded.add(result.sessionId);
            if (recentlyEnded.size > 500) {
              const oldest = recentlyEnded.values().next().value;
              if (oldest !== undefined) recentlyEnded.delete(oldest);
            }
          }
          stats.delete(result.sessionId);
          nextSeq.delete(result.sessionId);
          const cancelled = context.approvals.cancelSession(result.sessionId);
          if (cancelled > 0) logger.info(`sesi berakhir: ${cancelled} permintaan izin dibatalkan`);
          break;
        }
        // Nama event tidak dikenal -> cukup dicatat. Hanya nama event yang dicatat, tidak
        // pernah isinya (isi bisa berisi kode atau rahasia).
        case "unknown":
          logger.info(`event hook tidak dikenal: ${result.hookEvent} (diabaikan)`);
          break;
        // Isi rusak / kolom wajib hilang -> dicatat sebagai error, tanpa isi data.
        case "invalid":
          logger.error(`input hook ${result.hookEvent} tidak sah: ${result.message}`);
          break;
        // Permintaan izin -> ditangani di bagian "tahan" di bawah. Di sini cukup dicatat.
        case "permission_request":
          logger.info(`permintaan izin diterima: alat=${result.request.toolName}`);
          break;
        // Sengaja tidak dipakai (UserPromptSubmit). Tidak perlu apa-apa.
        case "ignored":
          break;
      }

      await takeCheckpoint(input as Record<string, unknown>, context);

      // APAKAH AKSI INI DITAHAN? Hanya bila penahanan menyala dan tidak dijeda, aksinya layak
      // ditahan (alat pengubah berkas di PreToolUse, atau permintaan izin dari Claude), dan
      // bukan aksi yang baru saja dilepas ke terminal.
      const hold = holdCandidate(input);
      if (!hold) return undefined;
      // Catatan "dilepas" selalu dikonsumsi di sini (walau tidak jadi menahan), supaya tidak
      // tertinggal dan salah meloloskan permintaan lain yang kebetulan sama nanti.
      const alreadyReleased = hold.point === "PermissionRequest" && wasReleased(hold);
      if (!context.control.canHold()) {
        // Dijeda adalah pilihan pengguna, jadi dicatat supaya jelas dari log kenapa aksi ini tidak
        // ditahan. Penahanan yang mati (keadaan bawaan) sengaja tidak dicatat per aksi: itu akan
        // menggandakan baris log tiap hook, dan perintah `status` sudah menjelaskannya.
        if (context.control.isPaused()) logger.info(`tidak ditahan karena dijeda: ${hold.point} alat=${hold.toolName}`);
        return undefined;
      }
      if (alreadyReleased) {
        logger.info(`diteruskan ke terminal tanpa menahan lagi: alat=${hold.toolName}`);
        return undefined;
      }
      return await holdForDecision(hold, context);
    } catch (error) {
      // Jaring pengaman terakhir: kesalahan tak terduga di langkah mana pun hanya dicatat,
      // dan jawabannya tetap "tanpa keputusan".
      logger.error(`pemetaan hook gagal: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
