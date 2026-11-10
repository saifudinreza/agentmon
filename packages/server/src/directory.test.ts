import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createMemoryDirectory, hashToken } from "./directory";
import { describeDirectoryContract } from "./directory.contract";

const MACHINE = "machine-token-0000000000000000";
const DEVICE = "device-token-00000000000000000";

describe("hashToken", () => {
  test("SHA-256 heksadesimal, dan bukan token aslinya", () => {
    const hash = hashToken(MACHINE);
    expect(hash).toBe(createHash("sha256").update(MACHINE).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(MACHINE);
  });

  test("token berbeda menghasilkan hash berbeda, token sama menghasilkan hash sama", () => {
    expect(hashToken("a".repeat(20))).toBe(hashToken("a".repeat(20)));
    expect(hashToken("a".repeat(20))).not.toBe(hashToken("b".repeat(20)));
  });
});

describe("createMemoryDirectory", () => {
  test("mengenali token yang terdaftar dan menolak yang lain", async () => {
    const directory = createMemoryDirectory();
    directory.addMachine("m1", MACHINE);
    directory.addDevice("d1", DEVICE);
    expect(await directory.authenticate("machine", MACHINE)).toBe("m1");
    expect(await directory.authenticate("device", DEVICE)).toBe("d1");
    expect(await directory.authenticate("machine", "token-salah-0000000000000000")).toBeUndefined();
    expect(await directory.authenticate("machine", "")).toBeUndefined();
  });

  test("peran dipisah: token HP tidak berlaku sebagai laptop, dan sebaliknya", async () => {
    const directory = createMemoryDirectory();
    directory.addMachine("m1", MACHINE);
    directory.addDevice("d1", DEVICE);
    expect(await directory.authenticate("device", MACHINE)).toBeUndefined();
    expect(await directory.authenticate("machine", DEVICE)).toBeUndefined();
  });

  test("pemasangan: devicesOf dan isPaired konsisten, dan bisa dicabut", async () => {
    const directory = createMemoryDirectory();
    directory.pair("m1", "d1");
    directory.pair("m1", "d2");
    directory.pair("m2", "d3");

    expect([...(await directory.devicesOf("m1"))].sort()).toEqual(["d1", "d2"]);
    expect(await directory.devicesOf("m2")).toEqual(["d3"]);
    expect(await directory.devicesOf("tidak-ada")).toEqual([]);
    expect(await directory.isPaired("m1", "d1")).toBe(true);
    expect(await directory.isPaired("m1", "d3")).toBe(false);
    expect(await directory.isPaired("tidak-ada", "d1")).toBe(false);

    directory.unpair("m1", "d1");
    expect(await directory.isPaired("m1", "d1")).toBe(false);
    expect(await directory.devicesOf("m1")).toEqual(["d2"]);
  });

  test("memasangkan dua kali tidak menggandakan, dan mencabut yang tidak ada tidak error", async () => {
    const directory = createMemoryDirectory();
    directory.pair("m1", "d1");
    directory.pair("m1", "d1");
    expect(await directory.devicesOf("m1")).toEqual(["d1"]);
    expect(() => directory.unpair("m9", "d9")).not.toThrow();
  });

  test("daftar yang dikembalikan adalah salinan: mengubahnya tidak memengaruhi direktori", async () => {
    const directory = createMemoryDirectory();
    directory.pair("m1", "d1");
    const list = (await directory.devicesOf("m1")) as string[];
    list.push("d-palsu");
    expect(await directory.isPaired("m1", "d-palsu")).toBe(false);
  });
});

// Kontrak yang SAMA dijalankan juga terhadap direktori database (db/directory.test.ts).
describeDirectoryContract("memori", async () => {
  const directory = createMemoryDirectory();
  return {
    directory,
    addMachine: async (id, token) => directory.addMachine(id, token),
    addDevice: async (id, token) => directory.addDevice(id, token),
    pair: async (machineId, deviceId) => directory.pair(machineId, deviceId),
    unpair: async (machineId, deviceId) => directory.unpair(machineId, deviceId),
  };
});
