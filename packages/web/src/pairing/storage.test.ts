import { describe, expect, test } from "vitest";
import { findPairing, loadPairings, normalizeRelayUrl, PAIRINGS_STORAGE_KEY, removePairing, savePairing } from "./storage";

const TOKEN = "t".repeat(64);
const machine = (id: string, name = `Laptop ${id}`) => ({ id, name, pairedAt: "2026-11-11T10:00:00.000Z" });

// Penyimpanan tiruan sederhana (Map), bisa diatur gagal.
function memoryStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[PAIRINGS_STORAGE_KEY, initial]]);
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("normalizeRelayUrl", () => {
  test.each([
    ["https://relay.contoh.com", "https://relay.contoh.com"],
    ["https://Relay.Contoh.com/", "https://relay.contoh.com"],
    ["https://relay.contoh.com///", "https://relay.contoh.com"],
    ["https://relay.contoh.com:8443/awalan/", "https://relay.contoh.com:8443/awalan"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["https://relay.contoh.com/?x=1#y", "https://relay.contoh.com"],
  ])("%s -> %s", (input, expected) => expect(normalizeRelayUrl(input)).toBe(expected));

  test.each(["bukan-alamat", "ftp://x.com", "javascript:alert(1)", ""])("menolak %j", (input) => {
    expect(normalizeRelayUrl(input)).toBeUndefined();
  });
});

describe("loadPairings", () => {
  test("kosong bila belum ada apa pun, atau penyimpanan tidak ada", () => {
    expect(loadPairings(memoryStorage())).toEqual([]);
    expect(loadPairings(undefined)).toEqual([]);
  });

  test.each([
    ["bukan JSON", "{rusak"],
    ["null", "null"],
    ["angka", "5"],
    ["versi tidak dikenal", JSON.stringify({ v: 2, pairings: [] })],
    ["tanpa pairings", JSON.stringify({ v: 1 })],
    ["token terlalu pendek", JSON.stringify({ v: 1, pairings: [{ relayUrl: "https://r", deviceId: "d", deviceToken: "pendek", machines: [] }] })],
    ["laptop tanpa nomor", JSON.stringify({ v: 1, pairings: [{ relayUrl: "https://r", deviceId: "d", deviceToken: TOKEN, machines: [{ name: "x", pairedAt: "y" }] }] })],
  ])("data rusak atau tak dikenal dianggap kosong, bukan membuat aplikasi gagal: %s", (_name, raw) => {
    expect(loadPairings(memoryStorage(raw))).toEqual([]);
  });

  test("penyimpanan yang melempar galat saat dibaca dianggap kosong", () => {
    expect(
      loadPairings({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toEqual([]);
  });
});

describe("savePairing", () => {
  test("menyimpan perangkat baru beserta laptopnya, dan bisa dibaca kembali", () => {
    const storage = memoryStorage();
    const saved = savePairing(storage, { relayUrl: "https://relay.contoh.com/", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") });
    expect(saved).toEqual({ relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: TOKEN, machines: [machine("m1")] });
    expect(loadPairings(storage)).toEqual([saved]);
  });

  test("laptop kedua di relay yang sama memakai token yang sama dan ditambahkan ke daftar", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") });
    const second = savePairing(storage, { relayUrl: "https://RELAY.contoh.com/", deviceId: "d1", machine: machine("m2") }); // tanpa token baru
    expect(second?.deviceToken).toBe(TOKEN);
    expect(second?.machines.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loadPairings(storage)).toHaveLength(1);
  });

  test("laptop yang sama dipasangkan lagi diperbarui, tidak ganda", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1", "Nama Lama") });
    const again = savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d1", machine: machine("m1", "Nama Baru") });
    expect(again?.machines).toEqual([machine("m1", "Nama Baru")]);
  });

  test("relay berbeda punya catatan sendiri, dengan token masing-masing", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://a.contoh.com", deviceId: "da", deviceToken: "a".repeat(64), machine: machine("m1") });
    savePairing(storage, { relayUrl: "https://b.contoh.com", deviceId: "db", deviceToken: "b".repeat(64), machine: machine("m2") });
    const all = loadPairings(storage);
    expect(all.map((p) => p.deviceToken)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(findPairing(all, "https://B.contoh.com/")?.deviceId).toBe("db");
    expect(findPairing(all, "https://c.contoh.com")).toBeUndefined();
  });

  test("token baru menggantikan yang lama (perangkat didaftarkan ulang setelah dicabut)", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: "a".repeat(64), machine: machine("m1") });
    const renewed = savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d2", deviceToken: "b".repeat(64), machine: machine("m1") });
    expect(renewed).toMatchObject({ deviceId: "d2", deviceToken: "b".repeat(64) });
    expect(loadPairings(storage)).toHaveLength(1);
  });

  test("tanpa token sama sekali tidak ada yang disimpan", () => {
    const storage = memoryStorage();
    expect(savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d1", machine: machine("m1") })).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  test("alamat relay yang tidak sah tidak disimpan", () => {
    const storage = memoryStorage();
    expect(savePairing(storage, { relayUrl: "bukan-alamat", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") })).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  test("penyimpanan yang melempar galat (penuh atau diblokir): mengembalikan undefined, bukan melempar", () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(savePairing(full, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") })).toBeUndefined();
  });

  test("penyimpanan yang diam-diam tidak menyimpan (mode privat tertentu) ketahuan lewat pembacaan ulang", () => {
    const blackHole = { getItem: () => null, setItem: () => undefined };
    expect(savePairing(blackHole, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") })).toBeUndefined();
  });

  test("tanpa penyimpanan sama sekali: undefined", () => {
    expect(savePairing(undefined, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") })).toBeUndefined();
  });

  test("token tersimpan hanya di satu tempat dan tidak ikut ke bagian lain berkas", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://r.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: machine("m1") });
    expect(storage.data.get(PAIRINGS_STORAGE_KEY)?.split(TOKEN).length).toBe(2); // muncul tepat sekali
  });
});

describe("removePairing", () => {
  test("membuang catatan satu relay dan membiarkan yang lain", () => {
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://a.contoh.com", deviceId: "da", deviceToken: "a".repeat(64), machine: machine("m1") });
    savePairing(storage, { relayUrl: "https://b.contoh.com", deviceId: "db", deviceToken: "b".repeat(64), machine: machine("m2") });
    removePairing(storage, "https://A.contoh.com/");
    expect(loadPairings(storage).map((p) => p.deviceId)).toEqual(["db"]);
  });

  test("relay yang tidak ada, penyimpanan kosong, atau penyimpanan yang gagal: tidak melempar", () => {
    expect(() => removePairing(memoryStorage(), "https://x.contoh.com")).not.toThrow();
    expect(() => removePairing(undefined, "https://x.contoh.com")).not.toThrow();
    const storage = memoryStorage();
    savePairing(storage, { relayUrl: "https://a.contoh.com", deviceId: "da", deviceToken: TOKEN, machine: machine("m1") });
    const failing = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(() => removePairing(failing, "https://a.contoh.com")).not.toThrow();
  });
});
