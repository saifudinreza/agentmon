import { PushPayloadSchema, type Envelope, type PendingApproval, type PushPayload } from "@agentmon/shared";
import { describe, expect, test, vi } from "vitest";
import { createNotifier, DEFAULT_APPROVAL_WINDOW_MS, DEFAULT_DONE_WINDOW_MS, notifyAfterSave, pendingLookup, type NotifierOptions, type NotifyDecision } from "./notifier";

const SECRET = "SANGAT-RAHASIA-rm -rf / --token=abc123XYZ";
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// Pengatur waktu maya: jendela berjalan hanya saat tes memajukan jam.
function virtualClock() {
  let now = 0;
  const tasks: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    schedule: ((fn: () => void, ms: number) => {
      const task = { at: now + ms, fn, cancelled: false };
      tasks.push(task);
      return { cancel: () => void (task.cancelled = true) };
    }) as NonNullable<NotifierOptions["schedule"]>,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = tasks.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.cancelled = true;
        due.fn();
        await settle();
      }
      now = target;
      await settle();
    },
    pendingTimers: () => tasks.filter((t) => !t.cancelled).length,
  };
}

const approval = (id: string, sessionId = "s1", machineId = "m1"): PendingApproval => ({
  machineId,
  sessionId,
  approvalId: id,
  toolName: "Bash",
  // Isi yang BERBAHAYA untuk bocor: perintah dan rahasia. Tidak boleh ada di push mana pun.
  toolInput: { command: SECRET },
  summary: SECRET,
  requestedAt: "2026-11-15T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
});

function setup(extra: Partial<NotifierOptions> = {}) {
  const clock = virtualClock();
  const pushes: Array<{ machineId: string; payload: PushPayload }> = [];
  const logs: string[] = [];
  const waiting: PendingApproval[] = [];
  const notifier = createNotifier({
    push: { notifyMachine: vi.fn(async (machineId: string, payload: PushPayload) => (pushes.push({ machineId, payload }), { attempted: 1, delivered: 1, removed: 0, failed: 0 })) },
    pending: async (machineId, sessionId) => waiting.filter((p) => p.machineId === machineId && p.sessionId === sessionId),
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    schedule: clock.schedule,
    ...extra,
  });
  const requested = (id: string, sessionId = "s1", machineId = "m1") => {
    waiting.push(approval(id, sessionId, machineId));
    notifier.onEvent({ type: "approval.requested", machineId, sessionId });
  };
  const resolved = (id: string, sessionId = "s1") => {
    const i = waiting.findIndex((p) => p.approvalId === id && p.sessionId === sessionId);
    if (i >= 0) waiting.splice(i, 1);
    notifier.onEvent({ type: "approval.resolved", machineId: "m1", sessionId });
  };
  return { notifier, clock, pushes, logs, waiting, requested, resolved };
}

describe("izin yang menunggu", () => {
  test("satu permintaan: langsung satu notifikasi, dengan nomor izin dan jumlah 1", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    expect(t.pushes).toEqual([{ machineId: "m1", payload: { v: 1, kind: "approval", machineId: "m1", sessionId: "s1", count: 1, approvalId: "a1" } }]);
  });

  test("SEPULUH permintaan yang datang sekaligus menjadi SATU notifikasi dengan jumlah 10 (kiriman langsung menghitung semuanya)", async () => {
    const t = setup();
    for (let i = 1; i <= 10; i++) t.requested(`a${i}`);
    await settle();
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]!.payload).toMatchObject({ kind: "approval", count: 10 });
    expect("approvalId" in t.pushes[0]!.payload).toBe(false); // lebih dari satu: tidak menunjuk satu izin
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 5);
    expect(t.pushes).toHaveLength(1);
  });

  test("SEPULUH permintaan beruntun yang datang bertahap tidak menjadi sepuluh notifikasi: satu langsung, satu ringkasan sesudah jendela", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    expect(t.pushes).toHaveLength(1); // yang pertama langsung (jumlah 1)
    expect(t.pushes[0]!.payload).toMatchObject({ count: 1, approvalId: "a1" });
    for (let i = 2; i <= 10; i++) t.requested(`a${i}`);
    await settle();
    expect(t.pushes).toHaveLength(1); // sisanya hanya menandai
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(2); // satu ringkasan, bukan sembilan
    expect(t.pushes[1]!.payload).toMatchObject({ kind: "approval", count: 10 });
    expect("approvalId" in t.pushes[1]!.payload).toBe(false);
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 5);
    expect(t.pushes).toHaveLength(2); // tidak ada kiriman lagi
  });

  test("permintaan yang datang terus-menerus dibatasi: paling banyak satu pesan per jendela", async () => {
    const t = setup();
    t.requested("a0");
    await settle();
    for (let window = 1; window <= 6; window++) {
      for (let i = 0; i < 20; i++) t.requested(`w${window}-${i}`);
      await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    }
    // 1 langsung + 6 ringkasan, bukan 121 notifikasi.
    expect(t.pushes.length).toBeLessThanOrEqual(7);
    expect(t.pushes.length).toBeGreaterThan(1);
  });

  test("permintaan baru SESUDAH jendela sepi dikirim langsung lagi", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 2);
    t.resolved("a1");
    t.requested("a2");
    await settle();
    expect(t.pushes).toHaveLength(2);
    expect(t.pushes[1]!.payload).toMatchObject({ approvalId: "a2", count: 1 });
  });

  test("semuanya sudah diputuskan sebelum jendela berakhir: tidak ada ringkasan yang dikirim", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    t.requested("a2");
    t.requested("a3");
    t.resolved("a1");
    t.resolved("a2");
    t.resolved("a3");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(1);
  });

  test("ringkasan dengan himpunan yang sama dengan yang terakhir dikirim tidak dikirim ulang", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    t.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" }); // kejadian tanpa perubahan nyata
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(1);
  });

  test("hanya satu yang tersisa setelah yang lain diputuskan: ringkasan menunjuk izin itu dan jumlah 1", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    t.requested("a2");
    t.resolved("a1");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes[1]!.payload).toMatchObject({ count: 1, approvalId: "a2" });
  });

  test("sesi berbeda dan laptop berbeda punya jendela sendiri-sendiri (tidak saling menahan)", async () => {
    const t = setup();
    t.requested("a1", "s1", "m1");
    t.requested("b1", "s2", "m1");
    t.requested("c1", "s1", "m2");
    await settle();
    expect(t.pushes.map((p) => `${p.machineId}/${p.payload.sessionId}`).sort()).toEqual(["m1/s1", "m1/s2", "m2/s1"]);
  });

  test("hanya kejadian yang relevan memicu: event lain, termasuk yang sudah diputuskan, tidak membunyikan HP", async () => {
    const t = setup();
    for (const type of ["approval.resolved", "approval.auto_resolved", "tool.requested", "tool.completed", "session.recap", "checkpoint.created", "agent.notification", "tidak.dikenal", ""]) {
      t.notifier.onEvent({ type, machineId: "m1", sessionId: "s1" });
    }
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 3);
    expect(t.pushes).toEqual([]);
    expect(t.clock.pendingTimers()).toBe(0);
  });
});

describe("agent selesai", () => {
  test("satu notifikasi, hanya nomor: tanpa jumlah dan tanpa nomor izin", async () => {
    const t = setup();
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(t.pushes).toEqual([{ machineId: "m1", payload: { v: 1, kind: "done", machineId: "m1", sessionId: "s1" } }]);
  });

  test("agent berhenti di akhir setiap giliran: giliran beruntun digabung (jendela 60 detik), bukan satu per giliran", async () => {
    const t = setup();
    for (let i = 0; i < 8; i++) t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(t.pushes).toHaveLength(1);
    await t.clock.advance(DEFAULT_DONE_WINDOW_MS);
    expect(t.pushes).toHaveLength(2); // satu pesan lagi untuk yang berikutnya, bukan tujuh
    await t.clock.advance(DEFAULT_DONE_WINDOW_MS * 3);
    expect(t.pushes).toHaveLength(2);
  });

  test("jendela selesai (60 detik) lebih panjang dari jendela izin (10 detik): ringkasan belum keluar di detik ke-10", async () => {
    const t = setup();
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await settle();
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(1); // jendela izin sudah lewat, jendela selesai belum
    await t.clock.advance(DEFAULT_DONE_WINDOW_MS - DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(2);
  });

  test("jendela izin dan jendela selesai terpisah: izin tidak ditahan oleh 'selesai' dan sebaliknya", async () => {
    const t = setup();
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    t.requested("a1");
    await settle();
    expect(t.pushes.map((p) => p.payload.kind).sort()).toEqual(["approval", "done"]);
  });
});

describe("hasil review PR #61", () => {
  test("S2: izin yang ditolak penyaring TIDAK dianggap sudah diberitahukan; ringkasan berikutnya dengan himpunan sama tetap dikirim", async () => {
    let allow = false;
    const t = setup({ filter: () => allow });
    t.requested("a1");
    await settle();
    expect(t.pushes).toEqual([]);
    allow = true;
    // Permintaan baru yang langsung selesai: A tetap satu-satunya yang menunggu.
    t.requested("a2");
    t.resolved("a2");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]!.payload).toMatchObject({ count: 1, approvalId: "a1" });
  });

  test("pengiriman yang GAGAL (melempar) tidak mencatat izin sebagai sudah diberitahukan: dicoba lagi", async () => {
    const notifyMachine = vi.fn().mockRejectedValueOnce(new Error("layanan push mati")).mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, failed: 0 });
    const t = setup({ push: { notifyMachine } });
    t.requested("a1");
    await settle();
    t.requested("a2");
    t.resolved("a2");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(notifyMachine).toHaveBeenCalledTimes(2);
    expect(notifyMachine.mock.calls[1]![1]).toMatchObject({ approvalId: "a1" });
  });

  test("pengiriman yang sebagian GAGAL (failed > 0) juga tidak dicatat sebagai sudah diberitahukan", async () => {
    const notifyMachine = vi.fn().mockResolvedValueOnce({ attempted: 2, delivered: 1, removed: 0, failed: 1 }).mockResolvedValue({ attempted: 2, delivered: 2, removed: 0, failed: 0 });
    const t = setup({ push: { notifyMachine } });
    t.requested("a1");
    await settle();
    t.requested("a2");
    t.resolved("a2");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(notifyMachine).toHaveBeenCalledTimes(2);
  });

  test("S1: kiriman pertama yang tidak menghasilkan apa-apa tidak membuka jendela: izin berikutnya langsung dikirim, bukan menunggu 10 detik", async () => {
    const t = setup();
    // Permintaan pertama sudah selesai saat dihitung: tidak ada yang dikirim.
    t.requested("a1");
    t.resolved("a1");
    await settle();
    expect(t.pushes).toEqual([]);
    expect(t.clock.pendingTimers()).toBe(0); // jendela tidak tersisa
    t.requested("b1"); // 1 detik kemudian: harus langsung
    await settle();
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]!.payload).toMatchObject({ approvalId: "b1" });
  });

  test("tidak ada HP yang mau (attempted 0, mis. semua mematikan jenis ini): jendela ditutup supaya kejadian berikutnya dievaluasi lagi", async () => {
    const notifyMachine = vi.fn().mockResolvedValueOnce({ attempted: 0, delivered: 0, removed: 0, failed: 0 }).mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, failed: 0 });
    const t = setup({ push: { notifyMachine } });
    t.requested("a1");
    await settle();
    expect(t.clock.pendingTimers()).toBe(0);
    t.requested("a2");
    await settle();
    expect(notifyMachine).toHaveBeenCalledTimes(2);
  });

  test("kejadian yang datang selagi kiriman pertama berjalan tetap dievaluasi walau kiriman pertama tidak mengirim apa-apa", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting: PendingApproval[] = [];
    const pushes: PushPayload[] = [];
    const clock = virtualClock();
    let first = true;
    const notifier = createNotifier({
      push: { notifyMachine: async (_m, payload) => (pushes.push(payload), { attempted: 1, delivered: 1, removed: 0, failed: 0 }) },
      pending: async () => {
        if (first) {
          first = false;
          await gate; // kiriman pertama menunggu di sini, lalu mendapati tidak ada izin
          return [];
        }
        return [...waiting];
      },
      schedule: clock.schedule,
    });
    notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    waiting.push(approval("b1"));
    notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" }); // datang selagi yang pertama menunggu
    release();
    await settle();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ approvalId: "b1" });
  });

  test("S3: kiriman satu sesi tidak saling menyalip; yang terbaru tiba terakhir", async () => {
    const order: Array<number | undefined> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const clock = virtualClock();
    const waiting: PendingApproval[] = [];
    const notifier = createNotifier({
      push: {
        notifyMachine: async (_m, payload) => {
          calls += 1;
          if (calls === 1) await firstGate; // kiriman pertama lambat di layanan push
          order.push(payload.count);
          return { attempted: 1, delivered: 1, removed: 0, failed: 0 };
        },
      },
      pending: async () => [...waiting],
      schedule: clock.schedule,
    });
    waiting.push(approval("a1"));
    notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    waiting.push(approval("a2"));
    notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await clock.advance(DEFAULT_APPROVAL_WINDOW_MS); // jendela habis saat kiriman pertama masih tertahan
    releaseFirst();
    await clock.advance(1);
    await settle();
    expect(order).toEqual([1, 2]); // bukan [2, 1]: layar HP berakhir dengan jumlah terbaru
  });

  test("risiko tertinggi yang menunggu ikut dalam keputusan untuk penyaring (#037), tanpa isi permintaan", async () => {
    const seen: NotifyDecision[] = [];
    const t = setup({ filter: (d) => (seen.push(d), true) });
    t.waiting.push({ ...approval("a1"), risk: { level: "low", reasons: [{ code: "r", message: "r" }] } } as PendingApproval, { ...approval("a2"), risk: { level: "high", reasons: [{ code: "r", message: "r" }] } } as PendingApproval, { ...approval("a3"), risk: { level: "medium", reasons: [{ code: "r", message: "r" }] } } as PendingApproval);
    t.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(seen[0]).toEqual({ kind: "approval", machineId: "m1", sessionId: "s1", count: 3, risk: "high" });
    expect(JSON.stringify(seen)).not.toContain("SANGAT-RAHASIA");
  });

  test("level risiko tertinggi ikut di isi push (hanya level), dan tidak ada bila tidak dinilai", async () => {
    const t = setup();
    t.waiting.push({ ...approval("a1"), risk: { level: "low", reasons: [] } } as PendingApproval, { ...approval("a2"), risk: { level: "high", reasons: [] } } as PendingApproval);
    t.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(t.pushes[0]?.payload).toMatchObject({ kind: "approval", count: 2, risk: "high" });
    const u = setup();
    u.waiting.push(approval("b1"));
    u.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    expect("risk" in (u.pushes[0]?.payload ?? {})).toBe(false);
  });

  test("tanpa penilaian risiko: tidak ada kolom risk di keputusan", async () => {
    const seen: NotifyDecision[] = [];
    const t = setup({ filter: (d) => (seen.push(d), true) });
    t.requested("a1");
    await settle();
    expect("risk" in seen[0]!).toBe(false);
  });

  test("nomor sesi atau izin yang terlalu panjang tidak membuang seluruh notifikasi: dikirim tanpa nomor itu", async () => {
    const t = setup();
    const long = "x".repeat(300);
    t.requested(long, "s-panjang");
    t.requested("b1", long);
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: long });
    await settle();
    const approvals = t.pushes.filter((p) => p.payload.kind === "approval");
    const first = approvals.find((p) => p.payload.sessionId === "s-panjang")!;
    expect("approvalId" in first.payload).toBe(false); // nomor izin panjang dibuang, jumlah tetap ada
    expect(first.payload.count).toBe(1);
    const second = approvals.find((p) => p.payload.sessionId === undefined)!;
    expect(second.payload).toMatchObject({ approvalId: "b1", count: 1 });
    const done = t.pushes.find((p) => p.payload.kind === "done")!;
    expect(done.payload.sessionId).toBeUndefined();
    for (const { payload } of t.pushes) expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test("tidak ada izin yang menunggu saat dihitung (mis. jam laptop tidak sinkron): satu baris log menjelaskannya", async () => {
    const t = setup();
    t.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(t.logs.join("\n")).toContain("jam laptop tidak sinkron");
    expect(t.pushes).toEqual([]);
  });

  test("setelah stop(), kejadian baru tidak memicu apa pun dan tidak membuka jendela", async () => {
    const t = setup();
    t.notifier.stop();
    t.requested("a1");
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await settle();
    expect(t.pushes).toEqual([]);
    expect(t.clock.pendingTimers()).toBe(0);
    expect(t.notifier.activeSessions()).toBe(0);
  });
});

describe("memori terbatas", () => {
  test("sesi yang sudah sepi satu jendela penuh dilupakan: relay yang berjalan lama tidak menimbun catatan", async () => {
    const t = setup();
    for (let i = 0; i < 50; i++) {
      t.requested("a" + i, "sesi-" + i);
      t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "sesi-" + i });
    }
    await settle();
    expect(t.notifier.activeSessions()).toBe(100); // 50 sesi x (izin + selesai)
    await t.clock.advance(DEFAULT_DONE_WINDOW_MS * 2);
    expect(t.notifier.activeSessions()).toBe(0);
    expect(t.clock.pendingTimers()).toBe(0);
  });
});

describe("titik penyaring kebijakan (#037)", () => {
  test("penyaring melihat jenis, laptop, sesi, dan jumlah; yang ditolak tidak dikirim", async () => {
    const seen: NotifyDecision[] = [];
    const t = setup({ filter: (d) => (seen.push(d), d.kind !== "done") });
    t.requested("a1");
    t.requested("a2");
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(seen).toContainEqual({ kind: "approval", machineId: "m1", sessionId: "s1", count: 2 });
    expect(seen).toContainEqual({ kind: "done", machineId: "m1", sessionId: "s1" });
    expect(t.pushes.every((p) => p.payload.kind === "approval")).toBe(true);
  });

  test("penyaring tidak sinkron juga dihormati", async () => {
    const t = setup({ filter: async () => false });
    t.requested("a1");
    await settle();
    expect(t.pushes).toEqual([]);
  });

  test("penyaring yang melempar galat berarti DIAM (bukan membanjiri), dan tidak merusak yang berikutnya", async () => {
    let broken = true;
    const t = setup({
      filter: () => {
        if (broken) throw new Error("kebijakan rusak");
        return true;
      },
    });
    t.requested("a1");
    await settle();
    expect(t.pushes).toEqual([]);
    broken = false;
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 2);
    t.requested("a2");
    await settle();
    expect(t.pushes).toHaveLength(1);
  });
});

describe("isi push tidak memuat kode atau isi perintah (FR-34)", () => {
  test("untuk izin dengan perintah dan rahasia, isi push yang terkirim hanya nomor dan jumlah, dan lolos skema yang ketat", async () => {
    const t = setup();
    for (let i = 1; i <= 4; i++) t.requested(`a${i}`);
    t.notifier.onEvent({ type: "agent.stopped", machineId: "m1", sessionId: "s1" });
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS);
    expect(t.pushes.length).toBeGreaterThan(1);
    for (const { payload } of t.pushes) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain("SANGAT-RAHASIA");
      expect(text).not.toContain("rm -rf");
      expect(text).not.toContain("abc123XYZ");
      expect(text).not.toContain("Bash");
      expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
      // Hanya kolom yang dikenal: tidak ada tempat untuk isi perintah.
      expect(Object.keys(payload).every((k) => ["v", "kind", "machineId", "sessionId", "approvalId", "count"].includes(k))).toBe(true);
    }
  });

  test("pemicu tidak pernah membaca isi event: event dengan isi aneh atau berbahaya tidak mengubah isi push", async () => {
    const t = setup();
    t.waiting.push(approval("a1"));
    t.notifier.onEvent({ type: "approval.requested", machineId: "m1", sessionId: "s1", payload: { command: SECRET } } as never);
    await settle();
    expect(JSON.stringify(t.pushes)).not.toContain("rm -rf");
  });

  test("skema push menolak kolom tambahan (kode atau perintah tidak bisa terselip)", () => {
    const base = { v: 1, kind: "approval", machineId: "m1", sessionId: "s1", count: 2 };
    expect(PushPayloadSchema.safeParse(base).success).toBe(true);
    expect(PushPayloadSchema.safeParse({ ...base, command: "rm -rf /" }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...base, toolInput: {} }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...base, count: 0 }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...base, count: 1.5 }).success).toBe(false);
  });
});

describe("ketahanan", () => {
  test("pengiriman yang gagal tidak melempar, dicatat tanpa isi, dan pemicu tetap bekerja sesudahnya", async () => {
    const notifyMachine = vi.fn().mockRejectedValueOnce(new Error(`gagal kirim ${SECRET}`)).mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, failed: 0 });
    const t = setup({ push: { notifyMachine } });
    expect(() => t.requested("a1")).not.toThrow();
    await settle();
    expect(t.logs.join("\n")).toContain("notifikasi approval gagal dikirim");
    expect(t.logs.join("\n")).not.toContain("SANGAT-RAHASIA");
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 2);
    t.requested("a2");
    await settle();
    expect(notifyMachine).toHaveBeenCalledTimes(2);
  });

  test("pencarian izin yang gagal tidak melempar dan tidak mengirim apa pun", async () => {
    const t = setup({
      pending: async () => {
        throw new Error("database mati");
      },
    });
    expect(() => t.requested("a1")).not.toThrow();
    await settle();
    expect(t.pushes).toEqual([]);
    expect(t.logs.join("\n")).toContain("gagal dikirim");
  });

  test("stop() membatalkan semua jendela: tidak ada ringkasan yang keluar sesudahnya", async () => {
    const t = setup();
    t.requested("a1");
    await settle();
    t.requested("a2");
    t.notifier.stop();
    await t.clock.advance(DEFAULT_APPROVAL_WINDOW_MS * 3);
    expect(t.pushes).toHaveLength(1);
    expect(t.clock.pendingTimers()).toBe(0);
  });
});

describe("notifyAfterSave", () => {
  const event = { type: "approval.requested", machineId: "m1", sessionId: "s1" } as unknown as Envelope;

  test("event BARU: pemicu dipanggil dan hasil penyimpanan diteruskan apa adanya", async () => {
    const onEvent = vi.fn();
    const result = await notifyAfterSave(async () => ({ inserted: true }), { onEvent })(event);
    expect(result).toEqual({ inserted: true });
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  test("event KIRIMAN ULANG (inserted: false): pemicu TIDAK dipanggil, jadi HP tidak berbunyi dua kali", async () => {
    const onEvent = vi.fn();
    const result = await notifyAfterSave(async () => ({ inserted: false }), { onEvent })(event);
    expect(result).toEqual({ inserted: false });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("penyimpan tanpa hasil (mode tanpa pelacakan duplikat): dianggap baru", async () => {
    const onEvent = vi.fn();
    await notifyAfterSave(async () => undefined, { onEvent })(event);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test("penyimpanan gagal: galat diteruskan (laptop mengulang kirim) dan pemicu tidak dipanggil", async () => {
    const onEvent = vi.fn();
    await expect(
      notifyAfterSave(async () => {
        throw new Error("database mati");
      }, { onEvent })(event),
    ).rejects.toThrow("database mati");
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("pemicu yang melempar galat tidak menggagalkan penyimpanan yang sudah berhasil", async () => {
    const result = await notifyAfterSave(async () => ({ inserted: true }), {
      onEvent: () => {
        throw new Error("pemicu rusak");
      },
    })(event);
    expect(result).toEqual({ inserted: true });
  });
});

describe("pendingLookup", () => {
  const envelope = (type: string, seq: number, approvalId: string, sessionId: string, extra: Record<string, unknown> = {}): Envelope => ({
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    machineId: "m1",
    sessionId,
    seq,
    ts: "2026-11-15T10:00:00.000Z",
    agent: "claude-code",
    type,
    payload: { approvalId, ...extra },
  });
  const requested = (seq: number, approvalId: string, sessionId: string) =>
    envelope("approval.requested", seq, approvalId, sessionId, { toolName: "Bash", toolInput: { command: "ls" }, expiresAt: "2026-11-15T10:09:00.000Z" });

  test("hanya izin sesi itu yang menunggu, tanpa yang sudah diputuskan atau kedaluwarsa", async () => {
    const store = {
      listRecentByType: vi.fn(async () => [
        requested(1, "a1", "s1"),
        requested(2, "a2", "s1"),
        requested(3, "b1", "s2"),
        envelope("approval.resolved", 4, "a1", "s1", { status: "approved" }),
      ]),
    };
    const waiting = await pendingLookup(store, () => new Date("2026-11-15T10:01:00.000Z"))("m1", "s1");
    expect(waiting.map((p) => p.approvalId)).toEqual(["a2"]);
    const expired = await pendingLookup(store, () => new Date("2026-11-15T10:30:00.000Z"))("m1", "s1");
    expect(expired).toEqual([]);
  });

  test("membaca riwayat laptop itu dalam batas waktu 30 menit terakhir", async () => {
    const store = { listRecentByType: vi.fn(async () => []) };
    await pendingLookup(store, () => new Date("2026-11-15T10:00:00.000Z"))("m1", "s1");
    const [machineId, types, since] = store.listRecentByType.mock.calls[0] as unknown as [string, string[], Date];
    expect(machineId).toBe("m1");
    expect(types).toEqual(["approval.requested", "approval.resolved", "approval.auto_resolved"]);
    expect(since.toISOString()).toBe("2026-11-15T09:30:00.000Z");
  });
});
