import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { hashToken } from "../directory";
import type { DatabaseHandle } from "./connect";
import { createDbDirectory, type DbDirectory } from "./directory";
import { createPairingService, type PairingService } from "./pairing";
import { createTestDatabase, query, resetDatabase } from "./testing";

const MIN = 60_000;
let handle: DatabaseHandle;
let directory: DbDirectory;
let pairing: PairingService;
const clock = { ms: Date.parse("2026-11-11T00:00:00Z") };

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000); // memulai PGlite + migrasi bisa lambat saat banyak berkas test berjalan bersamaan
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  clock.ms = Date.parse("2026-11-11T00:00:00Z");
  const now = () => new Date(clock.ms);
  directory = createDbDirectory(handle.db, { now });
  pairing = createPairingService(handle.db, { now });
  await directory.registerMachine({ id: "m1", name: "Laptop Kantor", token: "machine-token-0000000000000000" });
});

async function newCode(machineId = "m1"): Promise<string> {
  const result = await pairing.createCode(machineId);
  if (!result.ok) throw new Error(`gagal membuat kode: ${result.reason}`);
  return result.code;
}

describe("createCode", () => {
  test("menghasilkan kode acak yang panjang, tidak pernah sama, dan berlaku 5 menit", async () => {
    const a = await pairing.createCode("m1");
    const b = await pairing.createCode("m1");
    if (!a.ok || !b.ok) throw new Error("harus berhasil");
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.expiresAt.getTime()).toBe(clock.ms + 5 * MIN);
  });

  test("yang disimpan HANYA hash-nya; kode mentah tidak ada di database", async () => {
    const code = await newCode();
    const rows = await query(handle.db, sql`select code_hash from pairing_codes`);
    expect(rows).toEqual([{ code_hash: hashToken(code) }]);
    expect(JSON.stringify(await query(handle.db, sql`select * from pairing_codes`))).not.toContain(code);
  });

  test("laptop yang tidak dikenal ditolak", async () => {
    expect(await pairing.createCode("tidak-ada")).toEqual({ ok: false, reason: "unknown-machine" });
  });

  test("dibatasi 5 kode aktif per laptop; kode yang terpakai atau kedaluwarsa tidak dihitung", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push(await newCode());
    expect(await pairing.createCode("m1")).toEqual({ ok: false, reason: "too-many-codes" });

    // Satu dipakai -> ada tempat lagi.
    await pairing.redeem({ code: codes[0] as string, name: "HP" });
    expect((await pairing.createCode("m1")).ok).toBe(true);
    expect(await pairing.createCode("m1")).toEqual({ ok: false, reason: "too-many-codes" });

    // Semua kedaluwarsa -> ada tempat lagi.
    clock.ms += 6 * MIN;
    expect((await pairing.createCode("m1")).ok).toBe(true);
  });

  test("batas dihitung per laptop: laptop lain tidak terganggu", async () => {
    await directory.registerMachine({ id: "m2", name: "Laptop Rumah", token: "machine-token-1111111111111111" });
    for (let i = 0; i < 5; i++) await newCode("m1");
    expect((await pairing.createCode("m2")).ok).toBe(true);
  });

  test("permintaan serentak tidak bisa melampaui batas (balapan)", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => pairing.createCode("m1")));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
    expect(Number((await query(handle.db, sql`select count(*)::int as n from pairing_codes`))[0]?.n)).toBe(5);
  });
});

describe("redeem", () => {
  test("menukar kode menjadi perangkat baru yang langsung dipasangkan dan bisa tersambung", async () => {
    const code = await newCode();
    const result = await pairing.redeem({ code, name: "iPhone Budi" });
    if (!result.ok) throw new Error("harus berhasil");

    expect(result).toMatchObject({ machineId: "m1", machineName: "Laptop Kantor" });
    expect(result.deviceToken).toMatch(/^[0-9a-f]{64}$/);
    // Kredensialnya benar-benar bekerja di direktori yang dipakai relay.
    expect(await directory.authenticate("device", result.deviceToken as string)).toBe(result.deviceId);
    expect(await directory.isPaired("m1", result.deviceId)).toBe(true);
    expect(await directory.devicesOf("m1")).toEqual([result.deviceId]);
  });

  test("token perangkat hanya tersimpan sebagai hash", async () => {
    const result = await pairing.redeem({ code: await newCode(), name: "HP" });
    if (!result.ok) throw new Error("harus berhasil");
    const stored = JSON.stringify(await query(handle.db, sql`select * from devices`));
    expect(stored).toContain(hashToken(result.deviceToken as string));
    expect(stored).not.toContain(result.deviceToken as string);
  });

  test("kode hanya bisa dipakai SEKALI", async () => {
    const code = await newCode();
    expect((await pairing.redeem({ code, name: "HP pertama" })).ok).toBe(true);
    expect(await pairing.redeem({ code, name: "HP kedua" })).toEqual({ ok: false, reason: "invalid-code" });
    expect(Number((await query(handle.db, sql`select count(*)::int as n from devices`))[0]?.n)).toBe(1);
  });

  test("dua HP menukar kode yang sama BERSAMAAN: hanya satu yang berhasil (atomik)", async () => {
    const code = await newCode();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => pairing.redeem({ code, name: `HP ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(Number((await query(handle.db, sql`select count(*)::int as n from devices`))[0]?.n)).toBe(1);
    expect(Number((await query(handle.db, sql`select count(*)::int as n from pairings`))[0]?.n)).toBe(1);
  });

  test("kode kedaluwarsa ditolak, tepat di batas waktunya juga", async () => {
    const code = await newCode();
    clock.ms += 5 * MIN - 1;
    const justBefore = await pairing.createCode("m1"); // sekadar memastikan jam bergerak tidak merusak apa pun
    expect(justBefore.ok).toBe(true);

    clock.ms += 1; // tepat 5 menit: batasnya sudah lewat (expires_at > now harus benar)
    expect(await pairing.redeem({ code, name: "HP" })).toEqual({ ok: false, reason: "invalid-code" });
  });

  test("kode yang masih berlaku 1 milidetik sebelum batas diterima", async () => {
    const code = await newCode();
    clock.ms += 5 * MIN - 1;
    expect((await pairing.redeem({ code, name: "HP" })).ok).toBe(true);
  });

  test("kode yang tidak dikenal, kosong, atau hash dari kode lain ditolak dengan jawaban yang sama", async () => {
    const code = await newCode();
    const unknown = await pairing.redeem({ code: "x".repeat(32), name: "HP" });
    const expiredLike = await (async () => {
      clock.ms += 10 * MIN;
      return pairing.redeem({ code, name: "HP" });
    })();
    expect(unknown).toEqual(expiredLike); // tidak bisa dibedakan: "tidak pernah ada" vs "sudah kedaluwarsa"
    expect(unknown).toEqual({ ok: false, reason: "invalid-code" });
  });

  test("kode yang gagal tidak mengubah apa pun di database", async () => {
    await pairing.redeem({ code: "x".repeat(32), name: "HP" });
    for (const table of ["devices", "pairings"]) {
      expect(Number((await query(handle.db, sql.raw(`select count(*)::int as n from ${table}`)))[0]?.n)).toBe(0);
    }
  });

  describe("satu HP untuk beberapa laptop", () => {
    beforeEach(async () => {
      await directory.registerMachine({ id: "m2", name: "Laptop Rumah", token: "machine-token-1111111111111111" });
    });

    test("HP yang sudah punya kredensial dipasangkan ke laptop kedua tanpa perangkat baru", async () => {
      const first = await pairing.redeem({ code: await newCode("m1"), name: "iPhone Budi" });
      if (!first.ok) throw new Error("harus berhasil");

      const second = await pairing.redeem({
        code: await newCode("m2"),
        name: "iPhone Budi",
        existingDeviceToken: first.deviceToken as string,
      });
      if (!second.ok) throw new Error("harus berhasil");

      expect(second.deviceId).toBe(first.deviceId); // perangkat yang sama
      expect(second.deviceToken).toBeUndefined(); // tidak diberi kredensial baru
      expect(second.machineId).toBe("m2");
      expect(await directory.isPaired("m1", first.deviceId)).toBe(true);
      expect(await directory.isPaired("m2", first.deviceId)).toBe(true);
      expect(Number((await query(handle.db, sql`select count(*)::int as n from devices`))[0]?.n)).toBe(1);
    });

    test("token HP yang salah ditolak DAN tidak menghanguskan kode milik laptop", async () => {
      const code = await newCode("m2");
      expect(await pairing.redeem({ code, name: "HP", existingDeviceToken: "token-salah-0000000000000000" })).toEqual({
        ok: false,
        reason: "invalid-device",
      });
      // Kode masih utuh: pemilik laptop tidak perlu membuat ulang.
      expect((await pairing.redeem({ code, name: "HP" })).ok).toBe(true);
    });

    test("HP yang sudah dicabut tidak bisa dipakai untuk memasangkan laptop lagi", async () => {
      const first = await pairing.redeem({ code: await newCode("m1"), name: "HP" });
      if (!first.ok) throw new Error("harus berhasil");
      await directory.revokeDevice(first.deviceId);
      const result = await pairing.redeem({ code: await newCode("m2"), name: "HP", existingDeviceToken: first.deviceToken as string });
      expect(result).toEqual({ ok: false, reason: "invalid-device" });
    });

    test("memasangkan perangkat yang sama ke laptop yang sama dua kali tidak menggandakan", async () => {
      const first = await pairing.redeem({ code: await newCode("m1"), name: "HP" });
      if (!first.ok) throw new Error("harus berhasil");
      const again = await pairing.redeem({ code: await newCode("m1"), name: "HP", existingDeviceToken: first.deviceToken as string });
      expect(again.ok).toBe(true);
      expect(await directory.devicesOf("m1")).toEqual([first.deviceId]);
    });
  });
});

describe("listDevices", () => {
  test("memuat HP yang terpasang, berurutan menurut waktu pasang, dan tidak memuat yang dicabut", async () => {
    const a = await pairing.redeem({ code: await newCode(), name: "HP A" });
    clock.ms += 1000;
    const b = await pairing.redeem({ code: await newCode(), name: "HP B" });
    if (!a.ok || !b.ok) throw new Error("harus berhasil");

    const listed = await pairing.listDevices("m1");
    expect(listed.map((d) => d.name)).toEqual(["HP A", "HP B"]);
    expect(listed[0]).toMatchObject({ id: a.deviceId });
    expect(new Date(listed[0]?.pairedAt as string).getTime()).toBe(Date.parse("2026-11-11T00:00:00Z"));

    await directory.revokeDevice(a.deviceId);
    expect((await pairing.listDevices("m1")).map((d) => d.name)).toEqual(["HP B"]);
  });

  test("hanya HP milik laptop itu; laptop lain mendapat daftar kosong", async () => {
    await directory.registerMachine({ id: "m2", name: "Lain", token: "machine-token-1111111111111111" });
    await pairing.redeem({ code: await newCode("m1"), name: "HP" });
    expect(await pairing.listDevices("m2")).toEqual([]);
  });
});
