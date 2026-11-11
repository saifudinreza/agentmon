import { describe, expect, test } from "vitest";
import { ClientFrameSchema, RELAY_ERROR_CODES, ServerFrameSchema } from "./relay";

const TOKEN = "t".repeat(32);
const envelope = {
  v: 1,
  id: "11111111-1111-4111-8111-111111111111",
  machineId: "laptop-1",
  sessionId: "sesi-1",
  seq: 0,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: { toolName: "Write", toolInput: {} },
};

describe("ClientFrameSchema", () => {
  test.each([
    ["hello laptop", { kind: "hello", role: "machine", token: TOKEN }],
    ["hello HP", { kind: "hello", role: "device", token: TOKEN }],
    ["event", { kind: "event", event: envelope }],
    ["event dengan isi terenkripsi (bukan objek)", { kind: "event", event: { ...envelope, payload: "c2VjcmV0" } }],
    ["event dengan jenis yang belum dikenal (dari versi lebih baru)", { kind: "event", event: { ...envelope, type: "jenis.baru" } }],
    ["command", { kind: "command", machineId: "laptop-1", body: { decision: "approve" } }],
  ])("%s diterima", (_name, frame) => {
    expect(ClientFrameSchema.safeParse(frame).success).toBe(true);
  });

  test.each([
    ["bukan objek", "hello"],
    ["null", null],
    ["jenis asing", { kind: "terbang" }],
    ["tanpa jenis", { role: "machine", token: TOKEN }],
    ["hello dengan peran asing", { kind: "hello", role: "admin", token: TOKEN }],
    ["hello dengan token pendek", { kind: "hello", role: "machine", token: "abc" }],
    ["hello dengan token terlalu panjang", { kind: "hello", role: "machine", token: "x".repeat(513) }],
    ["hello tanpa token", { kind: "hello", role: "machine" }],
    ["event dengan amplop rusak", { kind: "event", event: { ...envelope, id: "bukan-uuid" } }],
    ["event dengan edisi berbeda", { kind: "event", event: { ...envelope, v: 2 } }],
    ["event tanpa sesi", { kind: "event", event: { ...envelope, sessionId: "" } }],
    ["event tanpa kolom event", { kind: "event" }],
    ["command tanpa machineId", { kind: "command", body: {} }],
    ["command dengan machineId kosong", { kind: "command", machineId: "", body: {} }],
    ["command dengan isi berupa daftar", { kind: "command", machineId: "m", body: [1] }],
    ["command dengan isi teks", { kind: "command", machineId: "m", body: "x" }],
  ])("%s ditolak", (_name, frame) => {
    expect(ClientFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("ServerFrameSchema", () => {
  test.each([
    { kind: "welcome", role: "machine", id: "laptop-1" },
    { kind: "event", event: envelope },
    { kind: "command", deviceId: "hp-1", body: { decision: "deny" } },
    { kind: "error", code: "rate_limited", message: "terlalu cepat" },
  ])("%j diterima", (frame) => {
    expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
  });

  test("setiap kode galat dikenal, dan kode asing ditolak", () => {
    for (const code of RELAY_ERROR_CODES) {
      expect(ServerFrameSchema.safeParse({ kind: "error", code, message: "x" }).success, code).toBe(true);
    }
    expect(ServerFrameSchema.safeParse({ kind: "error", code: "meledak", message: "x" }).success).toBe(false);
  });

  test("galat tanpa pesan ditolak", () => {
    expect(ServerFrameSchema.safeParse({ kind: "error", code: "forbidden", message: "" }).success).toBe(false);
  });
});

describe("ServerFrameSchema: ack", () => {
  test("ack berisi nomor event", () => {
    expect(ServerFrameSchema.safeParse({ kind: "ack", eventId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });

  test.each([{ kind: "ack" }, { kind: "ack", eventId: "" }, { kind: "ack", eventId: 5 }])("ack tidak sah ditolak: %j", (frame) => {
    expect(ServerFrameSchema.safeParse(frame).success).toBe(false);
  });

  test("klien tidak boleh mengirim ack ke relay (arahnya hanya dari relay ke laptop)", () => {
    expect(ClientFrameSchema.safeParse({ kind: "ack", eventId: "x" }).success).toBe(false);
  });
});
