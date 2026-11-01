// FILE INI: TEST untuk approval.ts dan risk.ts.
//
// Test itu seperti UJIAN untuk kode kita: kita beri soal (data), lalu cek jawabannya
// sesuai harapan atau tidak. Test dijalankan otomatis oleh "pnpm test", dan juga oleh
// CI di GitHub setiap ada perubahan, jadi kalau seseorang merusak aturan, langsung ketahuan.

// Alat dari Vitest (program penjalan test):
//   describe = JUDUL BAB, mengelompokkan beberapa test yang sejenis.
//   test     = SATU soal ujian dengan satu tujuan yang jelas.
//   expect   = PERNYATAAN "saya harapkan hasilnya begini".
import { describe, expect, test } from "vitest";
import { ApprovalDecisionSchema, ApprovalStatusSchema } from "./approval";
import { PolicyResultSchema, RiskSchema } from "./risk";

describe("ApprovalDecisionSchema", () => {
  test("menerima approve dan deny dengan komentar", () => {
    // .safeParse(data) = "periksa data ini", hasilnya objek dengan success true/false.
    // Kita cek bahwa hasilnya success, artinya data yang SAH memang diterima.
    // .toBe(true) = "harus persis sama dengan true".
    expect(ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "approve" }).success).toBe(true);
    expect(
      ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "deny", comment: "terlalu luas" }).success,
    ).toBe(true);
  });

  test("menerima partial dengan hunk diterima dan ditolak", () => {
    const result = ApprovalDecisionSchema.safeParse({
      approvalId: "a",
      decision: "partial",
      hunks: [
        { hunkId: "h1", decision: "approve" },
        { hunkId: "h2", decision: "reject", comment: "ubah nama fungsi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  // test.each = satu soal yang diulang dengan beberapa data berbeda. Hemat menulis
  // dan hasil tiap kasus tampil terpisah. Tiap baris [nama, hunks] di bawah
  // dimasukkan ke fungsi sebagai (_name, hunks). Garis bawah di "_name" artinya
  // "parameter ini sengaja tidak dipakai", hanya sebagai judul kasus.
  test.each([
    ["tanpa hunk", undefined],
    ["semua hunk diterima", [{ hunkId: "h1", decision: "approve" }]],
    ["semua hunk ditolak", [{ hunkId: "h1", decision: "reject" }]],
  ])("menolak partial %s dengan pesan jelas", (_name, hunks) => {
    const result = ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "partial", hunks });
    // Soal kebalikan: data yang TIDAK sah harus ditolak.
    expect(result.success).toBe(false);
    // "if (!result.success)" perlu karena TypeScript baru mengizinkan membaca
    // result.error setelah kita buktikan hasilnya gagal. "?." artinya "kalau ada".
    // .toContain("partial") = pesan errornya harus memuat kata itu.
    if (!result.success) expect(result.error.issues[0]?.message).toContain("partial");
  });

  test("menolak keputusan tanpa approvalId", () => {
    expect(ApprovalDecisionSchema.safeParse({ decision: "approve" }).success).toBe(false);
  });
});

describe("status, risiko, dan policy", () => {
  test("status approval sesuai PRD", () => {
    // .options = daftar pilihan di dalam z.enum. .toEqual = isinya harus sama
    // persis (urutan juga dicek). Kalau seseorang menambah atau menghapus status
    // tanpa mengubah PRD, test ini gagal sebagai pengingat.
    expect(ApprovalStatusSchema.options).toEqual([
      "pending",
      "approved",
      "partially_approved",
      "denied",
      "timed_out",
      "cancelled",
      "auto_approved",
      "auto_denied",
    ]);
  });

  test("risiko menolak level di luar rendah, sedang, tinggi", () => {
    expect(RiskSchema.safeParse({ level: "low", reasons: [] }).success).toBe(true);
    expect(RiskSchema.safeParse({ level: "critical", reasons: [] }).success).toBe(false);
  });

  test("policy menerima ruleId null sebagai default, tetapi tidak boleh hilang", () => {
    // null (sengaja kosong) diterima, tetapi kolom yang tidak ditulis sama sekali ditolak.
    expect(PolicyResultSchema.safeParse({ action: "ask", ruleId: null }).success).toBe(true);
    expect(PolicyResultSchema.safeParse({ action: "ask" }).success).toBe(false);
  });
});
