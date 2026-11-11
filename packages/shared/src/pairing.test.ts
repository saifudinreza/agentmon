import { describe, expect, test } from "vitest";
import { buildPairingUrl, PairRedeemRequestSchema, PairRedeemResponseSchema, parsePairingUrl } from "./pairing";

const CODE = "abcDEF0123456789_-abcDEF0123456789";
const APP = "https://app.contoh.com";
const RELAY = "https://relay.contoh.com";

describe("buildPairingUrl dan parsePairingUrl", () => {
  test("bolak-balik: yang dibuat bisa dibaca kembali persis", () => {
    const url = buildPairingUrl(APP, { code: CODE, relayUrl: RELAY });
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY });
  });

  test("SEMUA data ada di fragmen: tidak ada di jalur atau query yang dikirim ke server", () => {
    const url = new URL(buildPairingUrl(APP, { code: CODE, relayUrl: RELAY, secret: "rahasia-e2e" }));
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(url.hash).toContain(`c=${CODE}`);
    // Bagian yang benar-benar dikirim browser ke server hosting:
    const sentToServer = `${url.origin}${url.pathname}${url.search}`;
    expect(sentToServer).not.toContain(CODE);
    expect(sentToServer).not.toContain("rahasia-e2e");
  });

  test("rahasia E2E (tahap 4) bisa ditambahkan tanpa mengubah bentuk lain", () => {
    const url = buildPairingUrl(APP, { code: CODE, relayUrl: RELAY, secret: "k_rahasia-123" });
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY, secret: "k_rahasia-123" });
  });

  test("alamat PWA yang berada di sub-jalur dan berakhiran garis miring tetap benar", () => {
    expect(new URL(buildPairingUrl("https://contoh.com/agentmon/", { code: CODE, relayUrl: RELAY })).pathname).toBe("/agentmon/pair");
  });

  test("alamat PWA yang membawa query/fragmen lama dibersihkan", () => {
    const url = new URL(buildPairingUrl("https://contoh.com/?x=1#lama", { code: CODE, relayUrl: RELAY }));
    expect(url.search).toBe("");
    expect(url.hash).not.toContain("lama");
  });

  test("alamat relay dengan port, jalur, dan karakter khusus selamat", () => {
    const relay = "http://192.168.1.5:8787/prefix?a=b&c=d";
    expect(parsePairingUrl(buildPairingUrl(APP, { code: CODE, relayUrl: relay }))?.relayUrl).toBe(relay);
  });

  test("parameter yang belum dikenal diabaikan (versi baru tetap terbaca versi lama)", () => {
    const url = `${APP}/pair#c=${CODE}&r=${encodeURIComponent(RELAY)}&v=9&x=apa-saja`;
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY });
  });

  test.each([
    ["bukan alamat", "halo dunia"],
    ["kosong", ""],
    ["skema berbahaya", `javascript:alert(1)//pair#c=${CODE}&r=${RELAY}`],
    ["skema ftp", `ftp://x.com/pair#c=${CODE}&r=${RELAY}`],
    ["jalur salah", `${APP}/lain#c=${CODE}&r=${encodeURIComponent(RELAY)}`],
    ["tanpa kode", `${APP}/pair#r=${encodeURIComponent(RELAY)}`],
    ["tanpa relay", `${APP}/pair#c=${CODE}`],
    ["kode terlalu pendek", `${APP}/pair#c=pendek&r=${encodeURIComponent(RELAY)}`],
    ["kode berkarakter aneh", `${APP}/pair#c=${"a".repeat(15)}!&r=${encodeURIComponent(RELAY)}`],
    ["relay bukan http", `${APP}/pair#c=${CODE}&r=${encodeURIComponent("javascript:alert(1)")}`],
    ["relay bukan alamat", `${APP}/pair#c=${CODE}&r=bukan-alamat`],
    ["kode hanya di query (bukan fragmen)", `${APP}/pair?c=${CODE}&r=${encodeURIComponent(RELAY)}`],
  ])("menolak: %s", (_name, text) => {
    expect(parsePairingUrl(text)).toBeUndefined();
  });

  test("pembuat menolak masukan yang tidak sah", () => {
    expect(() => buildPairingUrl("bukan-url", { code: CODE, relayUrl: RELAY })).toThrow(TypeError);
    expect(() => buildPairingUrl(APP, { code: CODE, relayUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => buildPairingUrl(APP, { code: "pendek", relayUrl: RELAY })).toThrow(TypeError);
  });
});

describe("skema permintaan dan jawaban", () => {
  test("permintaan penukaran: nama dipangkas, kosong dan terlalu panjang ditolak", () => {
    expect(PairRedeemRequestSchema.parse({ code: CODE, name: "  iPhone Budi  " }).name).toBe("iPhone Budi");
    expect(PairRedeemRequestSchema.safeParse({ code: CODE, name: "   " }).success).toBe(false);
    expect(PairRedeemRequestSchema.safeParse({ code: CODE, name: "x".repeat(65) }).success).toBe(false);
    expect(PairRedeemRequestSchema.safeParse({ code: "pendek", name: "HP" }).success).toBe(false);
  });

  test("jawaban: deviceToken boleh tidak ada, tetapi bila ada minimal 16 karakter", () => {
    const base = { deviceId: "d1", machineId: "m1", machineName: "Laptop" };
    expect(PairRedeemResponseSchema.safeParse(base).success).toBe(true);
    expect(PairRedeemResponseSchema.safeParse({ ...base, deviceToken: "x".repeat(16) }).success).toBe(true);
    expect(PairRedeemResponseSchema.safeParse({ ...base, deviceToken: "pendek" }).success).toBe(false);
  });
});
