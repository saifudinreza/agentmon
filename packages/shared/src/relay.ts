// =====================================================================================
// FILE INI: bentuk "bingkai" (frame) pesan di jalur antara klien dan relay.
// =====================================================================================
//
// Relay adalah perantara: laptop (daemon) dan HP (PWA) sama-sama menyambung ke relay lewat
// WebSocket, dan relay meneruskan pesan di antara keduanya. Setiap pesan yang lewat jalur itu
// dibungkus dalam sebuah "bingkai" JSON yang punya kolom `kind` (jenisnya).
//
// ANALOGI: relay adalah operator telepon. Sebelum tersambung, penelepon harus menyebut siapa
// dirinya dan kata sandinya (`hello`). Setelah itu ia boleh menitipkan pesan (`event` dari
// laptop, `command` dari HP). Operator hanya membaca ALAMAT di amplop untuk menentukan ke mana
// pesan diteruskan, dan tidak perlu membaca isinya. Itu sebabnya `payload` di sini tetap
// "apa saja": mulai tahap 4 isinya terenkripsi dan relay memang tidak boleh membukanya.
//
// Jalur kebalikan (relay ke klien) memakai bingkai terpisah, termasuk `error` yang memberi tahu
// kenapa sebuah pesan ditolak.
import { z } from "zod";
import { EnvelopeSchema } from "./events";

const nonEmpty = z.string().min(1);

// Dua peran penyambung. "machine" = laptop (daemon). "device" = HP (PWA).
export const RelayRoleSchema = z.enum(["machine", "device"]);
export type RelayRole = z.infer<typeof RelayRoleSchema>;

// Isi pesan perintah dari HP ke laptop. Relay tidak membacanya (nanti terenkripsi), jadi hanya
// disyaratkan berupa objek JSON.
const body = z.record(z.string(), z.unknown());

// ---- Dari klien ke relay ---------------------------------------------------------------

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  // Pesan PERTAMA setelah tersambung: menyebut peran dan kata sandi (token). Token tidak boleh
  // ada di alamat sambungan (akan masuk log), jadi dikirim di sini.
  z.object({ kind: z.literal("hello"), role: RelayRoleSchema, token: z.string().min(16).max(512) }),
  // Laptop menitipkan sebuah event untuk diteruskan ke semua HP yang dipasangkan dengannya.
  // `event` hanya diperiksa sebagai AMPLOP (EnvelopeSchema), bukan isinya.
  z.object({ kind: z.literal("event"), event: EnvelopeSchema }),
  // HP mengirim perintah (keputusan, rollback, dan seterusnya) ke satu laptop yang dipasangkan.
  z.object({ kind: z.literal("command"), machineId: nonEmpty, body }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Dari relay ke klien ---------------------------------------------------------------

// Alasan sebuah pesan ditolak. `code` untuk mesin, `message` untuk manusia.
export const RELAY_ERROR_CODES = [
  "invalid_json", // isinya bukan JSON
  "invalid_frame", // JSON-nya sah tetapi bukan bingkai yang dikenal
  "too_large", // melebihi batas ukuran
  "rate_limited", // terlalu banyak pesan dalam waktu singkat
  "unauthenticated", // mengirim pesan sebelum `hello`
  "unauthorized", // token salah
  "already_authenticated", // `hello` dikirim dua kali
  "forbidden", // tidak boleh: peran salah, atau tidak dipasangkan
  "target_offline", // tujuan sedang tidak tersambung
  "hello_timeout", // tidak mengirim `hello` tepat waktu
  "idle_timeout", // koneksi mati (tidak ada tanda hidup)
  "replaced", // digantikan koneksi baru dari pihak yang sama
] as const;
export const RelayErrorCodeSchema = z.enum(RELAY_ERROR_CODES);
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  // Jawaban `hello` yang berhasil. `id` = nomor laptop atau HP ini di mata relay.
  z.object({ kind: z.literal("welcome"), role: RelayRoleSchema, id: nonEmpty }),
  // Event dari laptop yang dipasangkan.
  z.object({ kind: z.literal("event"), event: EnvelopeSchema }),
  // Perintah dari HP yang dipasangkan. `deviceId` = HP yang mengirim.
  z.object({ kind: z.literal("command"), deviceId: nonEmpty, body }),
  z.object({ kind: z.literal("error"), code: RelayErrorCodeSchema, message: nonEmpty }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
