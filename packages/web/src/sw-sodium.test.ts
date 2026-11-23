import { describe, expect, test } from "vitest";
import { handleSodiumFetch, SODIUM_CACHE, type CacheStorageLike } from "./sw-sodium";

const ORIGIN = "https://agentmon.contoh.com";

function fakeCaches() {
  const store = new Map<string, Response>();
  const opened: string[] = [];
  const storage: CacheStorageLike = {
    open: async (name) => {
      opened.push(name);
      return {
        match: async (url) => store.get(url)?.clone(),
        put: async (url, response) => void store.set(url, response),
        keys: async () => [...store.keys()].map((url) => ({ url })),
        delete: async (key) => store.delete(typeof key === "string" ? key : key.url),
      };
    },
  };
  return { storage, store, opened };
}

describe("cache libsodium untuk pemakaian offline", () => {
  test("hanya chunk libsodium dari asal sendiri dengan GET yang ditangani; yang lain dibiarkan lewat (undefined)", () => {
    const { storage } = fakeCaches();
    const fetchFn = async () => new Response("x");
    expect(handleSodiumFetch({ url: `${ORIGIN}/assets/index-1.js`, method: "GET" }, ORIGIN, storage, fetchFn)).toBeUndefined();
    expect(handleSodiumFetch({ url: `${ORIGIN}/assets/libsodium-wrappers-1.js`, method: "POST" }, ORIGIN, storage, fetchFn)).toBeUndefined();
    expect(handleSodiumFetch({ url: "https://lain.example/assets/libsodium-wrappers-1.js", method: "GET" }, ORIGIN, storage, fetchFn)).toBeUndefined();
    expect(handleSodiumFetch({ url: "bukan url", method: "GET" }, ORIGIN, storage, fetchFn)).toBeUndefined();
    expect(handleSodiumFetch({ url: `${ORIGIN}/assets/libsodium-wrappers-1.js.map`, method: "GET" }, ORIGIN, storage, fetchFn)).toBeUndefined();
  });

  test("pertama kali: diambil dari jaringan lalu disimpan; berikutnya dari cache tanpa jaringan (offline)", async () => {
    const { storage, store, opened } = fakeCaches();
    let network = 0;
    const url = `${ORIGIN}/assets/libsodium-wrappers-AAA.js`;
    const fetchFn = async () => (network += 1, new Response("isi-libsodium"));
    const first = await handleSodiumFetch({ url, method: "GET" }, ORIGIN, storage, fetchFn)!;
    expect(await first.text()).toBe("isi-libsodium");
    expect(network).toBe(1);
    expect(store.has(url)).toBe(true);
    expect(opened).toEqual([SODIUM_CACHE]);
    const offline = await handleSodiumFetch({ url, method: "GET" }, ORIGIN, storage, async () => { throw new Error("offline"); })!;
    expect(await offline.text()).toBe("isi-libsodium");
    expect(network).toBe(1);
  });

  test("versi baru (nama berhash berbeda) menyimpan yang baru dan MEMBUANG yang lama", async () => {
    const { storage, store } = fakeCaches();
    const fetchFn = async () => new Response("x");
    await handleSodiumFetch({ url: `${ORIGIN}/assets/libsodium-wrappers-AAA.js`, method: "GET" }, ORIGIN, storage, fetchFn);
    await handleSodiumFetch({ url: `${ORIGIN}/assets/libsodium-wrappers-BBB.js`, method: "GET" }, ORIGIN, storage, fetchFn);
    expect([...store.keys()]).toEqual([`${ORIGIN}/assets/libsodium-wrappers-BBB.js`]);
  });

  test("jawaban galat (404/500) tidak disimpan", async () => {
    const { storage, store } = fakeCaches();
    const response = await handleSodiumFetch({ url: `${ORIGIN}/assets/libsodium-wrappers-AAA.js`, method: "GET" }, ORIGIN, storage, async () => new Response("tidak ada", { status: 404 }))!;
    expect(response.status).toBe(404);
    expect(store.size).toBe(0);
  });
});
