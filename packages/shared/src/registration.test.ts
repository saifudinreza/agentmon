import { describe, expect, test } from "vitest";
import { MachineRegisterRequestSchema, MachineRegisterResponseSchema } from "./registration";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("MachineRegisterRequestSchema", () => {
  test("permintaan sah diterima; nama dipangkas; rotate opsional", () => {
    expect(MachineRegisterRequestSchema.parse({ id: ID, name: "  Laptop Kantor " })).toEqual({ id: ID, name: "Laptop Kantor" });
    expect(MachineRegisterRequestSchema.parse({ id: ID.toUpperCase(), name: "L", rotate: true })).toMatchObject({ rotate: true });
  });

  test.each([
    ["nomor bukan UUID", { id: "m1", name: "L" }],
    ["UUID dengan awalan", { id: `x${ID}`, name: "L" }],
    ["UUID dengan sisa", { id: `${ID}x`, name: "L" }],
    ["nama kosong", { id: ID, name: "  " }],
    ["nama 65 karakter", { id: ID, name: "a".repeat(65) }],
    ["nama dengan ESC", { id: ID, name: "a\u001b[2Jb" }],
    ["nama dengan baris baru", { id: ID, name: "a\nb" }],
    ["rotate bukan boolean", { id: ID, name: "L", rotate: 1 }],
    ["tanpa nama", { id: ID }],
  ])("ditolak: %s", (_name, input) => expect(MachineRegisterRequestSchema.safeParse(input).success).toBe(false));

  test("nama 64 karakter diterima", () => {
    expect(MachineRegisterRequestSchema.safeParse({ id: ID, name: "a".repeat(64) }).success).toBe(true);
  });
});

describe("MachineRegisterResponseSchema", () => {
  test("token 64 heksadesimal huruf kecil diterima", () => {
    expect(MachineRegisterResponseSchema.safeParse({ machineId: ID, token: "a".repeat(64) }).success).toBe(true);
  });

  test.each([
    ["token pendek", { machineId: ID, token: "a".repeat(63) }],
    ["token huruf besar", { machineId: ID, token: "A".repeat(64) }],
    ["token bukan heksadesimal", { machineId: ID, token: "g".repeat(64) }],
    ["nomor bukan UUID", { machineId: "m1", token: "a".repeat(64) }],
  ])("ditolak: %s", (_name, input) => expect(MachineRegisterResponseSchema.safeParse(input).success).toBe(false));
});
