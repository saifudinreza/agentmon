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

// Meniru jenis perangkat (iPhone, Android, ...). Mengembalikan fungsi untuk memulihkannya.
export function stubPlatform(options: { userAgent: string; platform?: string; maxTouchPoints?: number; standalone?: boolean; displayModeStandalone?: boolean }) {
  const define = (name: string, value: unknown) => Object.defineProperty(navigator, name, { configurable: true, value });
  define("userAgent", options.userAgent);
  define("platform", options.platform ?? "");
  define("maxTouchPoints", options.maxTouchPoints ?? 0);
  if (options.standalone !== undefined) define("standalone", options.standalone);
  const realMatchMedia = window.matchMedia;
  if (options.displayModeStandalone) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: query.includes("display-mode: standalone") || (realMatchMedia ? realMatchMedia(query).matches : false), media: query, addEventListener() {}, removeEventListener() {} }),
    });
  }
  return () => {
    for (const name of ["userAgent", "platform", "maxTouchPoints", "standalone"]) delete (navigator as unknown as Record<string, unknown>)[name];
  };
}

export const USER_AGENTS = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
} as const;
