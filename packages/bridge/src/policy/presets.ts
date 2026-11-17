// =====================================================================================
// FILE INI: preset aturan contoh. TIDAK AKTIF secara default: tidak ada yang dipasang ke ~/.agentmon/policy.json
// kecuali pengguna sendiri yang menyalinnya (`agentmon policy preset <nama>` hanya MENCETAK isinya).
// =====================================================================================
import type { PolicyFile } from "./config";

export type Preset = { description: string; file: PolicyFile };

export const PRESETS: Record<string, Preset> = {
  "baca-saja": {
    description: "Perintah git dan folder yang hanya membaca.",
    file: {
      version: 1,
      rules: [{ id: "baca-saja", action: "allow", tool: "Bash", commands: ["git status", "git diff *", "git log *", "ls *", "pwd"] }],
    },
  },
  "tes-dan-lint": {
    description: "Menjalankan tes, lint, dan typecheck lewat npm atau pnpm. Catatan: skrip ini menjalankan kode proyek; bila package.json berubah di sesi yang sama, izinnya ditangguhkan.",
    file: {
      version: 1,
      rules: [{ id: "tes-dan-lint", action: "allow", tool: "Bash", commands: ["npm test", "pnpm test", "npm run lint", "pnpm lint", "npm run typecheck", "pnpm typecheck"] }],
    },
  },
  "edit-di-proyek": {
    description: "Mengubah berkas di src/ dan docs/ tanpa bertanya. Berkas rahasia, skrip build (package.json, Makefile, ...), dan di luar proyek tetap ditanyakan. PERHATIAN: bila digabung dengan tes-dan-lint, agent bisa mengubah berkas tes lalu menjalankannya (sama dengan menjalankan kode bebas); pilih salah satu bila ragu.",
    file: {
      version: 1,
      rules: [{ id: "edit-src-docs", action: "allow", tool: "*", paths: ["src/**", "docs/**"] }],
    },
  },
};
