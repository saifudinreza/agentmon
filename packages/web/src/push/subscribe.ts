// =====================================================================================
// FILE INI: alur berlangganan notifikasi = "LOKET PENDAFTARAN" yang mengurus izin dan alamat kotak pos HP ini.
// =====================================================================================
//
// Tiga langkah yang harus benar urutannya:
//   1. IZIN: hanya diminta dari ketukan pengguna, dan langsung (sebelum menunggu apa pun) supaya tetap dihitung
//      sebagai gestur. Safari iOS menolak meminta izin tanpa gestur.
//   2. LANGGANAN: browser membuat alamat kotak pos (PushSubscription) yang terikat ke kunci VAPID relay.
//   3. DAFTAR KE RELAY: alamat itu dikirim ke relay, yang menyimpannya per HP.
//
// ATURAN KHUSUS:
//   - iOS hanya mengizinkan notifikasi untuk aplikasi di layar utama. Di tab Safari, izin TIDAK diminta sama sekali;
//     pengguna diberi panduan (FR-55).
//   - Izin yang sudah ditolak tidak bisa diminta lagi oleh aplikasi; yang bisa dilakukan hanya menjelaskan caranya.
//   - Kunci VAPID relay yang berganti membuat langganan lama tak berlaku. Bila pengguna pernah mengaktifkan, langganan
//     dibuat ulang diam-diam (izinnya sudah ada). Bila pengguna sudah mematikan, tidak ada yang dibuat ulang.
//   - Satu browser hanya bisa berlangganan ke satu kunci, jadi notifikasi hanya terhubung ke SATU relay per browser.
//
// Semua yang disentuh (Notification, service worker, penyimpanan niat) masuk lewat `PushEnv`, supaya bisa diuji.
import { PushSubscriptionRequestSchema, type PushSubscriptionRequest } from "@agentmon/shared";
import { currentPlatform, type Platform } from "../pairing/platform";
import type { RelayApi } from "../relay/api";

export type PushStatus =
  | { kind: "on" }
  | { kind: "off"; /** Berhenti berlangganan berhasil di HP tetapi relay belum menerima pembatalannya. */ relayPending?: boolean }
  | { kind: "needs-install" } // iOS di tab Safari
  | { kind: "unsupported" }
  | { kind: "no-sw" } // service worker belum aktif (mis. build pengembangan, atau baru dipasang)
  | { kind: "denied" }
  | { kind: "unavailable" } // relay belum menyalakan push
  | { kind: "error"; during: "check" | "enable" };

export type SubscriptionLike = {
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
  options?: { applicationServerKey?: ArrayBuffer | null };
};

export type RegistrationLike = {
  /** Ada hanya bila service worker sudah aktif; pushManager.subscribe menolak sebelum itu. */
  active?: unknown;
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>;
  };
};

export type PushEnv = {
  platform: Platform;
  notification: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | undefined;
  hasPushManager: boolean;
  /** Registrasi service worker yang AKTIF (menunggu sebentar bila baru dipasang), atau undefined bila tidak ada. */
  getRegistration: (() => Promise<RegistrationLike | undefined>) | undefined;
  /** Niat pengguna: true bila ia mengaktifkan notifikasi dan belum mematikannya. */
  intent: { get(): boolean; set(on: boolean): void };
  /** Alamat langganan yang sudah dikirim ke relay pada sesi ini; menghindari PUT berulang tiap kartu dibuka. Tanpa ini, selalu dikirim. */
  synced?: Set<string>;
  api: Pick<RelayApi, "pushConfig" | "savePushSubscription" | "removePushSubscription" | "pushPreferences" | "savePushPreferences">;
};

export const PUSH_INTENT_KEY = "agentmon.push";

// Alamat langganan yang sudah disamakan dengan relay sejak halaman ini dimuat (hilang saat dimuat ulang).
const sessionSynced = new Set<string>();

type ContainerLike = { getRegistration(): Promise<RegistrationLike | undefined>; ready: Promise<RegistrationLike> };

/**
 * Registrasi service worker yang sudah AKTIF. getRegistration() sudah mengembalikan registrasi selama service worker
 * masih dipasang, tetapi pushManager.subscribe() menolak (InvalidStateError) sebelum ia aktif. Itu terjadi persis pada
 * pemakaian pertama (mis. iOS yang baru menambahkan app ke layar utama dan langsung mengetuk Aktifkan), jadi ditunggu
 * dengan batas waktu; bila tidak kunjung aktif, undefined.
 */
export async function activeRegistration(container: ContainerLike, timeoutMs = 10_000): Promise<RegistrationLike | undefined> {
  const registration = await container.getRegistration();
  if (!registration) return undefined;
  if (registration.active) return registration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([container.ready.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lingkungan dari browser yang sedang berjalan. */
export function currentPushEnv(api: PushEnv["api"]): PushEnv {
  const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  return {
    platform: currentPlatform(),
    notification: typeof Notification === "undefined" ? undefined : Notification,
    hasPushManager: typeof window !== "undefined" && "PushManager" in window,
    getRegistration: sw ? () => activeRegistration(sw as unknown as ContainerLike) : undefined,
    intent: {
      get() {
        try {
          return window.localStorage.getItem(PUSH_INTENT_KEY) === "on";
        } catch {
          return false;
        }
      },
      set(on) {
        try {
          if (on) window.localStorage.setItem(PUSH_INTENT_KEY, "on");
          else window.localStorage.removeItem(PUSH_INTENT_KEY);
        } catch {
          // diabaikan: hanya mengingat niat
        }
      },
    },
    synced: sessionSynced,
    api,
  };
}

/** Kunci VAPID (base64url) menjadi byte yang diminta pushManager.subscribe. */
export function decodeServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const binary = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: SubscriptionLike, expected: Uint8Array): boolean {
  const actual = subscription.options?.applicationServerKey;
  if (!actual) return true; // browser tidak melaporkan kuncinya: tidak bisa dibuktikan berbeda
  const bytes = new Uint8Array(actual);
  return bytes.length === expected.length && bytes.every((byte, i) => byte === expected[i]);
}

// Bentuk yang diterima relay; menolak langganan yang tidak lengkap (browser aneh) sebelum dikirim.
function toRequest(subscription: SubscriptionLike): PushSubscriptionRequest {
  const json = subscription.toJSON();
  return PushSubscriptionRequestSchema.parse({ endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } });
}

type Blocked = Extract<PushStatus, { kind: "needs-install" | "unsupported" | "denied" }>;

// Hal yang menghalangi sebelum menyentuh jaringan, berurutan dari yang paling spesifik.
function blocker(env: PushEnv): Blocked | undefined {
  // iOS di tab Safari: objek Notification bahkan tidak ada, tetapi pesan yang berguna adalah cara memasangnya.
  if (env.platform.isIos && !env.platform.isStandalone) return { kind: "needs-install" };
  if (!env.notification || !env.hasPushManager || !env.getRegistration) return { kind: "unsupported" };
  if (env.notification.permission === "denied") return { kind: "denied" };
  return undefined;
}

/** Status notifikasi di HP ini. Bila izin sudah ada dan pengguna pernah mengaktifkan, langganan dipulihkan diam-diam. */
export async function checkPush(env: PushEnv): Promise<PushStatus> {
  const blocked = blocker(env);
  if (blocked) return blocked;
  const notification = env.notification!;
  const registration = await env.getRegistration!().catch(() => undefined);
  if (!registration) return { kind: "no-sw" };

  let config;
  try {
    config = await env.api.pushConfig();
  } catch {
    return { kind: "error", during: "check" };
  }
  if (!config.enabled || !config.publicKey) return { kind: "unavailable" };

  try {
    const key = decodeServerKey(config.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (notification.permission !== "granted") return { kind: "off" };
    // NIAT PENGGUNA adalah sumber kebenaran: yang belum atau sudah dimatikan tidak boleh menyala lagi diam-diam. Langganan
    // yang tertinggal (mis. unsubscribe gagal saat dimatikan) dibuang, bukan didaftarkan ulang ke relay.
    if (!env.intent.get()) {
      await subscription?.unsubscribe().catch(() => undefined);
      return { kind: "off" };
    }
    // Langganan hilang (browser membuangnya) atau terikat ke kunci relay yang lama: buat ulang. Izin dan niat sudah ada,
    // jadi tidak ada pertanyaan ke pengguna.
    if (!subscription || !sameKey(subscription, key)) {
      await subscription?.unsubscribe().catch(() => undefined);
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    // Menyamakan relay dengan keadaan HP (idempotent): memulihkan relay yang kehilangan langganan, mis. setelah pasang
    // ulang. Cukup sekali per sesi per alamat: tiap PUT menulis ke database relay dan memakai jatah laju HP.
    const request = toRequest(subscription);
    if (!env.synced?.has(request.endpoint)) {
      await env.api.savePushSubscription(request);
      env.synced?.add(request.endpoint);
    }
    return { kind: "on" };
  } catch {
    return { kind: "error", during: "check" };
  }
}

/**
 * Mengaktifkan notifikasi. HARUS dipanggil langsung dari ketukan pengguna: izin diminta sebelum menunggu apa pun.
 */
export async function enablePush(env: PushEnv): Promise<PushStatus> {
  const blocked = blocker(env);
  if (blocked) return blocked;
  const notification = env.notification!;

  // Pertama dan langsung, supaya gestur ketukan masih berlaku.
  const permission = notification.permission === "granted" ? "granted" : await notification.requestPermission();
  if (permission === "denied") return { kind: "denied" };
  if (permission !== "granted") return { kind: "off" }; // ditutup tanpa memilih: boleh diminta lagi nanti

  try {
    const registration = await env.getRegistration!().catch(() => undefined);
    if (!registration) return { kind: "no-sw" };
    const config = await env.api.pushConfig();
    if (!config.enabled || !config.publicKey) return { kind: "unavailable" };
    const key = decodeServerKey(config.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
      await subscription.unsubscribe().catch(() => undefined);
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const request = toRequest(subscription);
    await env.api.savePushSubscription(request);
    env.synced?.add(request.endpoint);
    env.intent.set(true);
    return { kind: "on" };
  } catch {
    return { kind: "error", during: "enable" };
  }
}

/** Mematikan notifikasi di HP ini. Berhenti berlangganan di browser dulu, supaya tidak ada lagi yang masuk. */
export async function disablePush(env: PushEnv): Promise<PushStatus> {
  env.intent.set(false);
  env.synced?.clear();
  try {
    const registration = await env.getRegistration?.();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Gagal berhenti berlangganan di browser tidak boleh menghalangi pembatalan di relay.
  }
  try {
    await env.api.removePushSubscription();
    return { kind: "off" };
  } catch {
    // Relay membersihkan sendiri langganan yang mati saat jawaban 404/410 berikutnya.
    return { kind: "off", relayPending: true };
  }
}
