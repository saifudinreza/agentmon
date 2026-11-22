// @vitest-environment node
// Bukti bahwa pustaka kripto bersama (issue #033) bisa diimpor dan dipakai dari PWA: lewat import dinamis (lazy) dan
// jalan di bundler yang sama. Berjalan di lingkungan Node, bukan jsdom: jsdom memakai kelas Uint8Array yang berbeda dari milik Node dan
// libsodium menolaknya ("buffer must be a Uint8Array"); di browser sungguhan tidak ada masalah itu. Build produksinya diperiksa terpisah (chunk tersendiri).
import { expect, test } from "vitest";

test("libsodium dimuat belakangan di sisi web dan bolak-balik enkripsi event berjalan", async () => {
  const { generateDataKey, generateSignKeyPair, loadSodium, openEvent, sealEvent, utf8 } = await import("@agentmon/shared/crypto");
  const s = await loadSodium();
  const sign = generateSignKeyPair(s);
  const dataKey = generateDataKey(s);
  const envelope = { v: 1, id: "e", machineId: "m", sessionId: "s", seq: 1, ts: "2026-11-22T00:00:00.000Z", agent: "claude-code", type: "session.started" };
  const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext: utf8("halo"), signPrivateKey: sign.privateKey });
  expect(new TextDecoder().decode(openEvent(s, { payload, envelope, dataKeys: () => dataKey, signPublicKey: sign.publicKey }))).toBe("halo");
}, 30_000);
