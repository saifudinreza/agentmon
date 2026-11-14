// Mendengarkan service worker: saat notifikasi diketuk dan aplikasi sudah terbuka, service worker memfokuskan
// jendelanya lalu mengirim pesan "pindah ke jalur ini". Aplikasi pindah layar tanpa memuat ulang.
import { useEffect } from "react";
import { navigate } from "../router";
import { parseNavigateMessage } from "./notification";

export function useNotificationNavigation(): void {
  useEffect(() => {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      // Jalur divalidasi di sini juga: pesan yang tidak sah atau bukan jalur internal diabaikan.
      const path = parseNavigateMessage(event.data);
      if (path) navigate(path);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, []);
}
