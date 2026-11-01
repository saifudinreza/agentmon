// FILE INI: aturan untuk "keputusan" dan "status approval".
//
// Alurnya di proyek AgentMon:
//   1. Agent (Claude Code) mau melakukan sesuatu, misalnya mengedit file.
//   2. Laptop meminta izin ke HP.
//   3. Kamu memutuskan di HP: setuju, tolak, atau terima sebagian.
//   4. HP mengirim "formulir keputusan" ke laptop.
// File ini mendefinisikan bentuk formulir itu dan pemeriksaannya.
//
// Dipakai oleh: events.ts (di dalam payload event approval) dan, nanti,
// paket bridge (menerima keputusan) serta web (membuat keputusan).

// IMPORT = meminjam alat dari luar.
// "zod" adalah library validasi. Ibarat PENJAGA PINTU yang membawa daftar syarat:
// data yang tidak memenuhi syarat tidak boleh masuk.
// "z" adalah kotak perkakasnya. Semua alat (z.string, z.object, dst) ada di dalamnya.
import { z } from "zod";

// Status approval sesuai PRD §12. Status akhir dan status otomatis dipisah
// supaya tiap event hanya menerima status yang masuk akal.

// z.enum([...]) = PILIHAN GANDA. Nilai di luar daftar langsung ditolak.
// Contoh: "setengah_setuju" akan ditolak karena tidak ada di daftar.
//
// "export" = boleh dipakai file lain. Tanpa export, nilai ini hanya hidup di file ini.
// "const" = nilai ini tidak akan diganti-ganti setelah dibuat.
// Akhiran "Schema" adalah kebiasaan penamaan: ini ATURANNYA, bukan datanya.
export const ApprovalStatusSchema = z.enum([
  "pending", // menunggu keputusan
  "approved", // disetujui
  "partially_approved", // disetujui sebagian
  "denied", // ditolak
  "timed_out", // waktu habis, kembali ke alur izin normal di terminal
  "cancelled", // dibatalkan (daemon restart atau sesi berakhir)
  "auto_approved", // disetujui otomatis oleh policy
  "auto_denied", // ditolak otomatis oleh policy
]);
// z.infer = "turunkan tipe TypeScript dari aturan di atas".
// Jadi kita menulis aturannya SEKALI, dan otomatis dapat juga tipenya. Tidak perlu
// menulis ulang daftar yang sama dua kali (yang bisa lupa diperbarui salah satunya).
// Hasilnya: ApprovalStatus = "pending" | "approved" | ... (gabungan semua pilihan).
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// Subset dari status di atas: hanya yang mungkin jadi hasil AKHIR keputusan manusia
// atau sistem (bukan "pending", bukan "auto_*"). Dipakai di event approval.resolved,
// supaya event itu tidak bisa membawa status yang tidak masuk akal.
export const FinalApprovalStatusSchema = z.enum([
  "approved",
  "partially_approved",
  "denied",
  "timed_out",
  "cancelled",
]);
export type FinalApprovalStatus = z.infer<typeof FinalApprovalStatusSchema>;

// Subset lain: hasil keputusan OTOMATIS dari policy. Dipakai di approval.auto_resolved.
export const AutoApprovalStatusSchema = z.enum(["auto_approved", "auto_denied"]);
export type AutoApprovalStatus = z.infer<typeof AutoApprovalStatusSchema>;

// Keputusan untuk SATU bagian perubahan (hunk).
// "Hunk" = satu potongan perubahan di dalam file, yaitu sekelompok baris yang
// berubah berdekatan. Anggap satu file sebagai buku, dan satu hunk sebagai satu
// paragraf yang direvisi. Dengan swipe per hunk, kamu bisa menerima paragraf 1
// dan menolak paragraf 2.
export const HunkDecisionSchema = z.object({
  // z.object({...}) = formulir berisi beberapa kolom, masing-masing punya aturan.
  // z.string().min(1) = harus teks dan tidak boleh kosong (minimal 1 karakter).
  // Ini ID hunk yang dimaksud, supaya laptop tahu bagian mana yang kamu putuskan.
  hunkId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  // .optional() = kolom ini BOLEH tidak diisi. Komentar tidak wajib.
  comment: z.string().optional(),
});
export type HunkDecision = z.infer<typeof HunkDecisionSchema>;

// Aturan "sebagian": harus ada minimal satu hunk yang diterima DAN satu yang ditolak.
// Dipisah jadi fungsi sendiri karena dipakai di dua tempat: formulir keputusan dari HP
// (di bawah) dan catatan hasil approval.resolved (di events.ts). Satu aturan, dua
// pemakai, jadi keduanya tidak mungkin berbeda pendapat.
//
//   hunks = daftar keputusan per hunk (boleh kosong atau tidak ada)
//   ctx   = "buku catatan" pemeriksa dari Zod, tempat menulis temuan masalah
//   label = nama yang disebut di pesan error, misalnya "keputusan 'partial'"
export function requireMixedHunks(
  hunks: HunkDecision[] | undefined,
  ctx: z.RefinementCtx,
  label: string,
): void {
  // "??" = "kalau kosong, pakai ini". Memanggil .some() pada undefined akan membuat
  // program error. Daftar kosong [] aman, dan otomatis gagal di pemeriksaan di bawah.
  const list = hunks ?? [];
  // .some(...) bertanya: "adakah MINIMAL SATU anggota daftar yang memenuhi syarat?"
  // Seperti guru bertanya "ada yang sudah mengerjakan PR?", satu orang sudah cukup.
  // "h" mewakili satu hunk saat daftar dicek satu per satu. Hasilnya true/false.
  const hasApprove = list.some((h) => h.decision === "approve");
  const hasReject = list.some((h) => h.decision === "reject");
  // "!" = bukan, "||" = atau. Artinya: kalau tidak ada yang diterima ATAU tidak
  // ada yang ditolak, datanya bermasalah.
  if (!hasApprove || !hasReject) {
    // Menulis temuan di buku catatan. Zod lalu menandai data ini sebagai tidak valid.
    ctx.addIssue({
      // "custom" = jenis masalah buatan kita sendiri (bukan masalah bawaan Zod).
      code: "custom",
      // Menunjuk KOLOM yang bermasalah, jadi pesan error diawali "hunks" dan pembaca
      // langsung tahu di mana salahnya.
      path: ["hunks"],
      message: `${label} harus punya minimal satu hunk yang diterima dan satu yang ditolak`,
    });
  }
}

// Keputusan pengguna dari HP. "partial" berarti sebagian hunk diterima,
// jadi wajib ada minimal satu hunk yang diterima dan satu yang ditolak.
//
// Ini formulir keputusan lengkap. Perhatikan ada DUA tahap pemeriksaan:
//   Tahap 1 (z.object): syarat per kolom, misalnya "decision harus salah satu dari 3 pilihan".
//   Tahap 2 (.superRefine): syarat yang menghubungkan beberapa kolom sekaligus.
export const ApprovalDecisionSchema = z
  .object({
    // ID permintaan izin yang sedang dijawab. Menghubungkan jawaban dengan pertanyaannya.
    approvalId: z.string().min(1),
    // approve = setuju semua, deny = tolak semua, partial = sebagian per hunk.
    decision: z.enum(["approve", "deny", "partial"]),
    // Komentar boleh kosong. Kalau kamu menolak, komentar ini dikirim ke agent
    // sebagai umpan balik supaya ia memperbaiki, bukan sekadar berhenti.
    comment: z.string().optional(),
    // z.array(...) = DAFTAR. Tiap isinya harus lolos HunkDecisionSchema.
    // Boleh kosong, karena hanya dipakai kalau decision-nya "partial".
    hunks: z.array(HunkDecisionSchema).optional(),
  })
  // .superRefine = PEMERIKSAAN LANJUTAN setelah syarat dasar di atas lolos.
  // Dibutuhkan karena aturan "partial harus punya hunk diterima DAN ditolak"
  // melibatkan dua kolom sekaligus (decision dan hunks), dan syarat per kolom
  // tidak bisa menuliskannya. Menaruhnya di sini berarti SATU aturan dipakai semua
  // pihak (laptop dan HP), tidak ada yang lupa memeriksa.
  //
  // (value, ctx) => {...} adalah "arrow function": fungsi singkat tanpa nama yang
  // kita serahkan ke Zod, lalu Zod yang memanggilnya.
  //   value = formulir yang sedang diperiksa (bentuk dasarnya sudah pasti benar)
  //   ctx   = "buku catatan" petugas, tempat menulis temuan masalah
  .superRefine((value, ctx) => {
    // PEMERIKSAAN DINI (early return): kalau bukan "partial", tidak ada yang perlu
    // dicek, langsung selesai. "!==" berarti "tidak sama dengan". Dengan begini sisa
    // kode hanya mengurus satu kasus, jadi lebih mudah dibaca.
    if (value.decision !== "partial") return;
    // Pemeriksaan hunk-nya ada di requireMixedHunks (di atas), supaya aturan yang
    // sama bisa dipakai juga oleh catatan hasil approval.resolved.
    requireMixedHunks(value.hunks, ctx, "keputusan 'partial'");
  });
// Kenapa aturannya begitu: "partial" yang semuanya diterima itu sebenarnya "approve",
// dan yang semuanya ditolak sebenarnya "deny". Kalau dibiarkan, riwayat dan laporan
// jadi membingungkan (status "diterima sebagian" padahal tidak ada yang ditolak).
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
