// Pembantu KHUSUS TEST untuk komponen. Tidak dipakai kode aplikasi.

// jsdom (DOM tiruan) tidak punya window.matchMedia; ini menggantinya dan membiarkan test mengubah
// pengaturan "mode gelap HP" lalu memicu event perubahannya.
export function stubMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes("dark") ? dark : false;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    }),
  });
  return {
    setDark(next: boolean) {
      dark = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

// Mengatur navigator.onLine dan memicu eventnya, seperti saat jaringan HP putus atau kembali.
export function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}
