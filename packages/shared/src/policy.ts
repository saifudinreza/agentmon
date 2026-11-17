// =====================================================================================
// FILE INI: bentuk berkas aturan policy (`~/.agentmon/policy.json`). Logika evaluasinya ada di paket bridge; bentuk
// datanya di sini supaya HP (menampilkan aturan aktif) dan laptop memakai definisi yang sama.
// =====================================================================================
import { z } from "zod";

export const POLICY_VERSION = 1;
/** Berkas lebih besar dari ini dianggap rusak (bukan dibaca separuh). */
export const MAX_POLICY_BYTES = 256 * 1024;
export const MAX_RULES = 200;

// Pola perintah hanya berisi kata biasa (dan `*` di akhir). Karakter shell tidak boleh: pola "npm test; rm -rf x" tidak
// pernah cocok dengan satu perintah dan hanya akan menyesatkan pembacanya.
const SHELL_META = /[;&|<>$`()\\\n\r]/;

const CommandPattern = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => /^[\x20-\x7e]+$/.test(p), "pola perintah hanya boleh huruf, angka, dan tanda baca ASCII biasa")
  .refine((p) => !p.trimStart().startsWith("*"), "pola harus diawali nama perintah: tidak ada \"izinkan semua perintah\"")
  .refine((p) => !SHELL_META.test(p), "pola perintah tidak boleh memuat karakter shell (; & | < > $ ` ( ) \\)")
  .refine((p) => !p.slice(0, -1).includes("*") && !/\S\*$/.test(p), "tanda * hanya boleh berdiri sendiri sebagai kata terakhir");

// Pola jalur dibatasi supaya pencocokan tidak bisa dibuat mahal (ReDoS): paling banyak 4 tanda wildcard, dan `**` paling banyak 2.
const wildcards = (p: string) => (p.match(/\*+|\?/g) ?? []).length;
const PathPattern = z.string().min(1).max(300).refine((p) => wildcards(p) <= 4 && (p.match(/\*\*/g) ?? []).length <= 2, "pola jalur terlalu rumit (maksimal 4 wildcard, 2 di antaranya **)").refine((p) => !p.includes("\0") && !p.includes("\\") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p), "pola jalur relatif terhadap proyek dan memakai /");

export const RuleSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "id: huruf, angka, titik, garis, maksimal 64 karakter"),
    action: z.enum(["allow", "ask", "deny"]),
    /** Nama alat persis (tanpa membedakan huruf besar kecil), atau `*` untuk semua alat. */
    tool: z.string().min(1).max(64).refine((t) => t === t.trim(), "nama alat tidak boleh diawali atau diakhiri spasi"),
    /** Hanya untuk Bash/PowerShell: tiap pola dicocokkan dengan SATU perintah (bukan rangkaian). */
    commands: z.array(CommandPattern).min(1).max(100).optional(),
    /** Hanya untuk alat berkas: pola jalur relatif terhadap proyek (`*`, `**`, `?`). */
    paths: z.array(PathPattern).min(1).max(100).optional(),
    note: z.string().max(300).optional(),
  })
  .refine((r) => !(r.commands && r.paths), "satu aturan tidak boleh memakai commands dan paths sekaligus");

export type Rule = z.infer<typeof RuleSchema>;

export const PolicyFileSchema = z
  .strictObject({
    version: z.literal(POLICY_VERSION),
    rules: z.array(RuleSchema).max(MAX_RULES),
  })
  .refine((f) => new Set(f.rules.map((r) => r.id)).size === f.rules.length, "id aturan harus unik");

export type PolicyFile = z.infer<typeof PolicyFileSchema>;

