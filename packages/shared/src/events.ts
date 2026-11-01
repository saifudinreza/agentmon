// FILE INI: kontrak pesan utama. Menentukan bentuk "amplop" dan "isi surat" untuk
// SEMUA pesan yang berpindah antar bagian AgentMon.
//
// Alurnya:
//   hook/daemon di laptop --(pesan)--> relay server --(pesan)--> aplikasi HP
// Ketiganya memakai file ini, jadi mereka selalu "berbahasa sama". Kalau bentuk
// pesan berubah, cukup ubah di sini, lalu typecheck memberi tahu bagian mana yang
// harus menyesuaikan.
//
// Dipakai oleh: parse.ts (memvalidasi pesan masuk) dan, nanti, bridge/server/web.

// Meminjam Zod (lihat approval.ts). z = kotak perkakas validasi.
import { z } from "zod";
// Mengambil aturan dari file tetangga supaya tidak menulis ulang. Satu aturan, satu
// tempat. "./approval" artinya "file approval di folder yang sama".
import {
  AutoApprovalStatusSchema,
  FinalApprovalStatusSchema,
  HunkDecisionSchema,
  requireMixedHunks,
} from "./approval";
import { PolicyResultSchema, RiskSchema } from "./risk";

// Nomor "edisi formulir". Kalau nanti bentuk pesan berubah drastis, naikkan angkanya,
// sehingga pihak yang masih memakai edisi lama bisa mengenalinya dan menolak dengan sopan.
export const CONTRACT_VERSION = 1;

// Potongan aturan kecil yang dipakai berulang. Tidak di-export karena hanya untuk
// file ini (file lain cukup memakai aturan jadi di bawah).
const nonEmpty = z.string().min(1); // teks, tidak boleh kosong
// z.iso.datetime = tanggal-jam format ISO 8601, misalnya "2026-11-01T10:00:00Z".
// { offset: true } = juga menerima zona waktu seperti "+07:00".
const isoDate = z.iso.datetime({ offset: true });
// z.record(kunci, nilai) = "kamus": kumpulan pasangan nama dan nilai, misalnya
// { file_path: "a.ts", command: "npm test" }. z.unknown() = nilainya apa saja,
// karena tiap alat agent punya input berbeda-beda.
const toolInput = z.record(z.string(), z.unknown());

// Agent yang didukung. Pilihan ganda: hanya dua nilai ini yang sah.
export const AgentSchema = z.enum(["claude-code", "codex"]);
export type Agent = z.infer<typeof AgentSchema>;

// Kolom AMPLOP yang selalu ada di setiap pesan, apa pun jenis suratnya.
// Dipisah jadi satu objek supaya bisa dipakai di dua tempat (lihat EnvelopeSchema
// dan event() di bawah) tanpa menulis dua kali.
const envelopeFields = {
  // z.literal(1) = harus PERSIS angka 1. Kalau 2, ditolak.
  v: z.literal(CONTRACT_VERSION),
  // z.uuid() = harus berbentuk UUID (kode unik panjang). Dipakai agar pesan yang
  // sama tidak diproses dua kali (deduplikasi).
  id: z.uuid(),
  machineId: nonEmpty, // laptop mana yang mengirim
  sessionId: nonEmpty, // sesi kerja agent yang mana
  // z.int() = bilangan bulat. .nonnegative() = tidak boleh negatif (0 boleh).
  // seq = nomor urut pesan dalam satu sesi, untuk menyusun ulang bila ada yang telat.
  seq: z.int().nonnegative(),
  ts: isoDate, // cap waktu
  agent: AgentSchema,
};

// Bentuk payload (ISI SURAT) tiap jenis event. Ini versi awal: bentuk persisnya
// disesuaikan setelah data hook asli terlihat (lihat issue riset hook).
//
// Ini sebuah "peta": nama jenis event -> aturan isinya. Satu tempat menjadi sumber
// dua hal sekaligus: daftar nama event (EVENT_TYPES) dan aturan isinya.
export const eventPayloads = {
  // Sesi agent dimulai. cwd = folder kerja ("current working directory").
  "session.started": z.object({
    cwd: nonEmpty,
    permissionMode: z.string().optional(),
  }),
  // Agent mau memakai sebuah alat (misalnya Edit). toolInput berisi bahan kerjanya.
  "tool.requested": z.object({
    toolName: nonEmpty,
    toolInput,
    toolUseId: z.string().optional(),
  }),
  // Alat selesai dipakai. ok = berhasil atau tidak (z.boolean() = true/false saja).
  "tool.completed": z.object({
    toolName: nonEmpty,
    toolUseId: z.string().optional(),
    ok: z.boolean(),
  }),
  // Laptop meminta izin ke HP. Ini surat yang membuat HP berbunyi.
  "approval.requested": z.object({
    approvalId: nonEmpty,
    toolName: nonEmpty,
    toolInput,
    // Opsional dulu karena penilai risiko baru hadir di tahap berikutnya.
    risk: RiskSchema.optional(),
    summary: z.string().optional(), // ringkasan satu aksi untuk dibaca cepat
    expiresAt: isoDate, // batas waktu menjawab
  }),
  // Izin sudah diputuskan (oleh kamu, atau waktu habis, atau dibatalkan).
  "approval.resolved": z
    .object({
      approvalId: nonEmpty,
      status: FinalApprovalStatusSchema, // hanya status akhir yang sah
      comment: z.string().optional(),
      hunks: z.array(HunkDecisionSchema).optional(),
    })
    // Catatan ini disimpan sebagai riwayat dan dibaca untuk rekap dan audit. Status
    // "partially_approved" tanpa rincian hunk berarti catatannya tidak lengkap (tidak
    // ketahuan bagian mana yang diterima). Aturannya sama dengan formulir keputusan
    // dari HP (lihat approval.ts), jadi riwayat tidak bisa lebih longgar dari aslinya.
    .superRefine((value, ctx) => {
      if (value.status !== "partially_approved") return;
      requireMixedHunks(value.hunks, ctx, "status 'partially_approved'");
    }),
  // Izin diputuskan OTOMATIS oleh policy. Dicatat supaya kamu bisa mengauditnya.
  "approval.auto_resolved": z.object({
    approvalId: nonEmpty,
    toolName: nonEmpty,
    status: AutoApprovalStatusSchema,
    policy: PolicyResultSchema, // aturan mana yang memutuskan
    risk: RiskSchema.optional(),
  }),
  // Pesan dari agent, misalnya "Claude butuh perhatianmu".
  "agent.notification": z.object({
    message: nonEmpty,
    title: z.string().optional(),
  }),
  // Agent selesai bekerja untuk satu giliran.
  "agent.stopped": z.object({
    lastMessage: z.string().optional(),
  }),
  // Permintaan review per giliran (tinjauan gabungan setelah agent selesai).
  "turn.review_requested": z.object({
    turnId: nonEmpty,
    files: z.array(nonEmpty), // daftar file yang berubah
  }),
  // Titik simpan (checkpoint) dibuat sebelum agent mengubah file.
  "checkpoint.created": z.object({
    checkpointId: nonEmpty,
    approvalId: z.string().optional(),
  }),
  // Rollback dilakukan: kondisi dikembalikan ke sebuah checkpoint.
  "checkpoint.restored": z.object({
    checkpointId: nonEmpty,
    // Checkpoint keadaan sebelum rollback, supaya rollback bisa dibatalkan.
    safetyCheckpointId: z.string().optional(),
  }),
  // Rekap saat sesi selesai: apa saja yang terjadi.
  "session.recap": z.object({
    durationMs: z.int().nonnegative(), // lama sesi dalam milidetik
    filesChanged: z.array(nonEmpty),
    rejected: z.int().nonnegative(), // jumlah yang ditolak
    autoApproved: z.int().nonnegative(), // jumlah yang disetujui otomatis
  }),
  // "as const" = kunci-kuncinya dikunci sebagai nilai pasti, bukan sekadar "teks".
  // Tanpa ini, TypeScript hanya tahu kuncinya string biasa, sehingga tidak bisa
  // membedakan "session.started" dari kesalahan ketik.
} as const;

// "keyof typeof eventPayloads" dibaca dari kanan ke kiri:
//   typeof eventPayloads = "bentuk objek di atas"
//   keyof ...            = "semua nama kuncinya"
// Hasilnya: EventType = "session.started" | "tool.requested" | ... (12 nama).
// Menambah event baru di peta di atas OTOMATIS menambah tipe ini. Tidak perlu
// menulis daftarnya di dua tempat.
export type EventType = keyof typeof eventPayloads;
// Object.keys(...) = ambil daftar nama kuncinya sebagai array. "as EventType[]"
// meyakinkan TypeScript bahwa daftar ini isinya pasti nama event yang sah.
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];

// Amplop longgar: hanya memastikan bentuk umum, tanpa memeriksa type dan payload.
// Dipakai untuk mengenali event dari versi yang lebih baru tanpa gagal.
//
// Analogi: petugas pos memeriksa amplopnya dulu (alamat, cap, nomor resi) TANPA
// membuka suratnya. Kalau amplop benar tapi jenis suratnya asing, surat itu tidak
// dibuang, hanya dicatat. Itu sebabnya "type" di sini hanya "teks apa saja" dan
// payload-nya "apa saja" (z.unknown()).
//
// "...envelopeFields" (spread) = salin semua kolom dari objek itu ke sini.
export const EnvelopeSchema = z.object({
  ...envelopeFields,
  type: nonEmpty,
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

// Pabrik kecil: membuat aturan untuk SATU jenis event lengkap (amplop + isi).
// "<T extends EventType>" = "T adalah salah satu nama event yang sah". Ini GENERIC:
// ibarat cetakan dengan lubang yang diisi nama event yang kita masukkan, sehingga
// TypeScript tahu persis payload mana yang cocok dengan type yang mana.
// Contoh: event("tool.completed") menghasilkan aturan di mana payload-nya WAJIB
// berbentuk seperti "tool.completed", bukan bentuk event lain.
const event = <T extends EventType>(type: T) =>
  z.object({
    ...envelopeFields,
    type: z.literal(type), // harus PERSIS nama event ini
    payload: eventPayloads[type], // isinya mengikuti peta di atas
  });

// Gabungan 12 aturan di atas. z.discriminatedUnion("type", [...]) bekerja seperti
// resepsionis: ia melihat kolom "type" dulu, lalu langsung mengarahkan ke aturan
// yang cocok, tidak mencoba satu per satu. Hasilnya lebih cepat, dan pesan error
// hanya menyebut aturan yang relevan (bukan 12 aturan sekaligus).
//
// Catatan: daftarnya ditulis manual. Test di parse.test.ts memastikan semua jenis
// di EVENT_TYPES benar-benar diterima, jadi kalau ada yang terlewat di sini,
// test gagal dan ketahuan.
export const EventSchema = z.discriminatedUnion("type", [
  event("session.started"),
  event("tool.requested"),
  event("tool.completed"),
  event("approval.requested"),
  event("approval.resolved"),
  event("approval.auto_resolved"),
  event("agent.notification"),
  event("agent.stopped"),
  event("turn.review_requested"),
  event("checkpoint.created"),
  event("checkpoint.restored"),
  event("session.recap"),
]);
// Tipe hasilnya: gabungan semua bentuk event yang sah. Kode di bagian lain bisa
// memeriksa event.type, lalu TypeScript otomatis tahu isi payload-nya.
export type AgentMonEvent = z.infer<typeof EventSchema>;
