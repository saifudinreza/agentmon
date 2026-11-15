// =====================================================================================
// FILE INI: bentuk data Web Push = "FORMULIR LANGGANAN" dan "ISI KARTU POS" notifikasi.
// =====================================================================================
//
// Web Push = cara relay membangunkan HP lewat layanan push milik browser (Google, Mozilla, Apple), walau
// aplikasinya sedang tertutup dan HP terkunci. Tiga bentuk data ada di sini:
//
//   1. Langganan (HP -> relay): "kirim notifikasi ke alamat ini, dienkripsi dengan kunci ini". Bentuknya sama
//      dengan `PushSubscription.toJSON()` di browser, jadi PWA tinggal meneruskannya.
//   2. Konfigurasi (relay -> HP): apakah push menyala dan kunci publik VAPID untuk berlangganan.
//   3. Isi push (relay -> layanan push -> HP): HANYA nomor.
//
// ISI PUSH SENGAJA MINIMAL (FR-34): tidak ada kode, perintah, nama berkas, atau teks dari agent. Isinya lewat
// layanan push pihak ketiga, jadi yang dikirim hanya "ada apa" dan "di mana" (jenis dan nomor). Teks notifikasi
// disusun di HP dari jenisnya, dan detail dibaca dari relay setelah notifikasi diketuk. Skema ketat: menambah
// kolom baru harus lewat perubahan di sini, bukan terselip begitu saja.
import { z } from "zod";

// Kunci publik VAPID = titik kurva P-256 tak terkompresi (65 byte) dalam base64url tanpa isian: 87 karakter.
export const VAPID_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;

// Kunci publik langganan (p256dh): sama bentuknya, 65 byte. Rahasia autentikasi (auth): 16 byte, 22 karakter.
const P256DH_PATTERN = VAPID_PUBLIC_KEY_PATTERN;
const AUTH_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// Batas panjang alamat langganan. Alamat FCM, Mozilla, dan Apple jauh di bawah ini.
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

// ---- HP mendaftarkan langganan ---------------------------------------------------------
export const PushSubscriptionRequestSchema = z.object({
  endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX_LENGTH),
  keys: z.object({
    p256dh: z.string().regex(P256DH_PATTERN),
    auth: z.string().regex(AUTH_SECRET_PATTERN),
  }),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequestSchema>;

// ---- Relay memberi tahu HP apakah push menyala -----------------------------------------
export const PushConfigResponseSchema = z.object({
  enabled: z.boolean(),
  // Ada hanya bila push menyala. Bukan rahasia, tetapi tetap hanya diberikan ke HP yang sudah terpasang.
  publicKey: z.string().regex(VAPID_PUBLIC_KEY_PATTERN).optional(),
});
export type PushConfigResponse = z.infer<typeof PushConfigResponseSchema>;

// ---- Isi notifikasi --------------------------------------------------------------------
export const PUSH_PAYLOAD_VERSION = 1;

export const PushPayloadSchema = z.strictObject({
  v: z.literal(PUSH_PAYLOAD_VERSION),
  // approval = ada keputusan yang ditunggu; done = agent selesai; test = uji kirim dari operator relay.
  kind: z.enum(["approval", "done", "test"]),
  machineId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200).optional(),
  // Nomor izin: hanya bila tepat satu permintaan menunggu, supaya ketukan membuka permintaan itu. Lebih dari satu: tidak ada.
  approvalId: z.string().min(1).max(200).optional(),
  // Berapa permintaan yang menunggu di sesi itu. Satu notifikasi per sesi yang diganti, bukan satu per permintaan.
  count: z.int().min(1).max(9999).optional(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

// ---- Pengaturan jenis notifikasi per HP (FR-33) -------------------------------------------
// Dua jenis yang bisa dimatikan sendiri-sendiri. Uji kirim dari operator relay (kind "test") tidak ikut diatur.
export const PushPreferencesSchema = z.object({
  approvals: z.boolean(), // ada izin yang menunggu keputusan
  done: z.boolean(), // agent selesai
});
export type PushPreferences = z.infer<typeof PushPreferencesSchema>;

export const PushPreferencesUpdateSchema = z
  .object({ approvals: z.boolean().optional(), done: z.boolean().optional() })
  .refine((update) => update.approvals !== undefined || update.done !== undefined, "Sebutkan setidaknya satu pengaturan");
export type PushPreferencesUpdate = z.infer<typeof PushPreferencesUpdateSchema>;
