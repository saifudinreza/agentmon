import { describe, expect, test } from "vitest";
import { createRateLimiter } from "./rate-limit";

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
