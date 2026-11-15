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
export async function handlePush(
  raw: string | undefined,
  language: string | undefined,
  show: ShowNotification,
  existing?: () => Promise<readonly ShownNotification[]>,
  now: number = Date.now(),
): Promise<void> {
  const content = describePush(raw, localeFor(language));
  // Notifikasi izin yang sudah lewat batas waktu izin tidak berguna lagi dan tidak hilang sendiri (TTL push tidak
  // menghapus yang sudah tampil), jadi ditutup setiap kali push berikutnya tiba. Kegagalan di sini tidak boleh
  // menghalangi notifikasi yang baru.
  if (existing) {
    try {
      for (const shown of await existing()) {
        if (shown.tag.startsWith("approval:") && shown.tag !== content.options.tag && now - shown.timestamp > STALE_APPROVAL_MS) shown.close();
      }
    } catch {
      // diabaikan
    }
  }
  await show(content.title, content.options);
}

/** Notifikasi yang sedang tampil (bentuk minimal dari Notification milik browser). */
export type ShownNotification = { tag: string; timestamp: number; close(): void };
/** Sama dengan batas waktu izin di relay (10 menit); setelah itu izin pasti sudah kedaluwarsa. */
export const STALE_APPROVAL_MS = 10 * 60 * 1000;

export type WindowClientLike = {
  url: string;
  /** "visible" bila jendela sedang terlihat; selain itu (tersembunyi, dibekukan, atau dibuang OS) tidak bisa diandalkan menerima pesan. */
  visibilityState?: string;
  focus(): Promise<unknown>;
  /** Memuat alamat di jendela itu. Ditolak bila jendelanya tidak dikendalikan service worker ini. */
  navigate?(url: string): Promise<unknown>;
  postMessage(message: unknown): void;
};

export type ClientsLike = {
  matchAll(options: { type: "window"; includeUncontrolled: true }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
};

/**
 * Membuka layar tujuan notifikasi yang diketuk.
 *   - Aplikasi sedang TERLIHAT: jendelanya difokuskan lalu diminta pindah layar lewat pesan (tanpa memuat ulang).
 *   - Aplikasi ada tetapi tidak terlihat (tersembunyi di latar, dibekukan, atau dibuang OS, yang sering di Android):
 *     halamannya mungkin tidak mendengarkan pesan, jadi alamat tujuan dimuat langsung di jendela itu. Bila itu ditolak
 *     (jendela tidak dikendalikan service worker ini), pesan dikirim sebagai cadangan.
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
    const visible = existing.visibilityState === "visible";
    // focus() boleh ditolak (mis. tidak dalam gestur pengguna); perpindahan layar tetap dilanjutkan.
    await existing.focus().catch(() => undefined);
    if (!visible && existing.navigate) {
      try {
        await existing.navigate(new URL(path, origin).href);
        return;
      } catch {
        // jendela tidak dikendalikan service worker ini: coba lewat pesan
      }
    }
    existing.postMessage({ type: NAVIGATE_MESSAGE, path });
    return;
  }
  await clients.openWindow(new URL(path, origin).href);
}
