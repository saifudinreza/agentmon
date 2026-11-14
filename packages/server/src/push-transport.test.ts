import { describe, expect, test, vi } from "vitest";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(), generateVAPIDKeys: vi.fn() } }));

import webpush from "web-push";
import { PushSendError, webPushTransport } from "./push";

const send = vi.mocked(webpush.sendNotification);
const SECRET_ENDPOINT = "https://fcm.googleapis.com/fcm/send/TOKEN-RAHASIA-LANGGANAN";
const subscription = { endpoint: SECRET_ENDPOINT, p256dh: "kunci-publik", auth: "rahasia-auth" };
const options = { ttlSeconds: 600, urgency: "high" as const, vapid: { publicKey: "pub", privateKey: "PRIV-RAHASIA", subject: "https://app.contoh.com" }, timeoutMs: 7000 };

// Sengaja TANPA hook beforeEach yang menyentuh tiruan: percobaan dengan mockReset maupun mockClear membuat tes yang
// melempar galat tiruan gagal dengan galat tiruan itu sendiri (Vitest 5), padahal tanpa hook semuanya lulus. Penyebab
// persisnya tidak ditelusuri; tiap tes menetapkan perilaku tiruannya sendiri, jadi hook itu memang tidak diperlukan.

describe("webPushTransport", () => {
  test("meneruskan langganan, isi, dan pilihan ke pustaka (kunci langganan dalam bentuk keys.p256dh/auth)", async () => {
    send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await webPushTransport(subscription, '{"v":1}', options);
    expect(send).toHaveBeenCalledWith(
      { endpoint: SECRET_ENDPOINT, keys: { p256dh: "kunci-publik", auth: "rahasia-auth" } },
      '{"v":1}',
      { TTL: 600, urgency: "high", timeout: 7000, vapidDetails: { subject: "https://app.contoh.com", publicKey: "pub", privateKey: "PRIV-RAHASIA" } },
    );
  });

  test("layanan push menjawab galat: kode status dibawa, pesan tidak memuat alamat atau isi jawaban", async () => {
    send.mockImplementation(async () => {
      throw Object.assign(new Error(`Received unexpected response code ${SECRET_ENDPOINT} PRIV-RAHASIA`), { statusCode: 410, body: "isi jawaban", endpoint: SECRET_ENDPOINT });
    });
    const error = await webPushTransport(subscription, "{}", options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushSendError);
    expect((error as PushSendError).statusCode).toBe(410);
    expect((error as PushSendError).message).toBe("layanan push menjawab 410");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("TOKEN-RAHASIA");
  });

  test("galat jaringan: tanpa kode status, hanya kode galat sistem", async () => {
    send.mockImplementation(async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET_ENDPOINT}`), { code: "ECONNREFUSED" });
    });
    const error = (await webPushTransport(subscription, "{}", options).catch((e: unknown) => e)) as PushSendError;
    expect(error).toBeInstanceOf(PushSendError);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toBe("gagal terhubung (ECONNREFUSED)");
    expect(error.message).not.toContain("TOKEN-RAHASIA");
  });

  test("galat yang bentuknya aneh tetap menjadi PushSendError yang aman", async () => {
    for (const odd of ["teks", 42, null, undefined, { statusCode: "410" }]) {
      send.mockRejectedValueOnce(odd);
      const error = (await webPushTransport(subscription, "{}", options).catch((e: unknown) => e)) as PushSendError;
      expect(error).toBeInstanceOf(PushSendError);
      expect(error.statusCode).toBeUndefined();
    }
  });
});
