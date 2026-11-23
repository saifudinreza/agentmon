// =====================================================================================
// FILE INI: menyimpan libsodium untuk pemakaian offline TANPA membebani semua pengguna (issue #033).
// =====================================================================================
//
// libsodium (±430 kB) hanya dibutuhkan pengguna E2E dan dimuat belakangan, jadi tidak ikut di-precache (vite.config.ts: globIgnores). Pengguna E2E
// tetap harus bisa membuka aplikasi tanpa jaringan (brankas dibuka SEBELUM layar digambar), jadi saat chunk itu diminta pertama kali ia disimpan
// (cache-first) dan chunk versi lama dibuang. Logikanya murni (cache dan fetch dioper), supaya bisa diuji tanpa service worker sungguhan.
export const SODIUM_CACHE = "agentmon-libsodium";
const SODIUM_CHUNK = /\/assets\/libsodium-[^/]+\.js$/;

type CacheLike = {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  keys(): Promise<Array<{ url: string }>>;
  delete(request: string | { url: string }): Promise<boolean>;
};
export type CacheStorageLike = { open(name: string): Promise<CacheLike> };

/** Menjawab permintaan chunk libsodium dari cache (atau jaringan lalu disimpan). undefined = bukan urusan kita (biarkan lewat). */
export function handleSodiumFetch(request: { url: string; method: string }, origin: string, caches: CacheStorageLike, doFetch: (url: string) => Promise<Response>): Promise<Response> | undefined {
  if (request.method !== "GET") return undefined;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || !SODIUM_CHUNK.test(url.pathname)) return undefined;
  return (async () => {
    const cache = await caches.open(SODIUM_CACHE);
    const hit = await cache.match(request.url);
    if (hit) return hit;
    const response = await doFetch(request.url);
    if (response.ok) {
      await cache.put(request.url, response.clone());
      // chunk versi lama (nama berkas berhash) dibuang
      for (const key of await cache.keys()) if (key.url !== request.url) await cache.delete(key);
    }
    return response;
  })();
}
