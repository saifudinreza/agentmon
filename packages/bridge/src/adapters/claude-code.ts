// =====================================================================================
// FILE INI: adapter Claude Code = "PENERJEMAH".
// =====================================================================================
//
// GAMBARAN BESAR (alur proyek, dari awal sampai file ini):
//
//   Claude Code            Daemon (server.ts)         Handler                Adapter (file ini)
//   -----------            ------------------         -------                ------------------
//   "Saya mau pakai   -->  menerima kiriman JSON -->  claude-code-handler -> mapClaudeCodeHook()
//    alat Edit"            lewat /hook, memeriksa      memanggil adapter     menerjemahkan ke
//   (hook "http")          token, lalu meneruskan                            bahasa baku AgentMon
//
// ANALOGI: bayangkan kantor pos internasional.
//   - Surat dari Claude Code ditulis dalam "bahasa Claude" (PreToolUse, tool_input, ...).
//   - Seluruh kantor AgentMon (relay, HP, timeline) hanya mengerti "bahasa baku" yang
//     aturannya ada di paket `shared` (events.ts).
//   - File ini adalah PENERJEMAH di loket depan. Ia membaca surat Claude, lalu menulis ulang
//     dalam bahasa baku. Nanti Codex punya penerjemah sendiri, tetapi seluruh kantor di
//     belakangnya tidak perlu diubah sama sekali.
//
// SIFAT PENTING FILE INI: ia FUNGSI MURNI. Artinya:
//   - tidak membaca/menulis berkas, tidak memakai jaringan, tidak menyimpan ingatan;
//   - input yang sama SELALU menghasilkan output yang sama.
// Kenapa dibuat begitu? Supaya mudah dites: cukup beri contoh surat (fixture), lihat
// hasil terjemahannya. Hal-hal yang berubah-ubah (nomor unik, nomor urut, jam) sengaja
// DIBERIKAN DARI LUAR lewat parameter `stampFor`, bukan dibuat di sini.

// ---- IMPORT (meminjam alat dari file lain) --------------------------------------------
//
// Dari paket `shared` (kantor pusat aturan bahasa baku):
//   CONTRACT_VERSION = nomor edisi formulir (sekarang 1), ikut ditulis di tiap amplop.
//   eventPayloads    = "peta" aturan ISI surat per jenis event (tool.requested, dst).
//   parseEvent       = petugas pos yang memeriksa surat LENGKAP (amplop + isi) sebelum
//                      dianggap sah. Tidak pernah melempar error.
//   AgentMonEvent    = TIPE (bentuk) event yang sah.
//   EventType        = TIPE nama-nama event yang sah ("tool.requested", dst).
//
// "type AgentMonEvent" di dalam kurung kurawal artinya: yang dipinjam hanya TIPE-nya
// (untuk pemeriksaan sebelum program jalan). Tipe dibuang saat program benar-benar berjalan,
// jadi tidak menambah beban.
import { CONTRACT_VERSION, eventPayloads, parseEvent, type AgentMonEvent, type EventType } from "@agentmon/shared";
// "import type" = meminjam tipe saja. HookInput = bentuk minimum kiriman hook yang diterima
// daemon (objek JSON yang punya hook_event_name). Didefinisikan di server.ts.
// "../server" artinya "file server di folder satu tingkat di atas".
import type { HookInput } from "../server";

// ---- TIPE: bentuk data yang dipakai file ini ------------------------------------------

// "Stempel pos" yang ditempel pada setiap event. Semuanya diberikan dari luar (handler),
// bukan dibuat di sini, supaya file ini tetap murni.
//   machineId = laptop mana yang mengirim.
//   id        = nomor unik surat (UUID), supaya surat yang sama tidak diproses dua kali.
//   seq       = nomor urut dalam satu sesi (0, 1, 2, ...), untuk menyusun ulang bila telat.
//   ts        = cap waktu pengiriman (teks format ISO 8601).
// "export type" = bentuk ini boleh dipakai file lain.
export type Stamp = {
  machineId: string;
  id: string;
  seq: number;
  ts: string;
};

// Permintaan izin dari event PermissionRequest, dalam bentuk NETRAL.
// Kenapa bukan event kontrak? Event `approval.requested` butuh nomor persetujuan dan batas
// waktu yang BARU dibuat oleh approval engine (issue 007). Adapter belum bisa membuatnya,
// jadi ia hanya menyerahkan bahan mentahnya.
//
// Tanda "?" setelah nama kolom (cwd?) = kolom ini BOLEH tidak ada.
// Record<string, unknown> = "kamus": pasangan nama dan nilai apa saja (isi input tiap
// alat berbeda-beda, misalnya Edit punya file_path, Bash punya command).
export type PermissionRequestInfo = {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  permissionMode?: string;
};

// HASIL terjemahan. Selalu tepat SALAH SATU dari enam bentuk di bawah, dan kolom `status`
// menjadi penandanya (disebut "discriminated union"; analogi: lampu sinyal yang memberi
// tahu bentuk mana yang sedang dipegang).
//
// Manfaatnya: TypeScript MEMAKSA pemanggil memeriksa `status` dulu sebelum membaca isinya,
// sehingga tidak ada kasus yang terlupa ditangani. Tanda "|" dibaca "atau".
export type ClaudeMapResult =
  // 1. Event baku yang siap dikirim, lengkap dengan amplopnya.
  | { status: "event"; event: AgentMonEvent }
  // 2. Agent meminta izin. Diteruskan ke approval engine, belum menjadi event.
  | { status: "permission_request"; request: PermissionRequestInfo }
  // 3. Sesi selesai. Kontrak tidak punya event "sesi berakhir" sendiri; rekap
  //    (`session.recap`) dihitung dari catatan sesi di issue lain, jadi di sini hanya penanda.
  | { status: "session_ended"; sessionId: string; reason: string }
  // 4. Event dikenal tetapi sengaja tidak dipakai (UserPromptSubmit berisi teks perintahmu,
  //    yang tidak perlu dan tidak boleh dikirim ke mana-mana).
  | { status: "ignored"; hookEvent: string }
  // 5. Nama event tidak dikenal (misalnya dari Claude Code versi baru). Dicatat, bukan error.
  | { status: "unknown"; hookEvent: string }
  // 6. Event dikenal, tetapi isinya tidak lengkap atau bentuknya salah.
  | { status: "invalid"; hookEvent: string; message: string };

// ---- ALAT BANTU KECIL -----------------------------------------------------------------

// Daftar nama event yang dikenali. "Set" = kumpulan nilai unik yang cepat dicari dengan
// .has(). Ditulis SEKALI di tingkat file (bukan di dalam fungsi) supaya tidak dibuat ulang
// setiap kali ada hook masuk. "ReadonlySet" = hanya boleh dibaca, tidak boleh diubah.
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "PermissionRequest",
  "SessionEnd",
]);

// Pemeriksa: "apakah nilai ini objek biasa (kamus)?". Data dari luar tidak bisa dipercaya,
// jadi bentuknya harus dicek dulu. Di JavaScript, daftar (array) dan null juga bertipe
// "object", maka keduanya dikecualikan secara eksplisit.
//
// "value is Record<...>" disebut TYPE GUARD: kalau fungsi ini mengembalikan true, TypeScript
// otomatis tahu bahwa setelah itu `value` adalah kamus, tanpa perlu memaksa tipe manual.
// "unknown" = "kita tidak tahu ini apa", jadi wajib diperiksa sebelum disentuh.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Mengambil teks yang TIDAK KOSONG, atau undefined bila bukan teks / kosong.
// Dipakai untuk membaca kolom dari data luar dengan aman (angka, null, "" semuanya ditolak).
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// Membuang kolom yang nilainya undefined, supaya payload bersih. Contoh:
//   { cwd: "C:/proyek", permissionMode: undefined }  ->  { cwd: "C:/proyek" }
//
// Cara bacanya:
//   Object.entries(fields)  = ubah objek jadi daftar pasangan [nama, nilai].
//   .filter(...)            = simpan hanya pasangan yang nilainya BUKAN undefined.
//                             "[, value]" = abaikan nama, ambil nilainya saja.
//   Object.fromEntries(...) = susun lagi daftar pasangan itu menjadi objek.
//
// "<T extends Record<...>>" disebut GENERIC: cetakan bertipe. Artinya "apa pun bentuk objek
// yang masuk, bentuk yang sama keluar". Dengan begitu pemanggil tidak kehilangan info tipe.
function compact<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

// Hasil buildEvent: bahan event yang sah (type + payload), ATAU laporan masalah.
// "payload" = ISI surat (di luar amplop).
type Built = { type: EventType; payload: Record<string, unknown> } | { problem: string };

// ---- LANGKAH 1: menyusun jenis dan isi event ------------------------------------------
//
// Menerjemahkan SATU input hook menjadi pasangan (jenis event baku, isi event baku).
// Hanya untuk hook yang memang menjadi event kontrak. Mengembalikan:
//   - { type, payload }   bila berhasil,
//   - { problem: "..." }  bila kolom wajib hilang,
//   - undefined           bila nama hook ini bukan milik fungsi ini.
//
// "switch" = percabangan berdasarkan nilai. Tiap "case" adalah satu kemungkinan nama hook.
function buildEvent(name: string, input: HookInput): Built | undefined {
  switch (name) {
    // Sesi dimulai. Catatan: Claude Code TIDAK mengirim event ini lewat hook "http"
    // (hanya lewat hook "command"), tetapi pemetaannya tetap disiapkan untuk fixture dan
    // untuk agent lain. Lihat docs/hooks-claude-code.md bagian 8a-2.
    case "SessionStart": {
      const cwd = text(input.cwd); // cwd = folder kerja
      if (!cwd) return { problem: "cwd kosong" };
      return { type: "session.started", payload: compact({ cwd, permissionMode: text(input.permission_mode) }) };
    }
    // Agent MAU memakai sebuah alat (belum dijalankan). Menjadi `tool.requested`.
    case "PreToolUse": {
      const toolName = text(input.tool_name);
      if (!toolName) return { problem: "tool_name kosong" };
      // Alat tanpa argumen bisa datang tanpa tool_input sama sekali: dianggap objek kosong.
      // Tapi bila ADA dan bukan objek (misalnya daftar atau teks), itu data rusak -> ditolak.
      const toolInput = input.tool_input === undefined ? {} : input.tool_input;
      if (!isRecord(toolInput)) return { problem: "tool_input bukan objek" };
      return { type: "tool.requested", payload: compact({ toolName, toolInput, toolUseId: text(input.tool_use_id) }) };
    }
    // Alat SUDAH selesai dipakai. Menjadi `tool.completed`.
    case "PostToolUse": {
      const toolName = text(input.tool_name);
      if (!toolName) return { problem: "tool_name kosong" };
      // PostToolUse hanya muncul bila alat berhasil dijalankan (kegagalan alat adalah event
      // lain yang belum kita pasang). Satu-satunya tanda gagal di sini adalah perintah
      // yang dihentikan di tengah jalan (`interrupted`).
      const response = isRecord(input.tool_response) ? input.tool_response : {};
      const ok = response.interrupted !== true;
      return { type: "tool.completed", payload: compact({ toolName, toolUseId: text(input.tool_use_id), ok }) };
    }
    // Pesan dari agent (misalnya "Claude butuh perhatianmu"). Menjadi `agent.notification`.
    // Bentuk aslinya belum pernah teramati; pemetaan ini berdasarkan dokumentasi.
    case "Notification": {
      const message = text(input.message);
      if (!message) return { problem: "message kosong" };
      return { type: "agent.notification", payload: compact({ message, title: text(input.title) }) };
    }
    // Agent selesai satu giliran. Menjadi `agent.stopped`. Pesan terakhir agent bersifat opsional.
    case "Stop":
      return { type: "agent.stopped", payload: compact({ lastMessage: text(input.last_assistant_message) }) };
    // Nama lain bukan urusan fungsi ini.
    default:
      return undefined;
  }
}

// ---- FUNGSI UTAMA: pintu masuk penerjemah ---------------------------------------------

/**
 * Memetakan satu input hook Claude Code.
 *
 * ALUR (berurutan, berhenti di langkah pertama yang cocok):
 *   1. UserPromptSubmit                -> "ignored"
 *   2. Nama event tidak dikenal        -> "unknown"
 *   3. session_id kosong               -> "invalid"
 *   4. SessionEnd                      -> "session_ended"
 *   5. PermissionRequest               -> "permission_request" (atau "invalid")
 *   6. Sisanya (Pre/PostToolUse, Stop, dst):
 *        a. susun jenis + isi             (buildEvent)
 *        b. periksa ISI dulu              (eventPayloads) - belum memakai nomor urut
 *        c. beri identitas                (stampFor)
 *        d. periksa SURAT LENGKAP         (parseEvent)
 *      lalu -> "event" (atau "invalid" bila ada yang ditolak)
 *
 * `stampFor` dipanggil HANYA bila hasilnya event, dan hanya setelah isinya terbukti sah.
 * Fungsi ini sendiri tidak menyimpan nomor urut: pemanggil menaikkan nomor urut sesi hanya
 * setelah menerima hasil "event". Dengan begitu data yang ditolak (termasuk penolakan
 * terakhir oleh `parseEvent`) tidak meninggalkan celah di nomor urut. Celah itu berbahaya
 * karena penerima akan mengira ada pesan yang hilang.
 *
 * Tidak pernah melempar error: data aneh dikembalikan sebagai "invalid".
 *
 * @param input    kiriman mentah dari Claude Code
 * @param stampFor fungsi yang memberi stempel (id, nomor urut, jam) untuk sebuah sesi
 *                 (fungsi sebagai parameter = "callback": ibarat loket yang berkata
 *                 "kalau butuh stempel, panggil petugas ini")
 */
export function mapClaudeCodeHook(input: HookInput, stampFor: (sessionId: string) => Stamp): ClaudeMapResult {
  const hookEvent = input.hook_event_name;

  // Langkah 1. Sengaja tidak dipakai: isinya teks perintah pengguna, dan tidak ada event
  // kontrak yang membutuhkannya (lihat hook-config.ts).
  if (hookEvent === "UserPromptSubmit") return { status: "ignored", hookEvent };

  // Langkah 2. Nama yang tidak ada di daftar tamu -> dicatat, tidak dianggap error. Misalnya
  // Claude Code versi baru menambah event baru; AgentMon lama tidak boleh rusak karenanya.
  if (!KNOWN_EVENTS.has(hookEvent)) return { status: "unknown", hookEvent };

  // Langkah 3. Setiap event harus punya sesi. Tanpa itu, event tidak bisa ditempatkan.
  const sessionId = text(input.session_id);
  if (!sessionId) return { status: "invalid", hookEvent, message: "session_id kosong" };

  // Langkah 4. Sesi selesai: hanya penanda. Alasan berakhirnya disimpan; bila tidak ada, "unknown".
  // "??" dibaca "kalau yang kiri kosong (undefined), pakai yang kanan".
  if (hookEvent === "SessionEnd") {
    return { status: "session_ended", sessionId, reason: text(input.reason) ?? "unknown" };
  }

  // Langkah 5. Permintaan izin -> bahan mentah untuk approval engine (bukan event).
  if (hookEvent === "PermissionRequest") {
    const toolName = text(input.tool_name);
    if (!toolName) return { status: "invalid", hookEvent, message: "tool_name kosong" };
    const toolInput = input.tool_input === undefined ? {} : input.tool_input;
    if (!isRecord(toolInput)) return { status: "invalid", hookEvent, message: "tool_input bukan objek" };
    return {
      status: "permission_request",
      request: compact({
        sessionId,
        toolName,
        toolInput,
        cwd: text(input.cwd),
        permissionMode: text(input.permission_mode),
      }),
    };
  }

  // Langkah 6a. Menyusun jenis dan isi event.
  const built = buildEvent(hookEvent, input);
  if (!built) return { status: "unknown", hookEvent };
  // Operator "in" memeriksa apakah objek punya kolom tertentu. Bila ada kolom "problem",
  // berarti buildEvent melaporkan masalah.
  if ("problem" in built) return { status: "invalid", hookEvent, message: built.problem };

  // Langkah 6b. Periksa ISI lebih dulu, SEBELUM memakai nomor urut. eventPayloads[...] memilih
  // aturan isi yang cocok untuk jenis event ini, .safeParse() memeriksanya tanpa melempar
  // error (hasilnya punya kolom .success).
  const payloadCheck = eventPayloads[built.type].safeParse(built.payload);
  if (!payloadCheck.success) {
    // Pesan sengaja tidak menyertakan isi data, hanya jenis eventnya (isi bisa rahasia).
    return { status: "invalid", hookEvent, message: `isi tidak sesuai kontrak untuk ${built.type}` };
  }

  // Langkah 6c. Isi sudah terbukti sah, baru minta stempel (id, nomor urut, jam).
  const stamp = stampFor(sessionId);

  // Langkah 6d. Rakit surat LENGKAP (amplop + isi) lalu periksa sekali lagi lewat pintu
  // validasi yang sama dengan yang dipakai bagian lain AgentMon. Hasilnya bertipe AgentMonEvent
  // yang pasti benar, jadi tidak perlu memaksa tipe dengan "as".
  const parsed = parseEvent({
    v: CONTRACT_VERSION, // nomor edisi formulir
    id: stamp.id,
    machineId: stamp.machineId,
    sessionId,
    seq: stamp.seq,
    ts: stamp.ts,
    agent: "claude-code", // penanda surat ini dari agent mana
    type: built.type,
    payload: built.payload,
  });
  if (parsed.status !== "ok") {
    return { status: "invalid", hookEvent, message: `event ditolak kontrak: ${parsed.status}` };
  }
  return { status: "event", event: parsed.event };
}
