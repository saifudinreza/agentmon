// Membuat konfigurasi hook Claude Code yang memanggil daemon lewat hook bertipe "http".
//
// Hasilnya berupa blok `hooks` yang ditulis ke pengaturan Claude Code (`settings.json`).
// Penulisan ke pengaturan nyata pengguna (penggabungan, cadangan, uninstall) dikerjakan
// issue setup. Di sini hanya BENTUK konfigurasinya, supaya bisa dites dan diuji dengan
// Claude Code sungguhan.
//
// Prinsip anti-macet (PRD bagian 8): konfigurasi TIDAK PERNAH memuat `onFailure: "block"`.
// Tanpa pilihan itu, hook yang gagal (daemon mati, timeout, jawaban rusak, token salah)
// hanya dianggap kesalahan tanpa pemblokiran, dan alur izin normal Claude Code berjalan.
import { DEFAULT_PORT } from "./daemon";

// Event yang dipakai kontrak pesan (paket shared):
//   SessionStart -> session.started        PreToolUse + PostToolUse -> tool.requested/completed
//   PermissionRequest -> approval.*        Notification -> agent.notification
//   Stop -> agent.stopped                  SessionEnd -> session.recap
// UserPromptSubmit sengaja TIDAK didaftarkan: tidak ada event kontrak yang memakainya,
// dan isinya adalah teks perintah pengguna, jadi tidak perlu dikirim ke daemon.
export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

// Sama dengan bawaan Claude Code untuk hook http (600 detik). Menahan keputusan dari HP
// butuh waktu panjang. Batas tunggu internal daemon harus lebih pendek dari angka ini
// (dikerjakan issue approval).
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

export type HookConfigOptions = {
  port?: number;
  token: string;
  timeoutSeconds?: number;
};

type HttpHook = {
  type: "http";
  url: string;
  headers: { Authorization: string };
  timeout: number;
};

export type ClaudeHookSettings = {
  hooks: Record<(typeof HOOK_EVENTS)[number], { hooks: HttpHook[] }[]>;
};

export function buildClaudeHookSettings(options: HookConfigOptions): ClaudeHookSettings {
  const port = options.port ?? DEFAULT_PORT;
  const timeout = options.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS;

  // Salah isi di sini akan menghasilkan hook yang gagal diam-diam, jadi ditolak sejak awal.
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port tidak valid: ${port}`);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Token harus 64 karakter heksadesimal");
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error(`Batas waktu tidak valid: ${timeout}`);

  // Alamat memakai 127.0.0.1, bukan "localhost": daemon hanya mendengarkan di IPv4,
  // sedangkan di sebagian komputer "localhost" diarahkan ke IPv6 lebih dulu.
  const handler: HttpHook = {
    type: "http",
    url: `http://127.0.0.1:${port}/hook`,
    headers: { Authorization: `Bearer ${options.token}` },
    timeout,
  };

  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [{ ...handler }] }]]));
  return { hooks } as ClaudeHookSettings;
}
