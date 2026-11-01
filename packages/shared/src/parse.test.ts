// FILE INI: TEST untuk parse.ts, yaitu "petugas pos" yang memeriksa pesan masuk.
// Pengantar istilah test (describe, test, expect) ada di approval.test.ts.
//
// Strategi ujiannya:
//   1. Setiap jenis event diuji dengan data yang benar (harus diterima).
//   2. Berbagai kesalahan diuji (harus ditolak dengan pesan yang menyebut lokasinya).
//   3. Jenis event asing dan input aneh diuji (tidak boleh membuat program error).
import { describe, expect, test } from "vitest";
import { EVENT_TYPES, type EventType } from "./events";
import { parseEvent } from "./parse";

// Contoh data risiko yang dipakai berulang di beberapa test.
const risk = { level: "high", reasons: [{ code: "secret-file", message: "Menyentuh .env" }] };

// Bertipe Record<EventType, ...>: menambah jenis event tanpa contoh di sini akan gagal typecheck.
//
// Record<A, B> = "kamus yang SETIAP kunci A wajib punya nilai B". Di sini artinya:
// setiap jenis event wajib punya satu contoh payload yang benar. Kalau besok ada
// event ke-13 tapi lupa menambah contohnya, TypeScript langsung menolak, jadi tidak
// mungkin ada jenis event yang luput dari uji.
const validPayloads: Record<EventType, unknown> = {
  "session.started": { cwd: "D:/Dev/app", permissionMode: "default" },
  "tool.requested": { toolName: "Edit", toolInput: { file_path: "a.ts" }, toolUseId: "t1" },
  "tool.completed": { toolName: "Edit", toolUseId: "t1", ok: true },
  "approval.requested": {
    approvalId: "a1",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    risk,
    summary: "Menjalankan test",
    expiresAt: "2026-11-01T10:10:00Z",
  },
  "approval.resolved": {
    approvalId: "a1",
    status: "partially_approved",
    hunks: [{ hunkId: "h1", decision: "approve" }],
  },
  "approval.auto_resolved": {
    approvalId: "a2",
    toolName: "Bash",
    status: "auto_approved",
    policy: { action: "allow", ruleId: "tests-allowed" },
  },
  "agent.notification": { message: "Butuh izin" },
  "agent.stopped": { lastMessage: "Selesai" },
  "turn.review_requested": { turnId: "turn1", files: ["a.ts", "b.ts"] },
  "checkpoint.created": { checkpointId: "c1" },
  "checkpoint.restored": { checkpointId: "c1", safetyCheckpointId: "c2" },
  "session.recap": { durationMs: 120000, filesChanged: ["a.ts"], rejected: 1, autoApproved: 3 },
};

// Pembuat amplop untuk keperluan test: mengisi semua kolom wajib dengan nilai yang
// benar. "overrides" memungkinkan test menimpa satu-dua kolom saja untuk menciptakan
// kesalahan tertentu, misalnya envelope("x", {}, { seq: -1 }) = "amplop benar, kecuali seq".
// "...overrides" di akhir menimpa nilai sebelumnya karena yang paling akhir menang.
const envelope = (type: string, payload: unknown, overrides: object = {}) => ({
  v: 1,
  id: "3f6c1f0e-8f0b-4c1e-9a53-0c6f7a2b9d11",
  machineId: "laptop-1",
  sessionId: "sess-1",
  seq: 0,
  ts: "2026-11-01T10:00:00.000Z",
  agent: "claude-code",
  type,
  payload,
  ...overrides,
});

describe("parseEvent: data valid", () => {
  // test.each(EVENT_TYPES) = jalankan soal yang sama untuk SETIAP nama event.
  // "%s" di judul diganti nama event yang sedang diuji, jadi kalau ada yang gagal
  // langsung terlihat event mana.
  test.each(EVENT_TYPES)("menerima event %s", (type) => {
    const result = parseEvent(envelope(type, validPayloads[type]));
    expect(result.status).toBe("ok");
    // "if" ini mempersempit tipe: baru setelah yakin status "ok", TypeScript mengizinkan
    // membaca result.event.
    if (result.status === "ok") expect(result.event.type).toBe(type);
  });

  test("daftar jenis event sama dengan PRD §12", () => {
    // [...EVENT_TYPES] menyalin daftar, lalu .sort() mengurutkan abjad supaya
    // pembandingan tidak bergantung urutan. .toEqual = isinya harus sama persis.
    // Daftar di bawah ditulis manual dari PRD, sebagai "kunci jawaban" independen.
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "session.started",
        "tool.requested",
        "tool.completed",
        "approval.requested",
        "approval.resolved",
        "approval.auto_resolved",
        "agent.notification",
        "agent.stopped",
        "turn.review_requested",
        "checkpoint.created",
        "checkpoint.restored",
        "session.recap",
      ].sort(),
    );
  });

  test("menerima agent codex dan ts dengan offset zona waktu", () => {
    const result = parseEvent(
      envelope("agent.stopped", {}, { agent: "codex", ts: "2026-11-01T17:00:00+07:00" }),
    );
    expect(result.status).toBe("ok");
  });

  test("approval.requested boleh tanpa risk", () => {
    // Menyalin payload yang benar, lalu menimpa "risk" menjadi kosong (undefined).
    // "as object" = meyakinkan TypeScript bahwa nilai ini objek biasa.
    const withoutRisk = { ...(validPayloads["approval.requested"] as object), risk: undefined };
    expect(parseEvent(envelope("approval.requested", withoutRisk)).status).toBe("ok");
  });
});

describe("parseEvent: amplop tidak valid", () => {
  // Tiap baris = [nama kasus, kolom yang dirusak, nama kolom yang harus disebut di pesan].
  // Tipe [string, object, string][] = daftar yang tiap anggotanya tepat tiga isi itu.
  const cases: [string, object, string][] = [
    ["id bukan UUID", { id: "abc" }, "id"],
    ["seq negatif", { seq: -1 }, "seq"],
    ["seq pecahan", { seq: 1.5 }, "seq"],
    ["ts bukan ISO 8601", { ts: "kemarin" }, "ts"],
    ["agent tidak dikenal", { agent: "gemini" }, "agent"],
    ["sessionId kosong", { sessionId: "" }, "sessionId"],
    ["machineId hilang", { machineId: undefined }, "machineId"],
  ];

  test.each(cases)("menolak: %s", (_name, overrides, field) => {
    const result = parseEvent(envelope("agent.stopped", {}, overrides));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("malformed_envelope");
      // Pesan harus menyebut KOLOM yang salah, supaya pembaca tahu harus memperbaiki apa.
      expect(result.message).toContain(field);
    }
  });

  test("menolak versi kontrak yang tidak didukung dengan pesan jelas", () => {
    const result = parseEvent(envelope("agent.stopped", {}, { v: 2 }));
    // toMatchObject = "hasilnya harus punya setidaknya kolom-kolom ini" (kolom lain boleh ada).
    expect(result).toMatchObject({ status: "invalid", reason: "unsupported_version" });
    if (result.status === "invalid") expect(result.message).toContain("2");
  });
});

describe("parseEvent: payload tidak valid", () => {
  test("menyebut field yang salah", () => {
    const result = parseEvent(envelope("tool.completed", { toolName: "Edit", ok: "ya" }));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("invalid_payload");
      expect(result.message).toContain("payload.ok");
    }
  });

  test("menolak payload yang hilang", () => {
    expect(parseEvent(envelope("session.started", undefined)).status).toBe("invalid");
  });

  test("menolak status approval yang bukan status akhir", () => {
    // "pending" sah sebagai status secara umum, tetapi bukan status AKHIR, jadi event
    // approval.resolved tidak boleh membawanya.
    const result = parseEvent(envelope("approval.resolved", { approvalId: "a", status: "pending" }));
    expect(result.status).toBe("invalid");
  });

  test("menolak level risiko yang tidak dikenal", () => {
    const payload = {
      ...(validPayloads["approval.requested"] as object),
      risk: { level: "extreme", reasons: [] },
    };
    const result = parseEvent(envelope("approval.requested", payload));
    expect(result.status).toBe("invalid");
    // Lokasi kesalahan ditulis lengkap sampai ke kolom terdalam.
    if (result.status === "invalid") expect(result.message).toContain("payload.risk.level");
  });

  test("menolak aksi policy yang tidak dikenal", () => {
    const payload = {
      ...(validPayloads["approval.auto_resolved"] as object),
      policy: { action: "maybe", ruleId: null },
    };
    expect(parseEvent(envelope("approval.auto_resolved", payload)).status).toBe("invalid");
  });
});

describe("parseEvent: event tak dikenal dan input aneh", () => {
  test("jenis event baru dilaporkan tanpa error", () => {
    // Amplop benar, tapi jenisnya belum kita kenal: bukan kesalahan, hanya "asing".
    const result = parseEvent(envelope("session.teleported", { x: 1 }));
    expect(result.status).toBe("unknown_type");
    if (result.status === "unknown_type") expect(result.type).toBe("session.teleported");
  });

  // Uji ketangguhan: data dari luar bisa berisi APA SAJA, dan petugas tidak boleh
  // panik. "() => 1" adalah sebuah fungsi, sengaja dimasukkan sebagai input aneh.
  test.each([null, undefined, "teks", 42, [], {}, () => 1])(
    "tidak melempar error untuk input %s",
    (input) => {
      // .not.toThrow() = "tidak boleh melempar error". Dibungkus fungsi () => ...
      // karena Vitest perlu menjalankannya sendiri untuk menangkap errornya.
      expect(() => parseEvent(input)).not.toThrow();
      expect(parseEvent(input).status).toBe("invalid");
    },
  );
});
