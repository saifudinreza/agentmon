import { EVENT_TYPES, type Envelope } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { cleanLine, describeEvent } from "./describe";

let counter = 0;
const ev = (type: string, payload: unknown): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq: counter,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type,
  payload,
});

describe("describeEvent: setiap jenis event punya tampilan sendiri", () => {
  test("session.started: judul dan folder kerja", () => {
    expect(describeEvent(ev("session.started", { cwd: "/proyek/agentmon" }))).toEqual({ titleKey: "event.session.started", detail: "/proyek/agentmon", tone: "info" });
  });

  test.each([
    ["berkas", { file_path: "src/a.ts", command: "diabaikan" }, "src/a.ts"],
    ["perintah", { command: "npm test" }, "npm test"],
    ["pola", { pattern: "TODO" }, "TODO"],
    ["alamat", { url: "https://contoh.com" }, "https://contoh.com"],
  ])("tool.requested menyebut sasaran yang paling berarti: %s", (_name, toolInput, detail) => {
    expect(describeEvent(ev("tool.requested", { toolName: "Bash", toolInput }))).toEqual({ titleKey: "event.tool.requested", titleParams: { tool: "Bash" }, detail, tone: "neutral" });
  });

  test("tool.requested tanpa sasaran dikenali: tanpa keterangan", () => {
    const view = describeEvent(ev("tool.requested", { toolName: "Aneh", toolInput: { x: 1 } }));
    expect(view.detail).toBeUndefined();
  });

  test("tool.completed: sukses tenang, gagal merah", () => {
    expect(describeEvent(ev("tool.completed", { toolName: "Write", ok: true }))).toMatchObject({ titleKey: "event.tool.completed.ok", tone: "neutral" });
    expect(describeEvent(ev("tool.completed", { toolName: "Write", ok: false }))).toMatchObject({ titleKey: "event.tool.completed.failed", tone: "bad" });
  });

  test("approval.requested menonjol (kuning), merah bila risiko tinggi, dan memakai ringkasan bila ada", () => {
    const base = { approvalId: "a1", toolName: "Write", toolInput: { file_path: "a.ts" }, expiresAt: "2026-11-11T10:09:00.000Z" };
    expect(describeEvent(ev("approval.requested", base))).toMatchObject({ titleKey: "event.approval.requested", tone: "warn", detail: "a.ts" });
    expect(describeEvent(ev("approval.requested", { ...base, summary: "+3 -1 (2 hunk)" }))).toMatchObject({ detail: "+3 -1 (2 hunk)" });
    expect(describeEvent(ev("approval.requested", { ...base, risk: { level: "high", reasons: [] } })).tone).toBe("bad");
    expect(describeEvent(ev("approval.requested", { ...base, risk: { level: "low", reasons: [] } })).tone).toBe("warn");
  });

  test.each([
    ["approved", "event.approval.resolved.approved", "ok"],
    ["partially_approved", "event.approval.resolved.partially_approved", "ok"],
    ["denied", "event.approval.resolved.denied", "bad"],
    ["timed_out", "event.approval.resolved.timed_out", "warn"],
    ["cancelled", "event.approval.resolved.cancelled", "neutral"],
  ])("approval.resolved %s", (status, titleKey, tone) => {
    const payload =
      status === "partially_approved"
        ? { approvalId: "a1", status, hunks: [{ hunkId: "h1", decision: "approve" }, { hunkId: "h2", decision: "reject" }] }
        : { approvalId: "a1", status, comment: "alasan saya" };
    const view = describeEvent(ev("approval.resolved", payload));
    expect(view).toMatchObject({ titleKey, tone });
    if (status !== "partially_approved") expect(view.detail).toBe("alasan saya");
  });

  test("approval.auto_resolved: disetujui otomatis (hijau) dan ditolak otomatis (merah), dengan aturan penyebabnya", () => {
    const policy = { action: "allow", ruleId: "aturan-baca" };
    expect(describeEvent(ev("approval.auto_resolved", { approvalId: "a", toolName: "Read", status: "auto_approved", policy }))).toEqual({
      titleKey: "event.approval.auto_approved",
      titleParams: { tool: "Read" },
      detail: "aturan-baca",
      tone: "ok",
    });
    expect(describeEvent(ev("approval.auto_resolved", { approvalId: "a", toolName: "Bash", status: "auto_denied", policy: { action: "deny", ruleId: null } }))).toMatchObject({ titleKey: "event.approval.auto_denied", tone: "bad" });
  });

  test("approval.auto_resolved memuat ringkasan apa yang diputuskan (jejak audit), dibersihkan dan dipotong untuk layar HP", () => {
    const policy = { action: "allow", ruleId: "tes" };
    const base = { approvalId: "a", toolName: "Bash", status: "auto_approved", policy };
    expect(describeEvent(ev("approval.auto_resolved", { ...base, summary: "npm test" })).detail).toBe("tes: npm test");
    expect(describeEvent(ev("approval.auto_resolved", { ...base, policy: { action: "allow", ruleId: null }, summary: "npm test" })).detail).toBe("npm test");
    expect(describeEvent(ev("approval.auto_resolved", base)).detail).toBe("tes");
    const hostile = describeEvent(ev("approval.auto_resolved", { ...base, summary: `rm -rf x${String.fromCharCode(0x202e)}gpj.sh${String.fromCharCode(27)}[2J` })).detail ?? "";
    expect(hostile).not.toContain(String.fromCharCode(0x202e));
    expect(hostile).not.toContain(String.fromCharCode(27));
  });

  test("agent.notification, agent.stopped, review, checkpoint, dan rekap", () => {
    expect(describeEvent(ev("agent.notification", { title: "Izin", message: "Perlu keputusan" })).detail).toBe("Izin: Perlu keputusan");
    expect(describeEvent(ev("agent.notification", { message: "Halo" })).detail).toBe("Halo");
    expect(describeEvent(ev("agent.stopped", { lastMessage: "Selesai." }))).toMatchObject({ titleKey: "event.agent.stopped", detail: "Selesai." });
    expect(describeEvent(ev("agent.stopped", {})).detail).toBeUndefined();
    expect(describeEvent(ev("turn.review_requested", { turnId: "t", files: ["a.ts", "b.ts"] }))).toMatchObject({ titleParams: { count: 2 }, detail: "a.ts, b.ts" });
    expect(describeEvent(ev("checkpoint.created", { checkpointId: "c1" }))).toMatchObject({ titleKey: "event.checkpoint.created", tone: "neutral" });
    expect(describeEvent(ev("checkpoint.restored", { checkpointId: "c1" }))).toMatchObject({ titleKey: "event.checkpoint.restored", tone: "warn" });
    expect(describeEvent(ev("session.recap", { durationMs: 5 * 60_000, filesChanged: ["a", "b", "c"], rejected: 1, autoApproved: 4 }))).toMatchObject({
      titleKey: "event.session.recap",
      titleParams: { minutes: 5, files: 3, rejected: 1, auto: 4 },
    });
  });

  test("rekap yang sangat singkat dibulatkan ke minimal 1 menit", () => {
    expect(describeEvent(ev("session.recap", { durationMs: 1000, filesChanged: [], rejected: 0, autoApproved: 0 })).titleParams).toMatchObject({ minutes: 1 });
  });

  test("SEMUA jenis event yang dikenal kontrak punya tampilan (tidak ada yang jatuh ke 'tidak dikenal')", () => {
    const samples: Record<string, unknown> = {
      "session.started": { cwd: "/x" },
      "tool.requested": { toolName: "T", toolInput: {} },
      "tool.completed": { toolName: "T", ok: true },
      "approval.requested": { approvalId: "a", toolName: "T", toolInput: {}, expiresAt: "2026-11-11T10:00:00.000Z" },
      "approval.resolved": { approvalId: "a", status: "approved" },
      "approval.auto_resolved": { approvalId: "a", toolName: "T", status: "auto_approved", policy: { action: "allow", ruleId: null } },
      "agent.notification": { message: "x" },
      "agent.stopped": {},
      "turn.review_requested": { turnId: "t", files: ["a"] },
      "checkpoint.created": { checkpointId: "c" },
      "checkpoint.restored": { checkpointId: "c" },
      "session.recap": { durationMs: 1, filesChanged: [], rejected: 0, autoApproved: 0 },
    };
    expect(Object.keys(samples).sort()).toEqual([...EVENT_TYPES].sort()); // kontrak bertambah jenis: test ini mengingatkan
    for (const type of EVENT_TYPES) expect(describeEvent(ev(type, samples[type])).titleKey, type).not.toBe("event.unknown");
  });
});

describe("event yang tidak dikenal atau rusak tidak membuat layar gagal", () => {
  test("jenis dari versi daemon yang lebih baru: ditampilkan secara umum", () => {
    expect(describeEvent(ev("fitur.baru", { apa: "saja" }))).toEqual({ titleKey: "event.unknown", titleParams: { type: "fitur.baru" }, tone: "neutral" });
  });

  test("isi tidak sesuai kontrak: ditampilkan secara umum, bukan melempar galat", () => {
    expect(describeEvent(ev("tool.requested", { toolName: 5 })).titleKey).toBe("event.unknown");
    expect(describeEvent(ev("tool.requested", null)).titleKey).toBe("event.unknown");
    expect(describeEvent(ev("session.started", "bukan objek")).titleKey).toBe("event.unknown");
  });

  test("nama jenis yang berbahaya dibersihkan sebelum ditampilkan", () => {
    const view = describeEvent(ev("jahat\u001b[2J‮balik", {}));
    expect(view.titleParams?.type).toBe("jahat[2Jbalik");
  });
});

describe("cleanLine: keamanan tampilan", () => {
  test("membuang karakter kontrol, escape ANSI, dan pembalik arah tulisan", () => {
    expect(cleanLine("a\u001b[31mmerah\u001b[0m")).toBe("a[31mmerah[0m");
    expect(cleanLine("harmless‮txt.exe")).toBe("harmlesstxt.exe"); // U+202E membalik tulisan sehingga nama berkas tampak lain
    expect(cleanLine("a⁦b⁩c")).toBe("abc");
    expect(cleanLine("nul\u0000byte")).toBe("nulbyte");
    expect(cleanLine("c1\u009b2J")).toBe("c12J");
  });

  test("menjadikan satu baris dan merapatkan spasi", () => {
    expect(cleanLine("baris satu\nbaris dua\r\n\tbaris   tiga")).toBe("baris satu baris dua baris tiga");
  });

  test("memotong dengan elipsis tepat di batas", () => {
    expect(cleanLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanLine("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(cleanLine("x".repeat(11), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test.each([undefined, null, 42, {}, []])("masukan yang bukan teks (%j) menjadi kosong", (value) => {
    expect(cleanLine(value)).toBe("");
  });

  test("teks biasa, termasuk non-Latin dan emoji, utuh", () => {
    expect(cleanLine("Ponsel Ani 📱 手机")).toBe("Ponsel Ani 📱 手机");
  });
});
