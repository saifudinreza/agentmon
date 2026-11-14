import { afterEach, describe, expect, test, vi } from "vitest";
import { FAKE_VAPID_PUBLIC_KEY } from "../relay/fake-relay";
import { activeRegistration, checkPush, currentPushEnv, decodeServerKey, disablePush, enablePush, type RegistrationLike } from "./subscribe";
import { AUTH, IOS_APP, IOS_TAB, P256DH, setupPush } from "./testing";

describe("decodeServerKey", () => {
  test("base64url menjadi byte yang tepat: 65 byte, diawali 0x04 (titik tak terkompresi)", () => {
    const bytes = decodeServerKey(FAKE_VAPID_PUBLIC_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect([...bytes.slice(1)].every((b) => b === 0)).toBe(true);
  });

  test("karakter - dan _ (base64url) diterjemahkan, dan tanpa isian '=' tetap terbaca", () => {
    // "-_" di base64url = "+/" di base64 biasa: 0xfb 0xff
    expect([...decodeServerKey("-_8")]).toEqual([0xfb, 0xff]);
  });
});

describe("checkPush: keadaan yang menghalangi (tanpa menyentuh jaringan)", () => {
  test("iOS di tab Safari: panduan memasang, izin TIDAK diminta dan relay tidak dihubungi", async () => {
    const s = setupPush({ platform: IOS_TAB, noNotification: true, noPushManager: true });
    expect(await checkPush(s.env)).toEqual({ kind: "needs-install" });
    expect(await enablePush(s.env)).toEqual({ kind: "needs-install" });
    expect(s.requestPermission).not.toHaveBeenCalled();
    expect(s.api.pushConfig).not.toHaveBeenCalled();
    expect(s.log).toEqual([]);
  });

  test("iOS tab Safari yang entah bagaimana punya Notification: izin tetap tidak diminta", async () => {
    const s = setupPush({ platform: IOS_TAB });
    expect(await enablePush(s.env)).toEqual({ kind: "needs-install" });
    expect(s.requestPermission).not.toHaveBeenCalled();
  });

  test("iOS di aplikasi layar utama: boleh lanjut", async () => {
    const s = setupPush({ platform: IOS_APP });
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
  });

  test.each([
    ["tanpa Notification", { noNotification: true }],
    ["tanpa PushManager", { noPushManager: true }],
  ])("%s: tidak didukung", async (_name, options) => {
    const s = setupPush(options);
    expect(await checkPush(s.env)).toEqual({ kind: "unsupported" });
    expect(await enablePush(s.env)).toEqual({ kind: "unsupported" });
    expect(s.requestPermission).not.toHaveBeenCalled();
  });

  test("tanpa service worker di browser: tidak didukung", async () => {
    const s = setupPush();
    expect(await checkPush({ ...s.env, getRegistration: undefined })).toEqual({ kind: "unsupported" });
  });

  test("izin sudah ditolak: dijelaskan, tidak diminta lagi", async () => {
    const s = setupPush({ permission: "denied" });
    expect(await checkPush(s.env)).toEqual({ kind: "denied" });
    expect(await enablePush(s.env)).toEqual({ kind: "denied" });
    expect(s.requestPermission).not.toHaveBeenCalled();
    expect(s.api.pushConfig).not.toHaveBeenCalled();
  });

  test("service worker belum terdaftar: no-sw", async () => {
    const s = setupPush({ noRegistration: true });
    expect(await checkPush(s.env)).toEqual({ kind: "no-sw" });
  });

  test("pendaftaran service worker yang gagal dibaca: no-sw, bukan galat tak tertangani", async () => {
    const s = setupPush();
    expect(await checkPush({ ...s.env, getRegistration: async () => Promise.reject(new Error("x")) })).toEqual({ kind: "no-sw" });
  });
});

describe("checkPush: keadaan relay dan izin", () => {
  test("relay belum menyalakan push: unavailable", async () => {
    const s = setupPush();
    s.relay.data.push.config = { enabled: false };
    expect(await checkPush(s.env)).toEqual({ kind: "unavailable" });
  });

  test("relay tidak terjangkau: error saat memeriksa", async () => {
    const s = setupPush();
    s.relay.fail.pushConfig = new Error("jaringan");
    expect(await checkPush(s.env)).toEqual({ kind: "error", during: "check" });
  });

  test("izin belum diminta: off, tidak ada langganan dibuat dan tidak ada yang dikirim ke relay", async () => {
    const s = setupPush({ permission: "default" });
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(s.api.savePushSubscription).not.toHaveBeenCalled();
  });

  test("izin ada, tanpa niat dan tanpa langganan (pengguna mematikannya): off, tidak dibuat ulang diam-diam", async () => {
    const s = setupPush({ permission: "granted", intent: false });
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  test("izin ada dan langganan masih ada: on, dan relay disamakan (memulihkan relay yang kehilangan langganan)", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(s.relay.data.push.saved).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: P256DH, auth: AUTH } });
    expect(s.getIntent()).toBe(true);
  });

  test("izin dan niat ada tetapi langganan hilang (data situs dibersihkan): dibuat ulang diam-diam", async () => {
    const s = setupPush({ permission: "granted", intent: true, existing: false });
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(s.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(s.requestPermission).not.toHaveBeenCalled(); // tidak ada pertanyaan ke pengguna
    expect(s.relay.data.push.saved).toBeDefined();
  });

  test("kunci relay berganti: langganan lama dibuang dan dibuat ulang dengan kunci baru", async () => {
    const s = setupPush({ permission: "granted", existing: "other-key", intent: true });
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(s.log.filter((l) => l.startsWith("browser:"))).toEqual(["browser:unsubscribe", "browser:subscribe"]);
    const used = vi.mocked(s.registration.pushManager.subscribe).mock.calls[0]![0];
    expect(used.userVisibleOnly).toBe(true);
    expect([...used.applicationServerKey]).toEqual([...decodeServerKey(FAKE_VAPID_PUBLIC_KEY)]);
  });

  test("browser menolak berlangganan: error, bukan melempar", async () => {
    const s = setupPush({ permission: "granted", intent: true, subscribeFails: true });
    expect(await checkPush(s.env)).toEqual({ kind: "error", during: "check" });
  });

  test("relay menolak menyimpan: error saat memeriksa", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    s.relay.fail.pushSave = new Error("503");
    expect(await checkPush(s.env)).toEqual({ kind: "error", during: "check" });
  });

  test("langganan dari browser yang tidak lengkap (tanpa kunci) tidak dikirim ke relay", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true, badSubscription: true });
    expect(await checkPush(s.env)).toEqual({ kind: "error", during: "check" });
    expect(s.api.savePushSubscription).not.toHaveBeenCalled();
  });
});

describe("checkPush: niat pengguna adalah sumber kebenaran (hasil review PR #58)", () => {
  test("langganan masih ada tetapi niat mati (mis. unsubscribe gagal saat dimatikan): off, dibuang, TIDAK didaftarkan ulang ke relay", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: false });
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.log).toContain("browser:unsubscribe");
    expect(s.current()).toBeNull();
    expect(s.api.savePushSubscription).not.toHaveBeenCalled();
    expect(s.getIntent()).toBe(false);
  });

  test("langganan yatim yang tidak bisa dibuang tetap tidak didaftarkan ulang dan tidak menyalakan niat", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: false, unsubscribeFails: true });
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.api.savePushSubscription).not.toHaveBeenCalled();
    expect(s.getIntent()).toBe(false);
  });

  test("mematikan lalu membuka kartu lagi, walau unsubscribe di browser gagal: tetap off (skenario temuan)", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true, unsubscribeFails: true });
    await disablePush(s.env); // unsubscribe gagal, relay berhasil
    expect(s.current()).not.toBeNull(); // langganannya memang masih ada di browser
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.relay.data.push.saved).toBeUndefined();
  });
});

describe("sinkron ke relay sekali per sesi (hasil review PR #58)", () => {
  test("kartu dibuka berkali-kali: relay menerima PUT hanya sekali per alamat", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    s.env.synced = new Set();
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(await checkPush(s.env)).toEqual({ kind: "on" });
    expect(s.api.savePushSubscription).toHaveBeenCalledTimes(1);
  });

  test("alamat berbeda (langganan dibuat ulang) dikirim lagi", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    s.env.synced = new Set(["https://alamat-lain.example/x"]);
    await checkPush(s.env);
    expect(s.api.savePushSubscription).toHaveBeenCalledTimes(1);
  });

  test("mengaktifkan mencatat alamatnya, mematikan menghapus catatan (aktifkan lagi mengirim ulang)", async () => {
    const s = setupPush({ permission: "granted" });
    s.env.synced = new Set();
    await enablePush(s.env);
    expect(s.env.synced.size).toBe(1);
    await checkPush(s.env);
    expect(s.api.savePushSubscription).toHaveBeenCalledTimes(1); // pemeriksaan sesudah aktifkan tidak mengirim lagi
    await disablePush(s.env);
    expect(s.env.synced.size).toBe(0);
  });

  test("tanpa catatan sesi (env biasa di tes): selalu dikirim", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    await checkPush(s.env);
    await checkPush(s.env);
    expect(s.api.savePushSubscription).toHaveBeenCalledTimes(2);
  });
});

describe("activeRegistration: menunggu service worker aktif (hasil review PR #58)", () => {
  const active = { active: {}, pushManager: {} } as unknown as RegistrationLike;
  const installing = { active: null, pushManager: {} } as unknown as RegistrationLike;
  const activated = { active: {}, pushManager: {}, id: "aktif" } as unknown as RegistrationLike;

  test("tidak ada registrasi: undefined, tanpa menunggu", async () => {
    expect(await activeRegistration({ getRegistration: async () => undefined, ready: new Promise(() => undefined) })).toBeUndefined();
  });

  test("sudah aktif: langsung dikembalikan, ready tidak ditunggu", async () => {
    expect(await activeRegistration({ getRegistration: async () => active, ready: new Promise(() => undefined) })).toBe(active);
  });

  test("masih dipasang: menunggu sampai ready, lalu mengembalikan registrasi yang aktif", async () => {
    let finish!: (registration: RegistrationLike) => void;
    const ready = new Promise<RegistrationLike>((resolve) => (finish = resolve));
    const pending = activeRegistration({ getRegistration: async () => installing, ready }, 5_000);
    finish(activated);
    expect(await pending).toBe(activated);
  });

  test("tidak kunjung aktif: undefined setelah batas waktu (bukan menggantung)", async () => {
    const started = Date.now();
    expect(await activeRegistration({ getRegistration: async () => installing, ready: new Promise(() => undefined) }, 30)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("ready ditolak: undefined, bukan galat", async () => {
    expect(await activeRegistration({ getRegistration: async () => installing, ready: Promise.reject(new Error("x")) }, 1000)).toBeUndefined();
  });
});

describe("enablePush", () => {
  test("izin diminta PALING DULU, sebelum menunggu relay apa pun (supaya gestur ketukan masih berlaku)", async () => {
    const s = setupPush({ permission: "default", asks: "granted" });
    expect(await enablePush(s.env)).toEqual({ kind: "on" });
    expect(s.log[0]).toBe("permission:ask");
    expect(s.log).toEqual(["permission:ask", "relay:config", "browser:subscribe", "relay:save"]);
  });

  test("berhasil: langganan tersimpan di relay dan niat dicatat", async () => {
    const s = setupPush({ permission: "default" });
    await enablePush(s.env);
    expect(s.relay.data.push.saved?.keys).toEqual({ p256dh: P256DH, auth: AUTH });
    expect(s.getIntent()).toBe(true);
    expect(vi.mocked(s.registration.pushManager.subscribe).mock.calls[0]![0].userVisibleOnly).toBe(true);
  });

  test("izin sudah ada: tidak bertanya lagi", async () => {
    const s = setupPush({ permission: "granted" });
    await enablePush(s.env);
    expect(s.requestPermission).not.toHaveBeenCalled();
  });

  test("pengguna menolak: denied, tidak ada langganan dan tidak ada yang dikirim ke relay", async () => {
    const s = setupPush({ permission: "default", asks: "denied" });
    expect(await enablePush(s.env)).toEqual({ kind: "denied" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(s.api.pushConfig).not.toHaveBeenCalled();
    expect(s.getIntent()).toBe(false);
  });

  test("pengguna menutup dialog tanpa memilih: kembali off (boleh dicoba lagi)", async () => {
    const s = setupPush({ permission: "default", asks: "default" });
    expect(await enablePush(s.env)).toEqual({ kind: "off" });
    expect(s.getIntent()).toBe(false);
  });

  test("relay tidak menyalakan push: unavailable dan tidak ada langganan yang dibuat", async () => {
    const s = setupPush({ permission: "granted" });
    s.relay.data.push.config = { enabled: false };
    expect(await enablePush(s.env)).toEqual({ kind: "unavailable" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  test("tanpa service worker: no-sw", async () => {
    const s = setupPush({ permission: "granted", noRegistration: true });
    expect(await enablePush(s.env)).toEqual({ kind: "no-sw" });
  });

  test.each([
    ["browser menolak berlangganan", { subscribeFails: true }],
    ["langganan tidak lengkap", { badSubscription: true }],
  ])("%s: error saat mengaktifkan, niat TIDAK dicatat", async (_name, options) => {
    const s = setupPush({ permission: "granted", ...options });
    expect(await enablePush(s.env)).toEqual({ kind: "error", during: "enable" });
    expect(s.getIntent()).toBe(false);
  });

  test("relay gagal menyimpan: error, niat tidak dicatat (percobaan berikutnya mengulang dari awal)", async () => {
    const s = setupPush({ permission: "granted" });
    s.relay.fail.pushSave = new Error("503");
    expect(await enablePush(s.env)).toEqual({ kind: "error", during: "enable" });
    expect(s.getIntent()).toBe(false);
  });

  test("langganan lama dengan kunci lain diganti, bukan dipakai ulang", async () => {
    const s = setupPush({ permission: "granted", existing: "other-key" });
    expect(await enablePush(s.env)).toEqual({ kind: "on" });
    expect(s.log.filter((l) => l.startsWith("browser:"))).toEqual(["browser:unsubscribe", "browser:subscribe"]);
  });

  test("langganan lama dengan kunci yang sama dipakai ulang (tidak membuat baru)", async () => {
    const s = setupPush({ permission: "granted", existing: true });
    expect(await enablePush(s.env)).toEqual({ kind: "on" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  test("berhenti berlangganan di browser lebih dulu, lalu memberi tahu relay, dan niat dihapus (tidak dibuat ulang)", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    expect(await disablePush(s.env)).toEqual({ kind: "off" });
    expect(s.log).toEqual(["browser:unsubscribe", "relay:remove"]);
    expect(s.getIntent()).toBe(false);
    expect(s.current()).toBeNull();
    // Dibuka lagi sesudahnya: izin masih ada, tetapi tidak dibuat ulang karena niatnya sudah dihapus.
    expect(await checkPush(s.env)).toEqual({ kind: "off" });
    expect(s.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  test("relay tidak terjangkau: HP tetap berhenti, dan pengguna diberi tahu relay belum menerimanya", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true });
    s.relay.fail.pushRemove = new Error("jaringan");
    expect(await disablePush(s.env)).toEqual({ kind: "off", relayPending: true });
    expect(s.current()).toBeNull();
    expect(s.getIntent()).toBe(false);
  });

  test("gagal berhenti di browser tidak menghalangi pembatalan di relay", async () => {
    const s = setupPush({ permission: "granted", existing: true, intent: true, unsubscribeFails: true });
    expect(await disablePush(s.env)).toEqual({ kind: "off" });
    expect(s.api.removePushSubscription).toHaveBeenCalledTimes(1);
  });

  test("tanpa langganan sama sekali: tetap aman dan memberi tahu relay", async () => {
    const s = setupPush({ permission: "granted", existing: false });
    expect(await disablePush(s.env)).toEqual({ kind: "off" });
    expect(s.api.removePushSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("currentPushEnv: perangkaian dengan browser (hasil review PR #58)", () => {
  const installing = { active: null, pushManager: {}, id: "baru-dipasang" };
  const activated = { active: {}, pushManager: {}, id: "aktif" };

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  test("registrasi yang masih dipasang ditunggu sampai aktif (bukan langsung dipakai subscribe)", async () => {
    let activate!: (r: unknown) => void;
    const ready = new Promise((resolve) => (activate = resolve));
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => installing, ready }, configurable: true });
    const env = currentPushEnv(setupPush().api);
    const pending = env.getRegistration!();
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // belum aktif: belum dikembalikan
    activate(activated);
    expect(await pending).toBe(activated);
  });

  test("tanpa service worker di browser: tidak ada getRegistration", () => {
    expect(currentPushEnv(setupPush().api).getRegistration).toBeUndefined();
  });
});
