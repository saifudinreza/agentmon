// =====================================================================================
// KONTRAK PERILAKU DIREKTORI PEMASANGAN: dijalankan terhadap SEMUA isi direktori.
// =====================================================================================
//
// Relay (hub.ts) hanya bergantung pada antarmuka RelayDirectory. Supaya isi yang berbeda (versi
// memori dan versi database) bisa saling menggantikan tanpa kejutan, keduanya harus lolos kumpulan
// test yang SAMA. File ini bukan test sendiri; ia dipanggil dari test masing-masing isi.
import { describe, expect, test } from "vitest";
import type { RelayDirectory } from "./directory";

// Cara test menyiapkan data. Isi memori dan isi database punya cara mendaftar yang berbeda
// (sinkron vs asinkron), jadi test hanya memakai penyesuai ini.
export type DirectoryAdapter = {
  directory: RelayDirectory;
  addMachine(id: string, token: string): Promise<void>;
  addDevice(id: string, token: string): Promise<void>;
  pair(machineId: string, deviceId: string): Promise<void>;
  unpair(machineId: string, deviceId: string): Promise<void>;
};

const MACHINE = "machine-token-0000000000000000";
const DEVICE = "device-token-00000000000000000";

export function describeDirectoryContract(name: string, create: () => Promise<DirectoryAdapter>): void {
  describe(`kontrak direktori: ${name}`, () => {
    test("mengenali token yang terdaftar dan menolak yang lain", async () => {
      const d = await create();
      await d.addMachine("m1", MACHINE);
      await d.addDevice("d1", DEVICE);
      expect(await d.directory.authenticate("machine", MACHINE)).toBe("m1");
      expect(await d.directory.authenticate("device", DEVICE)).toBe("d1");
      expect(await d.directory.authenticate("machine", "token-salah-0000000000000000")).toBeUndefined();
      expect(await d.directory.authenticate("device", "")).toBeUndefined();
    });

    test("peran dipisah: token HP tidak berlaku sebagai laptop, dan sebaliknya", async () => {
      const d = await create();
      await d.addMachine("m1", MACHINE);
      await d.addDevice("d1", DEVICE);
      expect(await d.directory.authenticate("device", MACHINE)).toBeUndefined();
      expect(await d.directory.authenticate("machine", DEVICE)).toBeUndefined();
    });

    test("pemasangan: devicesOf dan isPaired konsisten, dan bisa dicabut", async () => {
      const d = await create();
      for (const id of ["m1", "m2"]) await d.addMachine(id, `${id}-token-${"0".repeat(20)}`);
      for (const id of ["d1", "d2", "d3"]) await d.addDevice(id, `${id}-token-${"0".repeat(20)}`);
      await d.pair("m1", "d1");
      await d.pair("m1", "d2");
      await d.pair("m2", "d3");

      expect([...(await d.directory.devicesOf("m1"))].sort()).toEqual(["d1", "d2"]);
      expect(await d.directory.devicesOf("m2")).toEqual(["d3"]);
      expect(await d.directory.devicesOf("tidak-ada")).toEqual([]);
      expect(await d.directory.isPaired("m1", "d1")).toBe(true);
      expect(await d.directory.isPaired("m1", "d3")).toBe(false);
      expect(await d.directory.isPaired("tidak-ada", "d1")).toBe(false);

      await d.unpair("m1", "d1");
      expect(await d.directory.isPaired("m1", "d1")).toBe(false);
      expect(await d.directory.devicesOf("m1")).toEqual(["d2"]);
    });

    test("memasangkan dua kali tidak menggandakan, dan mencabut yang tidak ada tidak error", async () => {
      const d = await create();
      await d.addMachine("m1", MACHINE);
      await d.addDevice("d1", DEVICE);
      await d.pair("m1", "d1");
      await d.pair("m1", "d1");
      expect(await d.directory.devicesOf("m1")).toEqual(["d1"]);
      await expect(d.unpair("m1", "tidak-ada")).resolves.toBeUndefined();
    });

    test("daftar yang dikembalikan adalah salinan: mengubahnya tidak memengaruhi direktori", async () => {
      const d = await create();
      await d.addMachine("m1", MACHINE);
      await d.addDevice("d1", DEVICE);
      await d.pair("m1", "d1");
      const list = (await d.directory.devicesOf("m1")) as string[];
      list.push("d-palsu");
      expect(await d.directory.isPaired("m1", "d-palsu")).toBe(false);
    });
  });
}
