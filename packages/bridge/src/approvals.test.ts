import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStatusSchema, type ApprovalStatus, type FileDiff } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  canTransition,
  createApprovalEngine,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_RESOLVED_KEPT,
  type ApprovalEngine,
  type ApprovalOutcome,
} from "./approvals";
import { startDaemon, type RunningDaemon } from "./daemon";
import { DEFAULT_HOOK_TIMEOUT_SECONDS } from "./hook-config";

const ALL_STATUSES = ApprovalStatusSchema.options;
const FINAL: ApprovalStatus[] = ["approved", "partially_approved", "denied", "timed_out", "cancelled"];
const NEW: Parameters<ApprovalEngine["request"]>[0] = { sessionId: "s1", toolName: "Write", toolInput: { file_path: "a.txt" } };

// Semua test di bawah (kecuali bagian daemon sungguhan) memakai jam tiruan: waktu hanya
// maju saat test menyuruhnya, jadi test cepat dan hasilnya selalu sama.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const approveOf = (approvalId: string) => ({ approvalId, decision: "approve" as const });

describe("aturan perpindahan status", () => {
  test("hanya pending yang boleh pindah, dan hanya ke status akhir (semua 64 pasangan diperiksa)", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = from === "pending" && FINAL.includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  test("status akhir tidak bisa kembali ke pending atau pindah ke status akhir lain", () => {
    expect(canTransition("approved", "pending")).toBe(false);
    expect(canTransition("approved", "denied")).toBe(false);
    expect(canTransition("timed_out", "approved")).toBe(false);
    expect(canTransition("cancelled", "approved")).toBe(false);
  });

  test("auto_approved dan auto_denied tidak bisa dicapai lewat mesin ini (langsung dari policy)", () => {
    expect(canTransition("pending", "auto_approved")).toBe(false);
    expect(canTransition("pending", "auto_denied")).toBe(false);
  });
});

describe("setiap status akhir bisa dicapai, dan hook yang menunggu selalu dijawab", () => {
  test("approve -> approved, dengan komentar", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    expect(engine.get(ticket.approvalId)?.status).toBe("pending");
    const result = engine.decide({ ...approveOf(ticket.approvalId), comment: "silakan" });
    expect(result.ok).toBe(true);
    expect(await ticket.outcome).toEqual({ status: "approved", comment: "silakan" });
    expect(engine.get(ticket.approvalId)?.status).toBe("approved");
  });

  test("deny -> denied, komentar penolakan sampai ke jawaban", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    engine.decide({ approvalId: ticket.approvalId, decision: "deny", comment: "jangan buat file baru" });
    expect(await ticket.outcome).toEqual({ status: "denied", comment: "jangan buat file baru" });
  });

  test("partial -> partially_approved, rincian hunk ikut terbawa", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    const hunks = [
      { hunkId: "h1", decision: "approve" as const },
      { hunkId: "h2", decision: "reject" as const, comment: "salah" },
    ];
    engine.decide({ approvalId: ticket.approvalId, decision: "partial", hunks });
    expect(await ticket.outcome).toEqual({ status: "partially_approved", hunks });
  });

  test("waktu habis -> timed_out (tanpa keputusan, bukan persetujuan)", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request({ ...NEW, timeoutMs: 5000 });
    vi.advanceTimersByTime(4999);
    expect(engine.get(ticket.approvalId)?.status).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(await ticket.outcome).toEqual({ status: "timed_out" });
  });

  test("dibatalkan -> cancelled", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    expect(engine.cancelAll()).toBe(1);
    expect(await ticket.outcome).toEqual({ status: "cancelled" });
  });

  test("jawaban tidak pernah gagal (reject), apa pun yang terjadi", async () => {
    const engine = createApprovalEngine();
    const outcomes = [
      engine.request(NEW),
      engine.request(NEW),
      engine.request({ ...NEW, timeoutMs: 10 }),
      engine.request(NEW),
    ];
    engine.decide({ approvalId: outcomes[0]!.approvalId, decision: "deny" });
    vi.advanceTimersByTime(10);
    engine.close();
    const settled = await Promise.allSettled(outcomes.map((t) => t.outcome));
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
  });
});

describe("keputusan pertama yang berlaku", () => {
  test("dua keputusan berbeda hampir bersamaan: hanya yang pertama berlaku", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);

    const first = engine.decide({ approvalId: ticket.approvalId, decision: "deny", comment: "pertama" });
    const second = engine.decide({ approvalId: ticket.approvalId, decision: "approve", comment: "kedua" });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "already_resolved", status: "denied" });
    expect(await ticket.outcome).toEqual({ status: "denied", comment: "pertama" });
    expect(engine.get(ticket.approvalId)).toMatchObject({ status: "denied", comment: "pertama" });
  });

  test("keputusan yang sama dikirim dua kali: yang kedua ditolak (tidak diterapkan ulang)", () => {
    const onChange = vi.fn();
    const engine = createApprovalEngine({ onChange });
    const ticket = engine.request(NEW);
    expect(engine.decide(approveOf(ticket.approvalId)).ok).toBe(true);
    expect(engine.decide(approveOf(ticket.approvalId))).toEqual({ ok: false, reason: "already_resolved", status: "approved" });
    // Kabar "selesai" hanya sekali: requested + resolved.
    expect(onChange.mock.calls.map(([c]) => c.type)).toEqual(["requested", "resolved"]);
  });

  test("keputusan yang terlambat setelah waktu habis ditolak, dan hasilnya tetap timed_out", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request({ ...NEW, timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(engine.decide(approveOf(ticket.approvalId))).toEqual({ ok: false, reason: "already_resolved", status: "timed_out" });
    expect(await ticket.outcome).toEqual({ status: "timed_out" });
  });

  test("keputusan setelah dibatalkan ditolak", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    engine.cancelAll();
    expect(engine.decide(approveOf(ticket.approvalId))).toEqual({ ok: false, reason: "already_resolved", status: "cancelled" });
    expect(await ticket.outcome).toEqual({ status: "cancelled" });
  });
});

describe("keputusan yang berbarengan dengan batas waktu: hasilnya tetap satu", () => {
  test("sedetik sebelum habis: keputusan menang, dan timer yang tersisa tidak mengubah apa pun", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request({ ...NEW, timeoutMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(engine.decide(approveOf(ticket.approvalId)).ok).toBe(true);
    vi.advanceTimersByTime(5000); // lewati batas waktu yang tadinya akan terjadi
    expect(await ticket.outcome).toEqual({ status: "approved" });
    expect(engine.get(ticket.approvalId)?.status).toBe("approved");
    expect(vi.getTimerCount()).toBe(0); // timer sudah dibersihkan
  });

  test("tepat di batas waktu padahal timer belum sempat berjalan: kartu kedaluwarsa, keputusan ditolak (FR-29)", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request({ ...NEW, timeoutMs: 1000 });
    // Jam sudah di batas, tetapi timer belum dijalankan (keterlambatan timer yang nyata).
    vi.setSystemTime(new Date("2026-11-09T10:00:01.000Z"));
    const result = engine.decide(approveOf(ticket.approvalId));
    expect(result).toEqual({ ok: false, reason: "already_resolved", status: "timed_out" });
    expect(await ticket.outcome).toEqual({ status: "timed_out" });
    vi.advanceTimersByTime(5000); // timer yang tertinggal tidak boleh menyelesaikan lagi
    expect(engine.get(ticket.approvalId)?.status).toBe("timed_out");
  });

  test("timer berjalan lebih dulu, lalu keputusan datang di tik yang sama: tetap satu hasil", async () => {
    const onChange = vi.fn();
    const engine = createApprovalEngine({ onChange });
    const ticket = engine.request({ ...NEW, timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    const late = engine.decide(approveOf(ticket.approvalId));
    expect(late.ok).toBe(false);
    expect(await ticket.outcome).toEqual({ status: "timed_out" });
    expect(onChange.mock.calls.filter(([c]) => c.type === "resolved")).toHaveLength(1);
  });
});

describe("keputusan yang tidak sah", () => {
  test("nomor tidak dikenal ditolak", () => {
    const engine = createApprovalEngine();
    expect(engine.decide(approveOf("tidak-ada"))).toEqual({ ok: false, reason: "unknown" });
  });

  test.each([
    ["bukan objek", "setuju"],
    ["null", null],
    ["tanpa nomor", { decision: "approve" }],
    ["keputusan asing", { approvalId: "x", decision: "mungkin" }],
    ["partial tanpa hunk", { approvalId: "x", decision: "partial" }],
    ["partial semua diterima", { approvalId: "x", decision: "partial", hunks: [{ hunkId: "h1", decision: "approve" }] }],
  ])("%s ditolak sebagai invalid", (_name, input) => {
    const engine = createApprovalEngine();
    const result = engine.decide(input);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("pesan penolakan menyebut kolom yang salah, tanpa menggemakan nilai yang dikirim", () => {
    const engine = createApprovalEngine();
    const partialTanpaHunk = engine.decide({ approvalId: "x", decision: "partial" });
    expect(partialTanpaHunk).toMatchObject({ ok: false, reason: "invalid" });
    expect((partialTanpaHunk as { message: string }).message).toContain("hunks");

    const keputusanAsing = engine.decide({ approvalId: "x", decision: "RAHASIA-123" });
    const message = (keputusanAsing as { message: string }).message;
    expect(message).toContain("decision");
    expect(message).not.toContain("RAHASIA-123");

    const komentarSalahTipe = engine.decide({ approvalId: "x", decision: "approve", comment: 12345 });
    expect((komentarSalahTipe as { message: string }).message).toContain("comment");
  });

  test("keputusan yang tidak sah tidak mengubah kartu yang sedang menunggu", () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    engine.decide({ approvalId: ticket.approvalId, decision: "partial" }); // tanpa hunk
    expect(engine.get(ticket.approvalId)?.status).toBe("pending");
    expect(engine.listPending()).toHaveLength(1);
  });
});

describe("beberapa permintaan bersamaan", () => {
  test("tidak saling tertukar: tiap hook menerima jawaban miliknya sendiri", async () => {
    const engine = createApprovalEngine();
    const tickets = Array.from({ length: 50 }, (_, i) => engine.request({ ...NEW, toolName: `alat-${i}` }));

    // Diputuskan dalam urutan acak-tetap (terbalik, genap dulu), dengan komentar berbeda-beda.
    const order = [...tickets.keys()].reverse().sort((a, b) => (a % 2) - (b % 2));
    for (const i of order) {
      const decision = i % 3 === 0 ? "deny" : "approve";
      expect(engine.decide({ approvalId: tickets[i]!.approvalId, decision, comment: `untuk-${i}` }).ok).toBe(true);
    }

    const outcomes = await Promise.all(tickets.map((t) => t.outcome));
    outcomes.forEach((outcome, i) => {
      expect(outcome).toEqual({ status: i % 3 === 0 ? "denied" : "approved", comment: `untuk-${i}` });
    });
  });

  test("nomor kartu unik, dan daftar menunggu berurutan dari yang paling lama", () => {
    const engine = createApprovalEngine();
    const a = engine.request({ ...NEW, toolName: "pertama" });
    vi.advanceTimersByTime(10);
    const b = engine.request({ ...NEW, toolName: "kedua" });
    expect(new Set([a.approvalId, b.approvalId]).size).toBe(2);
    expect(engine.listPending().map((p) => p.toolName)).toEqual(["pertama", "kedua"]);
    engine.decide(approveOf(a.approvalId));
    expect(engine.listPending().map((p) => p.toolName)).toEqual(["kedua"]);
  });

  test("satu kartu waktu habis tidak memengaruhi kartu lain", async () => {
    const engine = createApprovalEngine();
    const cepat = engine.request({ ...NEW, timeoutMs: 100 });
    const lama = engine.request({ ...NEW, timeoutMs: 100_000 });
    vi.advanceTimersByTime(100);
    expect(await cepat.outcome).toEqual({ status: "timed_out" });
    expect(engine.get(lama.approvalId)?.status).toBe("pending");
    engine.cancelAll();
    expect(await lama.outcome).toEqual({ status: "cancelled" });
  });
});

describe("pembatalan", () => {
  test("cancelSession hanya membatalkan kartu milik sesi itu", async () => {
    const engine = createApprovalEngine();
    const a1 = engine.request({ ...NEW, sessionId: "A" });
    const a2 = engine.request({ ...NEW, sessionId: "A" });
    const b = engine.request({ ...NEW, sessionId: "B" });
    expect(engine.cancelSession("A")).toBe(2);
    expect(await a1.outcome).toEqual({ status: "cancelled" });
    expect(await a2.outcome).toEqual({ status: "cancelled" });
    expect(engine.get(b.approvalId)?.status).toBe("pending");
    expect(engine.cancelSession("tidak-ada")).toBe(0);
  });

  test("close membatalkan semua yang menunggu, dan membersihkan semua timer", async () => {
    const engine = createApprovalEngine();
    const tickets = [engine.request(NEW), engine.request(NEW), engine.request(NEW)];
    expect(vi.getTimerCount()).toBe(3);
    expect(engine.close()).toBe(3);
    expect((await Promise.all(tickets.map((t) => t.outcome))).map((o) => o.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.listPending()).toEqual([]);
  });

  test("permintaan yang datang setelah close langsung dibatalkan (hook yang telat tetap dijawab)", async () => {
    const engine = createApprovalEngine();
    engine.close();
    const ticket = engine.request(NEW);
    expect(await ticket.outcome).toEqual({ status: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.listPending()).toEqual([]);
  });

  test("close aman dipanggil berulang", () => {
    const engine = createApprovalEngine();
    engine.request(NEW);
    expect(engine.close()).toBe(1);
    expect(engine.close()).toBe(0);
  });
});

describe("kabar perubahan dan foto kartu", () => {
  test("pendengar mendapat kabar dibuka dan diselesaikan, dan kesalahannya tidak merusak mesin", async () => {
    const errors: string[] = [];
    const onChange = vi.fn(() => {
      throw new Error("pendengar rusak");
    });
    const engine = createApprovalEngine({
      onChange,
      logger: { info: () => undefined, error: (m) => errors.push(m) },
    });
    const ticket = engine.request(NEW);
    engine.decide(approveOf(ticket.approvalId));
    expect(await ticket.outcome).toEqual({ status: "approved" });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("pendengar persetujuan gagal: pendengar rusak");
  });

  test("foto adalah salinan: mengubahnya tidak memengaruhi mesin", () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    const snapshot = engine.get(ticket.approvalId);
    if (!snapshot) throw new Error("kartu tidak ada");
    snapshot.status = "approved";
    snapshot.toolInput.file_path = "diubah";
    engine.listPending()[0]!.status = "denied";
    expect(engine.get(ticket.approvalId)).toMatchObject({ status: "pending", toolInput: { file_path: "a.txt" } });
  });

  test("masukan asli tidak ikut berubah bila pemanggil mengubahnya sesudahnya", () => {
    const engine = createApprovalEngine();
    const input = { ...NEW, toolInput: { command: "ls" } };
    const ticket = engine.request(input);
    input.toolInput.command = "rm -rf /";
    expect(engine.get(ticket.approvalId)?.toolInput).toEqual({ command: "ls" });
  });

  test("tidak memuat isi input di log, hanya status dan nama alat", () => {
    const lines: string[] = [];
    const engine = createApprovalEngine({ logger: { info: (m) => lines.push(m), error: (m) => lines.push(m) } });
    const ticket = engine.request({ ...NEW, toolInput: { content: "RAHASIA-123" } });
    engine.decide({ approvalId: ticket.approvalId, decision: "deny", comment: "RAHASIA-456" });
    expect(lines.join("|")).toContain("persetujuan denied alat=Write");
    expect(lines.join("|")).not.toContain("RAHASIA");
  });

  test("kartu selesai diingat terbatas jumlahnya; yang terlalu lama dilupakan (tetap ditolak)", () => {
    const engine = createApprovalEngine();
    const first = engine.request(NEW);
    engine.decide(approveOf(first.approvalId));
    for (let i = 0; i < MAX_RESOLVED_KEPT; i++) {
      engine.decide(approveOf(engine.request(NEW).approvalId));
    }
    expect(engine.get(first.approvalId)).toBeUndefined();
    expect(engine.decide(approveOf(first.approvalId))).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("batas waktu", () => {
  test("bawaan SENGAJA lebih pendek dari batas hook di konfigurasi Claude Code", () => {
    // Supaya daemon yang memutuskan "waktu habis" lebih dulu, bukan Claude Code yang memutus.
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeLessThan(DEFAULT_HOOK_TIMEOUT_SECONDS * 1000);
  });

  test("bawaan dipakai bila tidak diisi, dan expiresAt mengikutinya", () => {
    const engine = createApprovalEngine();
    const ticket = engine.request(NEW);
    expect(ticket.expiresAt).toBe(new Date(Date.parse("2026-11-09T10:00:00.000Z") + DEFAULT_APPROVAL_TIMEOUT_MS).toISOString());
  });

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("batas waktu %s ditolak sebagai kesalahan pemrogram", (timeoutMs) => {
    expect(() => createApprovalEngine().request({ ...NEW, timeoutMs })).toThrow(RangeError);
  });
});

// ---- Daemon sungguhan: berhenti saat ada hook yang menunggu -----------------------------
// Memakai jam asli, karena melibatkan jaringan dan penutupan koneksi sungguhan.
describe("daemon yang berhenti saat hook sedang menunggu izin", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    home = mkdtempSync(join(tmpdir(), "agentmon-approvals-"));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function postHook(d: RunningDaemon): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: d.port,
          path: "/hook",
          method: "POST",
          headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" }));
    });
  }

  test("hook yang menunggu mendapat jawaban {} (tanpa keputusan) sebelum koneksi ditutup", async () => {
    const outcomes: ApprovalOutcome[] = [];
    daemon = await startDaemon({
      home,
      port: 0,
      // Penangan seperti issue 008 nanti: buka kartu lalu MENUNGGU keputusan.
      onHook: async (_input, { approvals }) => {
        outcomes.push(await approvals.request(NEW).outcome);
        return undefined;
      },
    });

    const reply = postHook(daemon);
    await vi.waitFor(() => expect(daemon?.approvals.listPending()).toHaveLength(1));

    await daemon.stop(); // daemon berhenti selagi hook menunggu

    const answered = await reply;
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({});
    expect(outcomes).toEqual([{ status: "cancelled" }]);
    daemon = undefined;
  });

  test("beberapa hook yang menunggu semuanya dijawab saat berhenti", async () => {
    const outcomes: string[] = [];
    daemon = await startDaemon({
      home,
      port: 0,
      onHook: async (_input, { approvals }) => {
        outcomes.push((await approvals.request(NEW).outcome).status);
        return undefined;
      },
    });
    const replies = [postHook(daemon), postHook(daemon), postHook(daemon)];
    await vi.waitFor(() => expect(daemon?.approvals.listPending()).toHaveLength(3));

    await daemon.stop();

    const answered = await Promise.all(replies);
    expect(answered.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(outcomes).toEqual(["cancelled", "cancelled", "cancelled"]);
    daemon = undefined;
  });

  test("tanpa jawaban sampai batas waktu: hook dijawab {} (tanpa keputusan), tidak menggantung", async () => {
    daemon = await startDaemon({
      home,
      port: 0,
      approvalTimeoutMs: 80,
      onHook: async (_input, { approvals }) => {
        const outcome = await approvals.request({ ...NEW }).outcome;
        return outcome.status === "approved" ? { disetujui: true } : undefined;
      },
    });
    const started = Date.now();
    const answered = await postHook(daemon);
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(70); // memang menunggu sampai batas waktunya
    expect(daemon.approvals.listPending()).toEqual([]);
  });

  test("keputusan yang masuk lewat mesin daemon membebaskan hook yang menunggu", async () => {
    daemon = await startDaemon({
      home,
      port: 0,
      onHook: async (_input, { approvals }) => {
        const outcome = await approvals.request(NEW).outcome;
        return outcome.status === "approved" ? { disetujui: true } : undefined;
      },
    });
    const reply = postHook(daemon);
    await vi.waitFor(() => expect(daemon?.approvals.listPending()).toHaveLength(1));
    const [pending] = daemon.approvals.listPending();
    daemon.approvals.decide(approveOf(pending!.approvalId));

    const answered = await reply;
    expect(JSON.parse(answered.body)).toEqual({ disetujui: true });
  });
});

describe("diff yang menyertai izin", () => {
  const diff: FileDiff = {
    path: "app.ts",
    toolName: "Edit",
    sensitive: [],
    change: {
      type: "text",
      isNew: false,
      hunks: [],
      added: 0,
      removed: 0,
      format: { oldEol: "lf", newEol: "lf", oldFinalNewline: true, newFinalNewline: true },
    },
  };

  test("disimpan bersama kartu dan bisa dibaca, tanpa memengaruhi keputusan", async () => {
    const engine = createApprovalEngine();
    const ticket = engine.request({ ...NEW, diff });
    expect(engine.get(ticket.approvalId)?.diff).toEqual(diff);
    expect(engine.listPending()[0]?.diff).toEqual(diff);
    engine.decide(approveOf(ticket.approvalId));
    expect(await ticket.outcome).toEqual({ status: "approved" }); // diff tidak ikut ke jawaban
    expect(engine.get(ticket.approvalId)?.diff).toEqual(diff); // tetap ada setelah selesai
  });

  test("berupa salinan: mengubah masukan atau hasilnya tidak memengaruhi mesin", () => {
    const engine = createApprovalEngine();
    const input = structuredClone(diff);
    const ticket = engine.request({ ...NEW, diff: input });
    input.path = "diubah.ts";
    const read = engine.get(ticket.approvalId);
    if (read?.diff) read.diff.path = "diubah-lagi.ts";
    expect(engine.get(ticket.approvalId)?.diff?.path).toBe("app.ts");
  });

  test("tanpa diff, kolomnya tidak ada", () => {
    const engine = createApprovalEngine();
    expect(engine.get(engine.request(NEW).approvalId)).not.toHaveProperty("diff");
  });
});
