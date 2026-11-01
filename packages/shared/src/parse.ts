// FILE INI: "petugas pos" yang memeriksa setiap pesan masuk. Ini PINTU MASUK
// validasi: semua bagian AgentMon sebaiknya memanggil parseEvent() sebelum
// memercayai data dari luar (hook, relay, atau HP).
//
// Alur kerjanya, berurutan:
//   1. Periksa amplopnya (bentuk umum). Gagal -> "invalid".
//   2. Amplop benar tapi jenis surat tidak dikenal -> "unknown_type" (dicatat, dilewati).
//   3. Jenis dikenal -> periksa isinya sesuai jenisnya. Gagal -> "invalid", lolos -> "ok".

// "import type" = meminjam HANYA tipenya (untuk pengecekan sebelum program jalan),
// bukan alat yang dijalankan. Hasilnya tidak ikut masuk ke program akhir, jadi lebih
// ringan. z.ZodError adalah tipe "laporan kesalahan" milik Zod.
import type { z } from "zod";
import {
  CONTRACT_VERSION,
  EnvelopeSchema,
  EVENT_TYPES,
  EventSchema,
  // "type AgentMonEvent" = import tipe saja, dicampur dengan import nilai di atas.
  type AgentMonEvent,
  type Envelope,
} from "./events";

// Alasan penolakan. Tipe "gabungan teks": hanya tiga nilai ini yang boleh dipakai.
// Gunanya, pemanggil bisa bereaksi berbeda (misalnya versi tidak cocok vs data rusak).
export type ParseFailureReason =
  | "malformed_envelope" // amplopnya cacat (id salah, tanggal ngawur, dst)
  | "unsupported_version" // edisi formulir tidak cocok
  | "invalid_payload"; // amplop benar, tapi isi suratnya salah

// Hasil pemeriksaan: tepat SALAH SATU dari tiga bentuk. Disebut "discriminated
// union": kolom "status" menjadi penanda bentuk mana yang sedang kita pegang.
// Dengan begini pemanggil tidak bisa lupa menangani kasus gagal, karena TypeScript
// memaksa memeriksa "status" dulu sebelum boleh membaca isinya.
export type ParseResult =
  | { status: "ok"; event: AgentMonEvent }
  // Amplop valid, tapi jenis event belum dikenal (misalnya dari versi lebih baru).
  // Pemanggil sebaiknya mencatat dan mengabaikannya, bukan crash.
  | { status: "unknown_type"; type: string; envelope: Envelope }
  | { status: "invalid"; reason: ParseFailureReason; message: string };

// Mengubah laporan kesalahan Zod menjadi satu kalimat yang bisa dibaca manusia.
// Contoh hasil: "payload.ok: Invalid input: expected boolean, received string".
// Cara bacanya, dari atas ke bawah:
//   .map(...)  = ubah SETIAP temuan menjadi satu teks. (issue) => {...} dijalankan
//                untuk tiap temuan, seperti memberi stempel pada setiap berkas.
//   .join("; ") = gabungkan semua teks itu jadi satu kalimat, dipisah titik koma.
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      // issue.path = lokasi kesalahan, misalnya ["payload", "ok"].
      // .map(String) memastikan semuanya teks, .join(".") merangkainya jadi
      // "payload.ok". Kalau kosong (kesalahan di tingkat paling atas) tulis "(root)".
      // "||" di sini berarti "kalau hasil kiri kosong, pakai yang kanan".
      const path = issue.path.map(String).join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

// Apakah nama jenis event ini ada di daftar yang kita kenal?
// EVENT_TYPES bertipe daftar nama event yang SAH, sedangkan "type" yang kita periksa
// adalah teks sembarang dari luar. "as readonly string[]" melonggarkan tipenya
// sementara agar .includes() mau menerima teks sembarang itu.
function isKnownEventType(type: string): boolean {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

// Mengambil nomor versi dari data mentah dengan aman. Parameternya bertipe "unknown"
// = "kita tidak tahu ini apa", jadi harus diperiksa dulu sebelum disentuh. Kalau
// langsung dibaca dan ternyata null atau teks, program bisa error.
function versionOf(input: unknown): unknown {
  return typeof input === "object" && input !== null
    ? (input as { v?: unknown }).v
    : undefined;
}

// Tidak pernah melempar error: semua masalah dikembalikan sebagai hasil.
//
// Kenapa penting: kalau sebuah pesan rusak membuat seluruh program berhenti, satu
// pesan buruk dari relay bisa mematikan daemon di laptopmu. Dengan mengembalikan
// "invalid", pemanggil cukup mencatat dan lanjut. Ini selaras dengan prinsip anti-
// macet di PRD: AgentMon tidak boleh menjadi alasan agent berhenti bekerja.
//
// Parameter "input: unknown" = menerima APA SAJA (data dari luar tidak bisa dipercaya).
export function parseEvent(input: unknown): ParseResult {
  // LANGKAH 1: periksa amplop saja. safeParse = "periksa tanpa melempar error";
  // hasilnya objek berisi success: true/false (beserta data atau error-nya).
  const base = EnvelopeSchema.safeParse(input);
  if (!base.success) {
    // Amplop gagal. Sebelum bilang "rusak", cek dulu apakah penyebabnya sekadar
    // edisi formulir yang berbeda. Itu kasus yang sah dan layak mendapat pesan sendiri.
    const v = versionOf(input);
    if (typeof v === "number" && v !== CONTRACT_VERSION) {
      return {
        status: "invalid",
        reason: "unsupported_version",
        message: `versi kontrak ${v} tidak didukung (yang didukung: ${CONTRACT_VERSION})`,
      };
    }
    return {
      status: "invalid",
      reason: "malformed_envelope",
      message: formatIssues(base.error),
    };
  }

  // LANGKAH 2: amplop benar. Apakah jenis suratnya kita kenal?
  // Kalau tidak, ini BUKAN kesalahan: mungkin pengirimnya lebih baru dari kita.
  // Kembalikan "unknown_type" agar pemanggil bisa mencatatnya lalu melewatinya.
  if (!isKnownEventType(base.data.type)) {
    return { status: "unknown_type", type: base.data.type, envelope: base.data };
  }

  // LANGKAH 3: jenis dikenal. Sekarang periksa isi suratnya sesuai jenisnya.
  const parsed = EventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: "invalid_payload",
      message: formatIssues(parsed.error),
    };
  }
  // Lolos semua pemeriksaan. parsed.data sudah bertipe AgentMonEvent yang pasti benar.
  return { status: "ok", event: parsed.data };
}
