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
//                              4. langsung jawab "tidak ada keputusan"
//
// ANALOGI: petugas loket di kantor pos.
//   - Penerjemah (claude-code.ts) hanya menerjemahkan. Ia tidak punya ingatan.
//   - Petugas loket (file ini) yang MENGINGAT nomor antrean tiap sesi, menempelkan
//     stempel, memasukkan surat ke kotak pos, lalu melayani tamu berikutnya tanpa
//     menunggu suratnya sampai tujuan.
//
// ATURAN EMAS (anti-macet): AgentMon tidak boleh jadi alasan agent berhenti. Maka petugas
// ini SELALU menjawab cepat dengan `undefined` (= "tidak ada keputusan", sehingga alur izin
// normal Claude Code berjalan), apa pun yang terjadi di belakang: kotak pos penuh, macet,
// atau error sekalipun.
//
// Menahan aksi sampai ada keputusan (PreToolUse dan PermissionRequest) dikerjakan issue
// berikutnya. Di sini semua jawaban adalah `undefined`.

// ---- IMPORT ---------------------------------------------------------------------------
//
// randomUUID: pembuat nomor unik acak (UUID) bawaan Node.js, untuk `id` tiap event.
// "node:crypto" = modul bawaan Node, tidak perlu dipasang dari internet.
import { randomUUID } from "node:crypto";
// Tipe event baku dari paket shared (hanya tipe, tidak ikut jalan di program akhir).
import type { AgentMonEvent } from "@agentmon/shared";
// Dari server.ts: HookContext = bekal dari daemon (pencatat log + identitas laptop),
// HookHandler = bentuk fungsi penangan yang diminta server.
import type { HookContext, HookHandler } from "../server";
// Penerjemah dari file tetangga. "./claude-code" = file claude-code di folder yang sama.
import { mapClaudeCodeHook, type Stamp } from "./claude-code";

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
};

// Batas jumlah sesi yang nomor urutnya diingat sekaligus. Mencegah ingatan membengkak bila
// banyak sesi berakhir mendadak (crash) tanpa pernah mengirim SessionEnd.
export const MAX_TRACKED_SESSIONS = 1000;

// ---- FUNGSI UTAMA: pabrik petugas loket ------------------------------------------------
//
// Fungsi ini MEMBUAT sebuah penangan. Penangan itu sendiri adalah fungsi yang dipanggil
// server tiap kali ada hook masuk. Pola "fungsi yang mengembalikan fungsi" ini disebut
// CLOSURE: fungsi yang dikembalikan tetap "mengingat" variabel di sekitarnya (nextSeq, now,
// newId, options) walau pembuatnya sudah selesai. Analogi: petugas baru yang diberi buku
// catatan pribadi; buku itu ikut dibawa ke mana pun ia bertugas.
export function createClaudeCodeHandler(options: ClaudeCodeHandlerOptions): HookHandler {
  // "??" = kalau yang kiri tidak diisi, pakai yang kanan.
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

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
    if (nextSeq.size > MAX_TRACKED_SESSIONS) {
      // keys() = daftar nama sesi sesuai urutan masuk; .next().value = yang paling depan.
      const oldest = nextSeq.keys().next().value;
      if (oldest !== undefined) nextSeq.delete(oldest);
    }
  };

  // Ini fungsi yang akan dipanggil server untuk SETIAP hook masuk.
  //   input   = kiriman mentah dari Claude Code
  //   context = bekal dari daemon: { logger (pencatat), machineId (identitas laptop) }
  return (input, context) => {
    const { logger } = context; // ambil pencatat dari bekal

    // try/catch = "coba kerjakan; kalau ada yang meledak, tangkap, jangan biarkan menjalar".
    // Kegagalan apa pun di sini tidak boleh sampai ke agent. Server sudah menjawab {} bila
    // penangan melempar error, tetapi menangkapnya di sini membuat catatannya lebih jelas.
    try {
      // MINTA PENERJEMAH bekerja. Parameter kedua adalah "callback" yang dipanggil penerjemah
      // hanya bila butuh stempel. Isinya: laptop ini, id baru, nomor urut sesi, jam sekarang.
      //
      // Membaca nomor urut TANPA menaikkannya. Dinaikkan di bawah (remember), hanya bila
      // hasilnya benar-benar event, supaya data yang ditolak tidak meninggalkan celah.
      const result = mapClaudeCodeHook(input, (sessionId): Stamp => ({
        machineId: context.machineId,
        id: newId(),
        seq: nextSeq.get(sessionId) ?? 0, // sesi baru belum ada di buku -> mulai dari 0
        ts: now().toISOString(), // jam dalam format ISO 8601
      }));

      // Bertindak sesuai HASIL terjemahan. "switch" memilih satu cabang berdasarkan `status`.
      switch (result.status) {
        // Terjemahan berhasil menjadi event baku -> kirim ke kotak surat.
        case "event": {
          const event = result.event;
          // Nomor urut sesi dinaikkan SEKARANG, karena sudah pasti ada event yang dikirim.
          remember(event.sessionId, event.seq + 1);

          // Pengiriman dijadwalkan lalu DITINGGALKAN: lambat atau gagalnya penerima tidak
          // boleh menunda jawaban ke agent. Kegagalannya hanya dicatat.
          //
          // Cara bacanya:
          //   Promise.resolve()  = janji yang langsung selesai (sekadar "pintu masuk" antrean).
          //   .then(...)         = "setelah itu, jalankan ini". Tugas ini baru berjalan SETELAH
          //                        fungsi utama selesai (di antrean tugas mikro), sehingga
          //                        jawaban ke agent tidak menunggunya. Bila emit melempar
          //                        error, error itu ikut tertangkap oleh .catch di bawah.
          //   .catch(...)        = bila ada yang gagal, hanya catat ke log.
          //   void               = pernyataan sengaja: "janji ini tidak ditunggu".
          void Promise.resolve()
            .then(() => options.emit(event, context))
            .catch((error: unknown) => {
              // "error instanceof Error" memeriksa apakah ini objek error biasa yang punya
              // .message; kalau bukan, ubah apa pun itu menjadi teks.
              logger.error(`gagal mengirim event ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
            });
          break; // keluar dari switch, jangan lanjut ke cabang berikutnya
        }
        // Sesi selesai -> (1) lupakan nomor antrean sesi itu supaya ingatan tidak menumpuk;
        // (2) batalkan izin yang masih menunggu dari sesi itu, karena agent-nya sudah tidak
        // ada untuk menerima jawaban. Hook yang menunggu izin itu langsung dijawab.
        case "session_ended": {
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
        // Permintaan izin -> belum ada yang menanganinya (approval engine dibuat di issue
        // berikutnya). Dicatat supaya jelas dari log bahwa permintaan izin memang sampai.
        // Hanya nama alat yang dicatat.
        case "permission_request":
          logger.info(`permintaan izin diterima: alat=${result.request.toolName} (belum ditangani)`);
          break;
        // Sengaja tidak dipakai (UserPromptSubmit). Tidak perlu apa-apa.
        case "ignored":
          break;
      }
    } catch (error) {
      // Jaring pengaman terakhir: kesalahan tak terduga di langkah mana pun hanya dicatat.
      logger.error(`pemetaan hook gagal: ${error instanceof Error ? error.message : String(error)}`);
    }

    // SELALU `undefined` = "tidak ada keputusan". Bagi server, ini berarti menjawab `{}`
    // ke Claude Code, dan Claude Code melanjutkan alur izin normalnya (bertanya di
    // terminal bila perlu). Inilah wujud aturan emas anti-macet.
    return undefined;
  };
}
