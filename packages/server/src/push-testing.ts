// Pembantu KHUSUS TEST untuk Web Push: langganan buatan dengan kunci sungguhan, supaya enkripsi bisa dibuktikan.
import { createECDH, randomBytes } from "node:crypto";

export type FakeBrowser = {
  /** Bentuk yang dikirim PWA ke relay (PushSubscription.toJSON()). */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  privateKey: Buffer;
  publicKey: Buffer;
  authSecret: Buffer;
};

/** Browser pura-pura: pasangan kunci P-256 dan rahasia autentikasi 16 byte, persis yang dibuat browser sungguhan. */
export function fakeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString("hex")}`): FakeBrowser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } },
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    authSecret,
  };
}
