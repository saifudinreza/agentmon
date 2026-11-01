// FILE INI: aturan untuk "level risiko" dan "hasil policy".
//
// Alurnya di proyek AgentMon:
//   - Penilai risiko (dibuat di issue tahap 3.5) memberi tiap permintaan izin
//     level rendah / sedang / tinggi beserta alasannya.
//   - Policy engine (tahap 4.5) lalu memutuskan: izinkan otomatis, tanya kamu,
//     atau tolak otomatis. Hasilnya dicatat sebagai PolicyResult.
// File ini hanya mendefinisikan BENTUK datanya. Logika penilaiannya dibuat nanti.
//
// Dipakai oleh: events.ts (di dalam payload event approval).

// Meminjam kotak perkakas validasi Zod. Lihat penjelasan di approval.ts.
import { z } from "zod";

// Pilihan ganda: hanya tiga level yang sah. "critical" atau "extreme" ditolak.
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
// Menurunkan tipe TypeScript dari aturan di atas (lihat z.infer di approval.ts).
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// Risiko = level + daftar alasan. Alasan penting supaya kamu tidak sekadar melihat
// label "tinggi", tapi tahu KENAPA (misalnya "menyentuh file .env").
export const RiskSchema = z.object({
  level: RiskLevelSchema, // aturan lain bisa dipakai ulang sebagai bagian aturan baru
  // z.array(...) = daftar. Boleh kosong (permintaan aman tidak perlu alasan).
  reasons: z.array(
    // Tiap alasan punya dua bagian:
    z.object({
      // code = kode mesin yang stabil, mudah dicari dan dites, misalnya "secret-file".
      code: z.string().min(1),
      // message = kalimat untuk manusia, misalnya "Menyentuh file rahasia (.env)".
      message: z.string().min(1),
    }),
  ),
});
export type Risk = z.infer<typeof RiskSchema>;

// Hasil evaluasi policy: apa yang diputuskan aturan, dan aturan mana penyebabnya.
export const PolicyResultSchema = z.object({
  // allow = izinkan otomatis, ask = tanya pengguna, deny = tolak otomatis.
  action: z.enum(["allow", "ask", "deny"]),
  // null berarti hasil default, bukan dari aturan tertentu.
  // .nullable() BERBEDA dengan .optional(): kolomnya WAJIB ada, tetapi isinya boleh
  // null. Alasannya, supaya "tidak ada aturan penyebab" selalu ditulis eksplisit,
  // tidak bisa terlewat karena lupa mengisi.
  ruleId: z.string().nullable(),
});
export type PolicyResult = z.infer<typeof PolicyResultSchema>;
