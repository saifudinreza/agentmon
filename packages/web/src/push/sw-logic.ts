// =====================================================================================
// FILE INI: logika service worker untuk push = "PENJAGA PINTU" yang bangun saat notifikasi tiba atau diketuk.
// =====================================================================================
//
// Dipisah dari sw.ts supaya bisa diuji tanpa browser: semua yang disentuh (menampilkan notifikasi, daftar jendela,
// membuka jendela) masuk lewat antarmuka kecil di bawah, bukan lewat `self`.
import { describePush, isSafePath, localeFor, NAVIGATE_MESSAGE, type NotificationContent } from "./notification";

export type ShowNotification = (title: string, options: NotificationContent["options"]) => Promise<void>;

/**
 * Menampilkan notifikasi untuk sebuah push. SELALU menampilkan sesuatu, walau isinya rusak (lihat notification.ts).
 * Galat saat menampilkan dilempar ke pemanggil, supaya browser tahu tugasnya gagal.
 */
export async function handlePush(raw: string | undefined, language: string | undefined, show: ShowNotification): Promise<void> {
  const content = describePush(raw, localeFor(language));
  await show(content.title, content.options);
}

export type WindowClientLike = {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
};

export type ClientsLike = {
  matchAll(options: { type: "window"; includeUncontrolled: true }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
};

/**
 * Membuka layar tujuan notifikasi yang diketuk.
 *   - Aplikasi sedang terbuka: jendelanya difokuskan lalu diminta pindah layar (tanpa memuat ulang).
 *   - Aplikasi tertutup: jendela baru dibuka langsung di layar itu.
 * `data` berasal dari notifikasi yang kita buat sendiri, tetapi jalurnya tetap diperiksa; yang tidak aman jatuh ke beranda.
 */
export async function openNotificationTarget(clients: ClientsLike, data: unknown, origin: string): Promise<void> {
  const raw = typeof data === "object" && data !== null ? (data as { path?: unknown }).path : undefined;
  const path = isSafePath(raw) ? raw : "/";

  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => {
    try {
      return new URL(client.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (existing) {
    // focus() boleh ditolak (mis. tidak dalam gestur pengguna); pindah layar tetap dikirim.
    await existing.focus().catch(() => undefined);
    existing.postMessage({ type: NAVIGATE_MESSAGE, path });
    return;
  }
  await clients.openWindow(new URL(path, origin).href);
}
