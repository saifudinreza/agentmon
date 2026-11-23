// Bukti bahwa pustaka kripto bersama (issue #033) bisa diimpor dan dipakai dari daemon (Node).
import { expect, test } from "vitest";

test("libsodium dimuat di Node dan bolak-balik enkripsi event berjalan", async () => {
  const { generateDataKey, generateSignKeyPair, loadSodium, openEvent, sealEvent, utf8 } = await import("@agentmon/shared/crypto");
  const s = await loadSodium();
  const sign = generateSignKeyPair(s);
  const dataKey = generateDataKey(s);
  const envelope = { v: 1, id: "e", machineId: "m", sessionId: "s", seq: 1, ts: "2026-11-22T00:00:00.000Z", agent: "claude-code", type: "session.started" };
  const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext: utf8("halo"), signPrivateKey: sign.privateKey });
  expect(new TextDecoder().decode(openEvent(s, { expectedMachineId: "m", payload, envelope, dataKeys: () => dataKey, signPublicKey: sign.publicKey }).plaintext)).toBe("halo");
}, 30_000);
