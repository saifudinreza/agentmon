// =====================================================================================
// FILE INI: mengenali perangkat untuk panduan pemasangan = "PETUGAS YANG MEMERIKSA HP" (FR-54).
// =====================================================================================
//
// Yang dikenali: sistem (iOS, Android, komputer), browser, versi iOS, apakah app sudah dipasang (dibuka dari ikon layar
// utama), dan apakah browser punya service worker, push, dan notifikasi. Tebakan dari userAgent bisa meleset, jadi hasilnya
// hanya dipakai untuk MEMILIH PETUNJUK. Kemampuan browser diperiksa langsung, bukan ditebak.
import { detectPlatform, type NavigatorLike } from "../pairing/platform";

export type Os = "ios" | "android" | "desktop";
export type Browser = "chrome" | "safari" | "firefox" | "edge" | "samsung" | "opera" | "inapp" | "other";

export type Support = { serviceWorker: boolean; pushManager: boolean; notification: boolean };

export type DeviceEnvironment = {
  os: Os;
  browser: Browser;
  /** Hanya iOS. Tidak diketahui (mis. iPad dengan tampilan situs desktop) = undefined. */
  iosVersion?: { major: number; minor: number };
  /** Dibuka dari ikon layar utama (bukan tab browser). */
  installed: boolean;
  support: Support;
};

export type EnvironmentInput = NavigatorLike & { displayModeStandalone?: boolean; support: Support };

// Browser di dalam aplikasi lain (pesan, media sosial): tidak bisa memasang app dan tidak bisa menerima push.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|MicroMessenger|TikTok|BytedanceWebview|Twitter|LinkedInApp|; wv\)/i;

function detectBrowser(ua: string, os: Os): Browser {
  if (IN_APP.test(ua)) return "inapp";
  if (/SamsungBrowser/i.test(ua)) return "samsung";
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return "edge";
  if (/OPiOS|OPR\/|Opera/.test(ua)) return "opera";
  if (/FxiOS|Firefox/.test(ua)) return "firefox";
  if (/CriOS|Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && (os === "ios" || /Version\//.test(ua))) return "safari";
  return "other";
}

function detectIosVersion(ua: string): { major: number; minor: number } | undefined {
  // iPhone/iPad: "CPU iPhone OS 17_4" atau "CPU OS 17_4". iPad bertampilan desktop hanya punya "Version/17.4".
  const found = /OS (\d+)_(\d+)/.exec(ua) ?? /Version\/(\d+)\.(\d+)/.exec(ua);
  return found ? { major: Number(found[1]), minor: Number(found[2]) } : undefined;
}

export function detectEnvironment(input: EnvironmentInput): DeviceEnvironment {
  const platform = detectPlatform(input, input.displayModeStandalone ?? false);
  const os: Os = platform.isIos ? "ios" : platform.isAndroid ? "android" : "desktop";
  const iosVersion = os === "ios" ? detectIosVersion(input.userAgent) : undefined;
  return { os, browser: detectBrowser(input.userAgent, os), ...(iosVersion ? { iosVersion } : {}), installed: platform.isStandalone, support: input.support };
}

/** Lingkungan browser yang sedang berjalan. */
export function currentEnvironment(): DeviceEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  let displayMode = false;
  try {
    displayMode = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    // matchMedia tidak ada: anggap bukan app terpasang
  }
  return detectEnvironment({
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    ...(nav.standalone !== undefined ? { standalone: nav.standalone } : {}),
    displayModeStandalone: displayMode,
    support: { serviceWorker: "serviceWorker" in navigator, pushManager: "PushManager" in window, notification: "Notification" in window },
  });
}
