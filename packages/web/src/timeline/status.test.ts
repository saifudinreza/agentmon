import { describe, expect, test } from "vitest";
import { IDLE_AFTER_MS, sessionState } from "./status";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("sessionState", () => {
  test("sesi yang sudah berakhir tetap 'ended', berapa pun umurnya", () => {
    expect(sessionState({ status: "ended", lastEventAt: ago(0) }, NOW)).toBe("ended");
    expect(sessionState({ status: "ended", lastEventAt: ago(IDLE_AFTER_MS * 100) }, NOW)).toBe("ended");
  });

  test("sesi aktif dengan kabar baru-baru ini 'active'", () => {
    expect(sessionState({ status: "active", lastEventAt: ago(0) }, NOW)).toBe("active");
    expect(sessionState({ status: "active", lastEventAt: ago(IDLE_AFTER_MS) }, NOW)).toBe("active"); // tepat di batas
  });

  test("sesi 'active' tanpa kabar lebih lama dari batas ditampilkan 'idle' (sesi yang mati mendadak tidak Aktif selamanya)", () => {
    expect(sessionState({ status: "active", lastEventAt: ago(IDLE_AFTER_MS + 1) }, NOW)).toBe("idle");
    expect(sessionState({ status: "active", lastEventAt: ago(24 * 3_600_000) }, NOW)).toBe("idle");
  });

  test("waktu yang tidak terbaca tidak membuat sesi tampak aktif", () => {
    expect(sessionState({ status: "active", lastEventAt: "bukan tanggal" }, NOW)).toBe("idle");
    expect(sessionState({ status: "active", lastEventAt: "" }, NOW)).toBe("idle");
  });

  test("waktu di masa depan (jam HP dan laptop tidak sinkron) masih 'active'", () => {
    expect(sessionState({ status: "active", lastEventAt: ago(-3_600_000) }, NOW)).toBe("active");
  });
});
