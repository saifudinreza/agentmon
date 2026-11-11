// =====================================================================================
// FILE INI: mengenali perangkat = "PETUGAS YANG MELIHAT JENIS HP" sebelum pairing.
// =====================================================================================
//
// Dibutuhkan karena iOS berperilaku berbeda dari Android untuk satu hal penting: penyimpanan.
//
//   ANDROID (Chrome): tab browser dan aplikasi yang dipasang ke layar utama berbagi penyimpanan
//   untuk situs yang sama. Pairing yang dibuat di tab tetap ada di aplikasi.
//
//   iOS (Safari): aplikasi yang ditambahkan ke layar utama punya penyimpanan TERPISAH dari Safari.
//   Pairing yang dibuat di tab Safari TIDAK ikut terbawa ke aplikasi di layar utama. Pengguna yang
//   memindai QR (yang selalu terbuka di Safari), lalu memasang ke layar utama, akan membuka aplikasi
//   yang kosong dan mengira pairing-nya hilang. Karena itu di iOS yang masih di tab Safari, pairing
//   ditunda sampai pengguna berada di aplikasi layar utama (lihat PairScreen.tsx).
export type Platform = {
  isIos: boolean;
  /** Berjalan sebagai aplikasi yang dipasang (layar utama), bukan sebagai tab browser. */
  isStandalone: boolean;
  isAndroid: boolean;
};

export type NavigatorLike = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Hanya ada di iOS: true bila dibuka dari ikon layar utama. */
  standalone?: boolean;
};

export function detectPlatform(nav: NavigatorLike, displayModeStandalone = false): Platform {
  const ua = nav.userAgent;
  // iPadOS 13 ke atas memakai userAgent Mac secara bawaan; bedanya, iPad punya layar sentuh.
  const isIpadAsMac = nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
  const isIos = /iPhone|iPad|iPod/.test(ua) || isIpadAsMac;
  const isAndroid = /Android/i.test(ua);
  return { isIos, isAndroid, isStandalone: nav.standalone === true || displayModeStandalone };
}

/** Platform dari browser yang sedang berjalan. */
export function currentPlatform(): Platform {
  const nav = navigator as Navigator & { standalone?: boolean };
  let displayMode = false;
  try {
    displayMode = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    // matchMedia tidak tersedia: anggap bukan aplikasi terpasang
  }
  return detectPlatform(
    {
      userAgent: nav.userAgent,
      platform: nav.platform,
      maxTouchPoints: nav.maxTouchPoints,
      ...(nav.standalone !== undefined ? { standalone: nav.standalone } : {}),
    },
    displayMode,
  );
}

/** Nama awal untuk perangkat ini di daftar laptop. Pengguna boleh menggantinya. */
export function defaultDeviceName(nav: NavigatorLike): string {
  const ua = nav.userAgent;
  if (/iPad/.test(ua) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  return "Perangkat ini";
}
