import { describe, expect, test } from "vitest";
import { createKeyedRateLimiter, createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  test("lonjakan sebesar kapasitas diizinkan, sisanya ditolak", () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 });
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false, false]);
  });

  test("ember terisi lagi sesuai waktu yang berlalu", () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 2, now: () => clock.ms });
    limiter.take();
    limiter.take();
    expect(limiter.take()).toBe(false);

    clock.ms += 500; // setengah detik = 1 token
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  test("isi ember tidak pernah melebihi kapasitas, walau menunggu lama", () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 10, now: () => clock.ms });
    clock.ms += 3_600_000; // satu jam
    expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false]);
  });

  test("laju rata-rata jangka panjang dibatasi", () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 10, now: () => clock.ms });
    let allowed = 0;
    // Mengirim 100 pesan per detik selama 10 detik.
    for (let i = 0; i < 1000; i++) {
      clock.ms += 10;
      if (limiter.take()) allowed++;
    }
    // Batas teoretis: kapasitas + laju × durasi = 5 + 100 = 105.
    expect(allowed).toBeLessThanOrEqual(105);
    expect(allowed).toBeGreaterThan(90);
  });

  test("jam yang mundur tidak mengisi ember", () => {
    const clock = { ms: 10_000 };
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 100, now: () => clock.ms });
    limiter.take();
    clock.ms = 0; // jam sistem mundur
    expect(limiter.take()).toBe(false);
  });
});

describe("createKeyedRateLimiter", () => {
  test("tiap kunci punya ember sendiri: satu kunci yang habis tidak mengganggu kunci lain", () => {
    const limiter = createKeyedRateLimiter({ capacity: 2, refillPerSecond: 0, now: () => 0 });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect([limiter.take("b"), limiter.take("b"), limiter.take("b")]).toEqual([true, true, false]);
  });

  test("ember tiap kunci terisi lagi sesuai waktu", () => {
    const clock = { ms: 0 };
    const limiter = createKeyedRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => clock.ms });
    expect([limiter.take("a"), limiter.take("a")]).toEqual([true, false]);
    clock.ms = 1000;
    expect(limiter.take("a")).toBe(true);
  });

  test("jumlah kunci dibatasi: yang paling lama tidak dipakai dibuang, yang aktif dipertahankan", () => {
    const limiter = createKeyedRateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0, maxKeys: 2 });
    expect(limiter.take("a")).toBe(true); // a habis
    expect(limiter.take("b")).toBe(true); // b habis
    expect(limiter.take("a")).toBe(false); // a dipakai lagi -> "terbaru"
    expect(limiter.take("c")).toBe(true); // penuh: b (paling lama) dibuang
    expect(limiter.take("a")).toBe(false); // a masih diingat, tetap habis
    expect(limiter.take("b")).toBe(true); // b dilupakan, mulai dari ember penuh
  });
});
