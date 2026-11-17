// =====================================================================================
// FILE INI: isi notifikasi = "PENULIS KARTU" yang mengubah kiriman push menjadi notifikasi di layar HP.
// =====================================================================================
//
// Dipakai service worker (sw.ts) dan aplikasi, jadi TIDAK BOLEH menyentuh DOM, React, atau penyimpanan browser.
//
// ATURAN YANG DIJAGA:
//   - SETIAP push menghasilkan notifikasi yang terlihat. Isi yang rusak, kosong, atau dari versi lain tetap
//     menampilkan notifikasi umum. Di iOS dan Chrome, push yang tidak menampilkan apa pun membuat browser mencabut
//     izin atau menampilkan notifikasi "situs diperbarui di latar belakang" yang membingungkan (FR-32).
//   - TEKS DISUSUN DI HP dari jenis push; kiriman relay hanya berisi jenis dan nomor (shared/push.ts, FR-34).
//   - TUJUAN KETUKAN dibangun dari nomor yang sudah divalidasi menjadi jalur layar internal, tidak pernah dari
//     alamat yang dikirim relay. Jalurnya diperiksa lagi (isSafePath) sebelum dipakai.
import { PushPayloadSchema, type PushPayload } from "@agentmon/shared";
import { DEFAULT_LOCALE, translate, type Locale } from "../i18n/i18n";
import type { MessageKey } from "../i18n/id";

/** Jenis pesan dari service worker ke aplikasi yang terbuka: "pindah ke jalur ini". */
export const NAVIGATE_MESSAGE = "agentmon:navigate";
export const NOTIFICATION_ICON = "/icons/icon-192.png";

export type NotificationContent = {
  title: string;
  options: { body: string; tag: string; icon: string; data: { path: string } };
};

/**
 * Jalur layar di dalam aplikasi: diawali SATU garis miring, hanya karakter alamat yang aman. Menolak "//host"
 * (alamat protokol-relatif ke situs lain), backslash, titik dua, dan karakter kontrol.
 */
// Batas panjang: nomor sah bisa sampai 200 karakter dan di-encode hingga 12 kali lipat (UTF-8), jadi jalur yang sah
// bisa mencapai beberapa ribu karakter. Batas yang lebih kecil membuat ketukan jatuh ke beranda (ditemukan review PR #58).
export const MAX_PATH_LENGTH = 4096;

export function isSafePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= MAX_PATH_LENGTH && /^\/(?![/\\])[A-Za-z0-9\-._~%/]*$/.test(path);
}

/** Bahasa notifikasi mengikuti bahasa perangkat: service worker tidak bisa membaca pilihan bahasa di aplikasi. */
export function localeFor(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("en") ? "en" : DEFAULT_LOCALE;
}

/** Kiriman push yang sah, atau undefined (kosong, bukan JSON, atau tidak sesuai skema). */
export function parsePush(raw: string | undefined): PushPayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed = PushPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// encodeURIComponent membiarkan ! ' ( ) * apa adanya; di sini ikut di-encode supaya karakter jalurnya selalu lolos isSafePath
// (nomor yang memuat tanda itu tetap membuka layar yang tepat, bukan jatuh ke beranda). Aplikasi mendekode dengan benar.
const enc = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Layar yang dibuka saat notifikasi diketuk. Tanpa nomor yang cukup, beranda. */
export function pathFor(payload: PushPayload): string {
  // Lebih dari satu izin menunggu: tidak ada satu layar yang tepat, jadi beranda (yang memuat semua antrean izin).
  if (payload.kind === "approval" && payload.approvalId && (payload.count ?? 1) === 1) return `/a/${enc(payload.machineId)}/${enc(payload.approvalId)}`;
  if (payload.kind === "done" && payload.sessionId) return `/s/${enc(payload.machineId)}/${enc(payload.sessionId)}`;
  return "/";
}

/**
 * Tag notifikasi izin: SATU per sesi. Tag yang sama menggantikan notifikasi sebelumnya, jadi sepuluh permintaan di sesi yang
 * sama menjadi satu notifikasi yang diperbarui, bukan sepuluh yang menumpuk. Dipakai juga untuk membersihkan yang usang.
 */
export function approvalTag(machineId: string, sessionId: string | undefined): string {
  return `approval:${machineId}:${sessionId ?? ""}`;
}

function tagFor(payload: PushPayload): string {
  // Tag yang sama menggantikan notifikasi sebelumnya, jadi push berulang untuk hal yang sama tidak menumpuk.
  if (payload.kind === "approval") return approvalTag(payload.machineId, payload.sessionId ?? payload.approvalId);
  if (payload.kind === "done") return `done:${payload.machineId}:${payload.sessionId ?? ""}`;
  return "test";
}

/** Notifikasi untuk sebuah kiriman push. Selalu menghasilkan sesuatu yang bisa ditampilkan. */
export function describePush(raw: string | undefined, locale: Locale): NotificationContent {
  const payload = parsePush(raw);
  const kind = payload?.kind ?? "generic";
  // Beberapa izin menunggu di sesi itu: isinya jumlahnya (angka dari relay, divalidasi skema), bukan isi permintaannya.
  const many = payload?.kind === "approval" && (payload.count ?? 1) > 1;
  const body = many ? translate(locale, "push.notif.approval.many", { count: payload?.count ?? 0 }) : translate(locale, `push.notif.${kind}.body` as MessageKey);
  // Level risiko ditulis dengan kata di depan isi pesan (tidak mengandalkan warna). Hanya level, tidak pernah isi permintaan.
  const risk = payload?.kind === "approval" && payload.risk ? `${translate(locale, `approval.risk.${payload.risk}` as MessageKey)}. ` : "";
  return {
    title: translate(locale, `push.notif.${kind}.title` as MessageKey),
    options: {
      body: risk + body,
      tag: payload ? tagFor(payload) : "agentmon",
      icon: NOTIFICATION_ICON,
      data: { path: payload ? pathFor(payload) : "/" },
    },
  };
}

/** Isi pesan dari service worker yang minta aplikasi pindah layar, atau undefined bila bukan itu atau tidak aman. */
export function parseNavigateMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as { type?: unknown; path?: unknown };
  return message.type === NAVIGATE_MESSAGE && isSafePath(message.path) ? message.path : undefined;
}
