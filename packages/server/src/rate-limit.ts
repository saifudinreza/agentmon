// =====================================================================================
// FILE INI: pembatas laju = "EMBER BERLUBANG" untuk pesan.
// =====================================================================================
//
// Setiap koneksi punya satu ember berisi sejumlah "token". Mengirim satu pesan mengambil satu
// token. Ember terisi lagi pelan-pelan dengan kecepatan tetap. Bila ember kosong, pesan
// ditolak. Hasilnya:
//   - lonjakan singkat tetap boleh (selama ember masih ada isinya),
//   - tetapi laju rata-rata dalam jangka panjang dibatasi.
// Tanpa ini, satu klien yang rusak atau jahat bisa membanjiri relay dan merugikan semua orang.
//
// Waktu diberikan dari luar (`now`), supaya test tidak perlu menunggu waktu sungguhan.
export type RateLimiter = {
  // Mencoba mengambil satu token. true = boleh, false = ember kosong.
  take(): boolean;
};

export type RateLimiterOptions = {
  capacity: number; // isi ember penuh (jumlah lonjakan terbesar)
  refillPerSecond: number; // token yang bertambah tiap detik
  now?: () => number; // pembaca jam dalam milidetik
};

/**
 * Satu ember per KUNCI (misalnya alamat IP atau nomor laptop). Jumlah kunci dibatasi supaya
 * memorinya tidak bisa dibengkakkan: bila penuh, kunci yang paling lama dilihat dibuang.
 */
export type KeyedRateLimiter = { take(key: string): boolean };

export function createKeyedRateLimiter(options: RateLimiterOptions & { maxKeys?: number }): KeyedRateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, RateLimiter>();
  return {
    take(key) {
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key); // dimasukkan ulang di bawah supaya urutannya "terbaru dipakai"
      } else {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value as string);
        bucket = createRateLimiter(options);
      }
      buckets.set(key, bucket);
      return bucket.take();
    },
  };
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  let tokens = options.capacity;
  let last = now();

  return {
    take() {
      // Isi ulang sesuai waktu yang berlalu, tetapi tidak melebihi kapasitas.
      const current = now();
      const elapsedSeconds = Math.max(0, current - last) / 1000;
      last = current;
      tokens = Math.min(options.capacity, tokens + elapsedSeconds * options.refillPerSecond);

      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
