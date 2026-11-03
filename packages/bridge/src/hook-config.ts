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
import { isValidToken } from "./home";

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

// Event yang menunggu keputusan manusia dari HP. Hanya dua ini yang butuh batas tunggu
// panjang. Sama dengan bawaan Claude Code untuk hook http (600 detik). Batas tunggu
// internal daemon harus lebih pendek dari angka ini (dikerjakan issue approval).
export const DECISION_EVENTS = ["PreToolUse", "PermissionRequest"] as const;
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

// Event lain hanya melapor dan tidak menunggu siapa pun. Daemon yang membeku menahan agent
// selama batas waktu hook, jadi untuk event ini dibuat pendek.
export const DEFAULT_OBSERVE_TIMEOUT_SECONDS = 10;

export type HookConfigOptions = {
  port?: number;
  token: string;
  // Batas tunggu event keputusan (PreToolUse, PermissionRequest).
  timeoutSeconds?: number;
  // Batas tunggu event pengamatan (semua event lainnya).
  observeTimeoutSeconds?: number;
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
  const observeTimeout = options.observeTimeoutSeconds ?? DEFAULT_OBSERVE_TIMEOUT_SECONDS;

  // Salah isi di sini akan menghasilkan hook yang gagal diam-diam, jadi ditolak sejak awal.
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port tidak valid: ${port}`);
  if (!isValidToken(options.token)) throw new Error("Token harus 64 karakter heksadesimal");
  for (const value of [timeout, observeTimeout]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Batas waktu tidak valid: ${value}`);
  }

  // Satu objek BARU per event (termasuk headers), supaya mengubah satu event nanti tidak
  // ikut mengubah event lain.
  // Alamat memakai 127.0.0.1, bukan "localhost": daemon hanya mendengarkan di IPv4,
  // sedangkan di sebagian komputer "localhost" diarahkan ke IPv6 lebih dulu.
  const handlerFor = (event: (typeof HOOK_EVENTS)[number]): HttpHook => ({
    type: "http",
    url: `http://127.0.0.1:${port}/hook`,
    headers: { Authorization: `Bearer ${options.token}` },
    timeout: (DECISION_EVENTS as readonly string[]).includes(event) ? timeout : observeTimeout,
  });

  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [handlerFor(event)] }]]));
  return { hooks } as ClaudeHookSettings;
}
