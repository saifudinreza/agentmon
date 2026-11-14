import { createECDH, createPublicKey, hkdfSync, createDecipheriv, verify } from "node:crypto";
import type { PushPayload } from "@agentmon/shared";
import webpush from "web-push";
import { describe, expect, test } from "vitest";
import type { StoredSubscription } from "./db/push";
import type { Logger } from "./logger";
import { fakeBrowser } from "./push-testing";
import { createEndpointPolicy, createPushService, generateVapidKeys, parseVapidConfig, PushSendError, validateSubscription, type PushTransport, type VapidConfig } from "./push";

const keys = generateVapidKeys();
const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "https://agentmon.contoh.com" };
const vapid: VapidConfig = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: env.VAPID_SUBJECT };

describe("parseVapidConfig", () => {
  test("tidak diisi sama sekali: push mati tanpa masalah", () => {
    expect(parseVapidConfig({})).toEqual({});
    expect(parseVapidConfig({ VAPID_PUBLIC_KEY: " ", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" })).toEqual({});
  });

  test("ketiganya benar: dipakai", () => {
    expect(parseVapidConfig(env)).toEqual({ config: vapid });
    expect(parseVapidConfig({ ...env, VAPID_SUBJECT: "mailto:operator@contoh.com" }).config?.subject).toBe("mailto:operator@contoh.com");
  });

  test("diisi sebagian: masalah, dan push tetap mati", () => {
    for (const missing of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const) {
      const partial = { ...env, [missing]: "" };
      const result = parseVapidConfig(partial);
      expect(result.config).toBeUndefined();
      expect(result.problem).toContain("bersama-sama");
    }
  });

  test("bentuk kunci dan subjek yang salah ditolak", () => {
    // Pesan harus menyebut BENTUK yang salah (bukan "tidak cocok"), supaya yang salah salin tahu apa yang diperbaiki.
    expect(parseVapidConfig({ ...env, VAPID_PUBLIC_KEY: "pendek" }).problem).toBe("VAPID_PUBLIC_KEY bukan kunci publik VAPID yang sah");
    expect(parseVapidConfig({ ...env, VAPID_PRIVATE_KEY: "pendek" }).problem).toContain("VAPID_PRIVATE_KEY");
    expect(parseVapidConfig({ ...env, VAPID_SUBJECT: "http://tidak-aman.com" }).problem).toContain("VAPID_SUBJECT");
    expect(parseVapidConfig({ ...env, VAPID_SUBJECT: "orang" }).problem).toContain("VAPID_SUBJECT");
  });

  test("kunci publik dari pasangan lain ditolak (salah salin)", () => {
    const other = generateVapidKeys();
    const result = parseVapidConfig({ ...env, VAPID_PUBLIC_KEY: other.publicKey });
    expect(result.config).toBeUndefined();
    expect(result.problem).toContain("tidak cocok");
  });

  test("pesan masalah tidak pernah memuat nilai kunci", () => {
    const secret = env.VAPID_PRIVATE_KEY;
    for (const bad of [{ ...env, VAPID_PUBLIC_KEY: generateVapidKeys().publicKey }, { ...env, VAPID_SUBJECT: "x" }, { ...env, VAPID_PUBLIC_KEY: "" }]) {
      expect(parseVapidConfig(bad).problem ?? "").not.toContain(secret);
    }
  });
});

describe("createEndpointPolicy: hanya layanan push yang dikenal (cegah SSRF)", () => {
  const allowed = createEndpointPolicy();

  test.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGxyz",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://FCM.GOOGLEAPIS.COM/fcm/send/abc",
    "https://fcm.googleapis.com:443/fcm/send/abc",
  ])("diizinkan: %s", (endpoint) => expect(allowed(endpoint)).toBe(true));

  test.each([
    ["http polos", "http://fcm.googleapis.com/fcm/send/abc"],
    ["alamat internal hosting", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/x"],
    ["alamat IP", "https://10.0.0.5/x"],
    ["host mirip sebagai awalan", "https://fcm.googleapis.com.penyerang.com/x"],
    ["host mirip sebagai akhiran", "https://evilfcm.googleapis.com.example/x"],
    ["nama pengguna menyamar", "https://fcm.googleapis.com@penyerang.com/x"],
    ["membawa nama pengguna", "https://user:sandi@fcm.googleapis.com/x"],
    ["port lain", "https://fcm.googleapis.com:8443/x"],
    ["skema lain", "ftp://fcm.googleapis.com/x"],
    ["bukan alamat", "bukan alamat"],
    ["kosong", ""],
  ])("ditolak: %s", (_name, endpoint) => expect(allowed(endpoint)).toBe(false));

  test("PUSH_ALLOWED_HOSTS menambah layanan, tidak mengganti daftar", () => {
    const extended = createEndpointPolicy(["push.layanan-baru.example", " "]);
    expect(extended("https://eu.push.layanan-baru.example/x")).toBe(true);
    expect(extended("https://fcm.googleapis.com/x")).toBe(true);
    expect(extended("https://layanan-lain.example/x")).toBe(false);
  });
});

describe("validateSubscription", () => {
  const ok = createEndpointPolicy();

  test("langganan sungguhan diterima", () => {
    const { subscription } = fakeBrowser();
    expect(validateSubscription(subscription, ok)).toEqual(subscription);
  });

  test("kolom tambahan dari browser (expirationTime) diabaikan, bukan ditolak", () => {
    const { subscription } = fakeBrowser();
    expect(validateSubscription({ ...subscription, expirationTime: null }, ok)).toEqual(subscription);
  });

  test("ditolak: alamat tidak dikenal, kunci rusak, rahasia salah panjang, bentuk salah", () => {
    const { subscription } = fakeBrowser();
    expect(validateSubscription({ ...subscription, endpoint: "https://penyerang.example/x" }, ok)).toBeUndefined();
    // Panjang benar (87 karakter) tetapi bukan titik di kurva P-256.
    expect(validateSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "A".repeat(87) } }, ok)).toBeUndefined();
    expect(validateSubscription({ ...subscription, keys: { ...subscription.keys, auth: "pendek" } }, ok)).toBeUndefined();
    expect(validateSubscription({ ...subscription, keys: { p256dh: subscription.keys.p256dh } }, ok)).toBeUndefined();
    expect(validateSubscription(undefined, ok)).toBeUndefined();
    expect(validateSubscription("teks", ok)).toBeUndefined();
    expect(validateSubscription({ ...subscription, endpoint: `https://fcm.googleapis.com/${"a".repeat(3000)}` }, ok)).toBeUndefined();
  });
});

// ---- Layanan pengiriman dengan pengirim palsu --------------------------------------------------
const payload: PushPayload = { v: 1, kind: "approval", machineId: "m1", sessionId: "s1", approvalId: "a1" };
const sub = (id: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`): StoredSubscription => ({ id, deviceId: `d-${id}`, endpoint, p256dh: "x", auth: "y" });

function setup(subs: StoredSubscription[], transport: PushTransport, extra: { concurrency?: number } = {}) {
  const removed: string[][] = [];
  const logs: string[] = [];
  const logger: Logger = { info: (m) => logs.push(`INFO ${m}`), error: (m) => logs.push(`ERROR ${m}`) };
  const service = createPushService({
    store: { forMachine: async () => subs, forDevice: async () => subs, removeByIds: async (ids) => void removed.push([...ids]) },
    vapid,
    isAllowedEndpoint: createEndpointPolicy(),
    transport,
    logger,
    ...extra,
  });
  return { service, removed, logs };
}

describe("createPushService", () => {
  test("terkirim ke semua langganan dengan isi JSON minimal, urgensi tinggi untuk izin, dan TTL pendek", async () => {
    const calls: Array<{ endpoint: string; body: string; options: Parameters<PushTransport>[2] }> = [];
    const { service, removed } = setup([sub("a"), sub("b")], async (s, body, options) => void calls.push({ endpoint: s.endpoint, body, options }));
    const result = await service.notifyMachine("m1", payload);
    expect(result).toEqual({ attempted: 2, delivered: 2, removed: 0, failed: 0 });
    expect(removed).toEqual([]);
    expect(calls.map((c) => c.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/a", "https://fcm.googleapis.com/fcm/send/b"]);
    expect(JSON.parse(calls[0]!.body)).toEqual(payload);
    expect(calls[0]!.options).toMatchObject({ urgency: "high", ttlSeconds: 600, vapid });
  });

  test("jenis 'done' memakai urgensi normal", async () => {
    let seen: Parameters<PushTransport>[2] | undefined;
    const { service } = setup([sub("a")], async (_s, _b, options) => void (seen = options));
    await service.notifyDevice("d1", { v: 1, kind: "done", machineId: "m1" });
    expect(seen).toMatchObject({ urgency: "normal", ttlSeconds: 3600 });
  });

  test("langganan mati (404 dan 410) dihapus; kegagalan sementara dan penolakan kunci tidak menghapus", async () => {
    const status: Record<string, number | undefined> = { gone: 410, missing: 404, flaky: 503, limited: 429, keybad: 401, forbidden: 403, offline: undefined };
    const subs = Object.keys(status).map((id) => sub(id));
    const { service, removed, logs } = setup(subs, async (s) => {
      const id = s.endpoint.split("/").pop()!;
      throw new PushSendError("gagal", status[id]);
    });
    const result = await service.notifyMachine("m1", payload);
    expect(result).toEqual({ attempted: 7, delivered: 0, removed: 2, failed: 5 });
    expect(removed).toHaveLength(1);
    expect([...removed[0]!].sort()).toEqual(["gone", "missing"]);
    expect(logs.some((l) => l.startsWith("ERROR") && l.includes("VAPID"))).toBe(true); // salah kunci terlihat jelas
  });

  test("sebagian berhasil, sebagian mati: hasilnya dihitung terpisah", async () => {
    const { service, removed } = setup([sub("ok"), sub("dead")], async (s) => {
      if (s.endpoint.endsWith("dead")) throw new PushSendError("mati", 410);
    });
    expect(await service.notifyMachine("m1", payload)).toEqual({ attempted: 2, delivered: 1, removed: 1, failed: 0 });
    expect(removed).toEqual([["dead"]]);
  });

  test("baris lama dengan alamat yang tidak lolos aturan: tidak pernah dihubungi, langsung dihapus", async () => {
    let contacted = 0;
    const { service, removed } = setup([sub("internal", "https://169.254.169.254/x"), sub("ok")], async () => void (contacted += 1));
    expect(await service.notifyMachine("m1", payload)).toEqual({ attempted: 1, delivered: 1, removed: 1, failed: 0 });
    expect(contacted).toBe(1);
    expect(removed).toEqual([["internal"]]);
  });

  test("tanpa langganan: tidak ada yang dicoba dan tidak ada log", async () => {
    const { service, logs } = setup([], async () => undefined);
    expect(await service.notifyMachine("m1", payload)).toEqual({ attempted: 0, delivered: 0, removed: 0, failed: 0 });
    expect(logs).toEqual([]);
  });

  test("isi yang tidak sah dilempar (kesalahan pemanggil), bukan dianggap kegagalan jaringan", async () => {
    const { service } = setup([sub("a")], async () => undefined);
    await expect(service.notifyMachine("m1", { ...payload, kind: "rahasia" } as unknown as PushPayload)).rejects.toThrow();
    await expect(service.notifyMachine("m1", { ...payload, kode: "rm -rf /" } as unknown as PushPayload)).rejects.toThrow(); // skema ketat: tidak ada kolom liar
    await expect(service.notifyMachine("m1", { ...payload, sessionId: "x".repeat(300) })).rejects.toThrow();
  });

  test("pengiriman dibatasi jumlah bersamanya dan semuanya tetap terkirim", async () => {
    let inflight = 0;
    let peak = 0;
    const { service } = setup(Array.from({ length: 25 }, (_, i) => sub(`s${i}`)), async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
    }, { concurrency: 4 });
    expect((await service.notifyMachine("m1", payload)).delivered).toBe(25);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  test("log tidak pernah memuat alamat langganan, kunci, atau isi push", async () => {
    const secretEndpoint = "https://fcm.googleapis.com/fcm/send/TOKEN-RAHASIA-LANGGANAN";
    const { service, logs } = setup(
      [sub("a", secretEndpoint), sub("b", `${secretEndpoint}-2`), sub("c", `${secretEndpoint}-3`)],
      async (s) => {
        if (s.endpoint.endsWith("-2")) throw new PushSendError("mati", 410);
        if (s.endpoint.endsWith("-3")) throw new PushSendError("kunci", 401);
      },
    );
    await service.notifyMachine("m1", payload);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain("TOKEN-RAHASIA");
      expect(line).not.toContain(keys.privateKey);
      expect(line).not.toContain("approvalId");
    }
  });

  test("gagal menghapus langganan mati dicatat dan tidak menggagalkan pengiriman", async () => {
    const logs: string[] = [];
    const service = createPushService({
      store: { forMachine: async () => [sub("dead")], forDevice: async () => [], removeByIds: async () => Promise.reject(new Error("db mati")) },
      vapid,
      isAllowedEndpoint: createEndpointPolicy(),
      transport: async () => Promise.reject(new PushSendError("mati", 410)),
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    expect(await service.notifyMachine("m1", payload)).toEqual({ attempted: 1, delivered: 0, removed: 0, failed: 0 });
    expect(logs.some((l) => l.includes("gagal menghapus"))).toBe(true);
  });
});

// ---- Bukti dengan pustaka web-push sungguhan ---------------------------------------------------
// Tanpa jaringan: pustaka diminta menyusun permintaannya, lalu "browser pura-pura" membuka isinya dengan RFC 8291.
describe("format Web Push sungguhan (enkripsi RFC 8291 dan VAPID RFC 8292)", () => {
  function decrypt(body: Buffer, browser: ReturnType<typeof fakeBrowser>): string {
    const salt = body.subarray(0, 16);
    const idLength = body.readUInt8(20);
    const senderPublic = body.subarray(21, 21 + idLength);
    const ciphertext = body.subarray(21 + idLength);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(browser.privateKey);
    const shared = ecdh.computeSecret(senderPublic);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), browser.publicKey, senderPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", shared, browser.authSecret, keyInfo, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    const end = padded.lastIndexOf(0x02); // pembatas: 0x02 lalu nol (isian)
    return padded.subarray(0, end).toString("utf8");
  }

  test("isi push terbuka hanya oleh pemilik langganan dan sama persis dengan yang dikirim", () => {
    const browser = fakeBrowser();
    const body = JSON.stringify(payload);
    const details = webpush.generateRequestDetails(browser.subscription, body, {
      TTL: 600,
      urgency: "high",
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    expect(details.method).toBe("POST");
    expect(details.endpoint).toBe(browser.subscription.endpoint);
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers.TTL).toBe(600);
    expect(details.headers.Urgency).toBe("high");
    expect(decrypt(details.body, browser)).toBe(body);
    // Pihak lain (kunci lain) tidak bisa membukanya.
    expect(() => decrypt(details.body, fakeBrowser())).toThrow();
  });

  test("tanda tangan VAPID sah: ditandatangani kunci relay, untuk host layanan push, dengan subjek dan masa berlaku", () => {
    const browser = fakeBrowser();
    const details = webpush.generateRequestDetails(browser.subscription, "x", {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    const header = String(details.headers.Authorization);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, p, signature, k] = match!;
    expect(k).toBe(vapid.publicKey);
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { aud: string; sub: string; exp: number };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe(vapid.subject);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600);
    const point = Buffer.from(vapid.publicKey, "base64url");
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});
