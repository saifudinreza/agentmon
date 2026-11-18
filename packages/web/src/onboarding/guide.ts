// =====================================================================================
// FILE INI: menyusun langkah panduan dari keadaan perangkat = "PEMANDU" (FR-54, FR-55). Murni, tanpa tampilan.
// =====================================================================================
//
// Satu aturan yang tidak boleh dilanggar (FR-55): di iOS, izin notifikasi TIDAK ditawarkan sebelum app dibuka dari ikon
// layar utama. Langkah "notify" di iOS tab Safari berstatus "locked", dan tampilan tidak boleh memasang tombolnya.
import type { DeviceEnvironment } from "./environment";

export type StepId = "install" | "pair" | "notify" | "test";
export type StepState = "done" | "current" | "todo" | "locked";
export type Step = { id: StepId; state: StepState; /** Boleh dilewati (memasang app di Android). */ optional: boolean };

export type Blocker = "inapp" | "ios-too-old" | "no-push";
export type Note = "ios-browser" | "desktop";

export type Progress = {
  /** Sudah ada laptop yang dipasangkan di perangkat ini. */
  paired: boolean;
  /** Notifikasi sudah aktif di perangkat ini. */
  notifying: boolean;
  /** Notifikasi uji sudah terkirim. */
  tested: boolean;
};

export type Guide = {
  /** Penghalang yang membuat notifikasi tidak mungkin di perangkat ini; app tetap bisa dipakai tanpanya. */
  blocker?: Blocker;
  notes: Note[];
  steps: Step[];
  /** Langkah yang sedang dikerjakan; tidak ada bila semua selesai atau terhalang. */
  current?: StepId;
};

// Push web di iOS butuh 16.4. Versi yang tidak diketahui tidak dianggap terlalu lama (jangan menghalangi tanpa bukti).
const IOS_PUSH_MIN = { major: 16, minor: 4 };

function iosTooOld(env: DeviceEnvironment): boolean {
  const v = env.iosVersion;
  if (!v) return false;
  return v.major < IOS_PUSH_MIN.major || (v.major === IOS_PUSH_MIN.major && v.minor < IOS_PUSH_MIN.minor);
}

export function buildGuide(env: DeviceEnvironment, progress: Progress): Guide {
  const notes: Note[] = [];
  if (env.os === "ios" && env.browser !== "safari" && env.browser !== "inapp") notes.push("ios-browser");
  if (env.os === "desktop") notes.push("desktop");

  // iOS di tab Safari memang belum punya PushManager (baru ada di app layar utama), jadi ketiadaannya BUKAN penghalang di sana.
  const iosTab = env.os === "ios" && !env.installed;
  let blocker: Blocker | undefined;
  if (env.browser === "inapp") blocker = "inapp";
  else if (env.os === "ios" && iosTooOld(env)) blocker = "ios-too-old";
  else if (!iosTab && !(env.support.serviceWorker && env.support.pushManager && env.support.notification)) blocker = "no-push";

  // Notifikasi terkunci: terhalang, iOS belum dibuka dari layar utama, atau laptop belum dipasangkan.
  const notifyLocked = blocker !== undefined || iosTab || !progress.paired;
  const states: Record<StepId, StepState> = {
    install: env.installed ? "done" : "todo",
    pair: progress.paired ? "done" : "todo",
    notify: progress.notifying ? "done" : notifyLocked ? "locked" : "todo",
    test: progress.tested ? "done" : progress.notifying && blocker === undefined ? "todo" : "locked",
  };
  // Di iOS notifikasi hanya bisa dari app layar utama, jadi memasang adalah syarat; di Android hanya saran.
  const order: StepId[] = ["install", "pair", "notify", "test"];
  const steps: Step[] = order.map((id) => ({ id, state: states[id], optional: id === "install" && env.os !== "ios" }));
  // Terhalang: memasang tidak menolong notifikasi, jadi hanya pairing yang masih ditunjuk.
  const candidates = blocker ? steps.filter((s) => s.id === "pair") : steps;
  const current = candidates.find((s) => s.state === "todo" && !s.optional)?.id;
  return {
    ...(blocker ? { blocker } : {}),
    notes,
    steps: steps.map((s) => (s.id === current ? { ...s, state: "current" as const } : s)),
    ...(current ? { current } : {}),
  };
}
