// Pembantu KHUSUS TEST: lingkungan push tiruan (izin, service worker, langganan, relay) yang bisa diatur per tes.
import { vi } from "vitest";
import type { Platform } from "../pairing/platform";
import { fakeRelay, FAKE_VAPID_PUBLIC_KEY } from "../relay/fake-relay";
import { decodeServerKey, type PushEnv, type RegistrationLike, type SubscriptionLike } from "./subscribe";

export const ANDROID: Platform = { isIos: false, isAndroid: true, isStandalone: false };
export const IOS_TAB: Platform = { isIos: true, isAndroid: false, isStandalone: false };
export const IOS_APP: Platform = { isIos: true, isAndroid: false, isStandalone: true };

export const P256DH = `B${"A".repeat(86)}`;
export const AUTH = "A".repeat(22);

export type PushSetupOptions = {
  platform?: Platform;
  permission?: NotificationPermission;
  /** Jawaban requestPermission. */
  asks?: NotificationPermission;
  existing?: boolean | "other-key";
  noPushManager?: boolean;
  noNotification?: boolean;
  noRegistration?: boolean;
  intent?: boolean;
  subscribeFails?: boolean;
  unsubscribeFails?: boolean;
  badSubscription?: boolean;
};

export function setupPush(options: PushSetupOptions = {}) {
  const relay = fakeRelay();
  const log: string[] = [];
  let intent = options.intent ?? false;
  const keyBytes = (key: string) => decodeServerKey(key).buffer as ArrayBuffer;

  let current: SubscriptionLike | null = options.existing
    ? makeSubscription(options.existing === "other-key" ? keyBytes(`B${"B".repeat(86)}`) : keyBytes(FAKE_VAPID_PUBLIC_KEY))
    : null;

  function makeSubscription(applicationServerKey: ArrayBuffer): SubscriptionLike {
    const subscription: SubscriptionLike = {
      toJSON: () => (options.badSubscription ? { endpoint: "https://fcm.googleapis.com/fcm/send/x" } : { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256DH, auth: AUTH } }),
      unsubscribe: vi.fn(async () => {
        log.push("browser:unsubscribe");
        if (options.unsubscribeFails) throw new Error("gagal");
        if (current === subscription) current = null;
        return true;
      }),
      options: { applicationServerKey },
    };
    return subscription;
  }

  const registration: RegistrationLike = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async (o) => {
        log.push("browser:subscribe");
        if (options.subscribeFails) throw new Error("ditolak browser");
        current = makeSubscription(o.applicationServerKey.buffer);
        return current;
      }),
    },
  };

  // Mencatat urutan panggilan ke relay dan izin, untuk membuktikan izin diminta lebih dulu.
  const api = {
    pushConfig: vi.fn(async () => {
      log.push("relay:config");
      return relay.api.pushConfig();
    }),
    savePushSubscription: vi.fn(async (s: Parameters<typeof relay.api.savePushSubscription>[0]) => {
      log.push("relay:save");
      return relay.api.savePushSubscription(s);
    }),
    pushPreferences: vi.fn(async () => relay.api.pushPreferences()),
    savePushPreferences: vi.fn(async (update: Parameters<typeof relay.api.savePushPreferences>[0]) => relay.api.savePushPreferences(update)),
    removePushSubscription: vi.fn(async () => {
      log.push("relay:remove");
      return relay.api.removePushSubscription();
    }),
  };

  let permission: NotificationPermission = options.permission ?? "default";
  const requestPermission = vi.fn(async () => {
    log.push("permission:ask");
    permission = options.asks ?? "granted";
    return permission;
  });

  const env: PushEnv = {
    platform: options.platform ?? ANDROID,
    notification: options.noNotification
      ? undefined
      : {
          get permission() {
            return permission;
          },
          requestPermission,
        },
    hasPushManager: !options.noPushManager,
    getRegistration: options.noRegistration ? async () => undefined : async () => registration,
    intent: { get: () => intent, set: (on) => void (intent = on) },
    api,
  };
  return { env, relay, api, log, registration, requestPermission, getIntent: () => intent, current: () => current };
}
