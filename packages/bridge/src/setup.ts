// =====================================================================================
// FILE INI: perintah `setup` = "TUKANG PASANG" yang menyambungkan Claude Code ke daemon dengan satu perintah.
// =====================================================================================
//
// Yang dikerjakan (PRD FR-50 sampai FR-53, FR-58):
//   1. Mendeteksi agent yang terpasang (Claude Code; Codex hanya dideteksi, jalurnya tahap 7).
//   2. Menulis hook `http` ke pengaturan TINGKAT PENGGUNA Claude Code (`~/.claude/settings.json`), berisi alamat 127.0.0.1,
//      port, dan token daemon. Tidak pernah ke dalam repo proyek.
//   3. Menggabungkannya dengan pengaturan yang ada (milik pengguna tetap utuh), dengan cadangan, dan IDEMPOTEN: dijalankan
//      dua kali tidak membuat hook ganda dan tidak menulis ulang apa pun.
//   4. Menampilkan ringkasan dan QR pairing.
//
// Karena berkas pengaturan memuat TOKEN: izinnya dipertahankan (berkas baru dibuat 0600), isinya tidak pernah dicetak atau
// dicatat ke log, dan penulisan dilakukan atomik (berkas sementara lalu diganti) supaya tidak pernah setengah tertulis.
import { constants, accessSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_PORT } from "./daemon";
import { buildClaudeHookSettings, HOOK_EVENTS, type ClaudeHookSettings } from "./hook-config";
import { loadOrCreateToken } from "./home";
import { runPair, type PairOptions } from "./pairing";
import { resolveRelayConfig } from "./relay-config";

// ---- Penggabungan ---------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Apakah ini hook buatan AgentMon? Dikenali dari bentuknya (hook `http` ke 127.0.0.1 dengan jalur /hook), bukan dari penanda
 * tambahan, karena Claude Code bisa menolak kolom yang tidak dikenal. Port apa pun dianggap milik kita supaya setup ulang
 * setelah ganti port menggantikan yang lama, bukan menambah.
 */
export function isAgentmonHook(hook: unknown): boolean {
  return isObject(hook) && hook.type === "http" && typeof hook.url === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/hook$/.test(hook.url);
}

export type MergeResult = { ok: true; settings: Json; changed: boolean } | { ok: false; reason: string };

/** Membuang semua hook AgentMon dari objek `hooks`. Mengembalikan objek baru; yang bukan milik kita tidak disentuh. */
function stripOurs(hooks: Json): { hooks: Json } | { error: string } {
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return { error: `hooks.${event} bukan daftar` };
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group); // bentuk yang tidak kita kenal: biarkan apa adanya
        continue;
      }
      const remaining = group.hooks.filter((h) => !isAgentmonHook(h));
      if (remaining.length === group.hooks.length) kept.push(group);
      else if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
      // grup yang isinya hanya hook kita: dibuang
    }
    if (kept.length > 0) out[event] = kept;
  }
  return { hooks: out };
}

function hooksOf(existing: unknown): { root: Json; hooks: Json } | { error: string } {
  if (existing === undefined) return { root: {}, hooks: {} };
  if (!isObject(existing)) return { error: "isi settings.json bukan objek JSON" };
  const hooks = existing.hooks;
  if (hooks === undefined) return { root: existing, hooks: {} };
  if (!isObject(hooks)) return { error: "kolom \"hooks\" di settings.json bukan objek" };
  return { root: existing, hooks };
}

/** Menggabungkan hook AgentMon ke pengaturan yang ada tanpa menyentuh yang lain. Idempoten. */
export function mergeAgentmonHooks(existing: unknown, ours: ClaudeHookSettings): MergeResult {
  const parsed = hooksOf(existing);
  if ("error" in parsed) return { ok: false, reason: parsed.error };
  const stripped = stripOurs(parsed.hooks);
  if ("error" in stripped) return { ok: false, reason: stripped.error };
  const merged: Json = { ...stripped.hooks };
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : [];
    merged[event] = [...groups, ...ours.hooks[event]];
  }
  const settings: Json = { ...parsed.root, hooks: merged };
  return { ok: true, settings, changed: JSON.stringify(settings) !== JSON.stringify(existing ?? {}) };
}

/** Kebalikan `mergeAgentmonHooks` (dipakai perintah uninstall): hanya membuang hook AgentMon. */
export function removeAgentmonHooks(existing: unknown): MergeResult {
  const parsed = hooksOf(existing);
  if ("error" in parsed) return { ok: false, reason: parsed.error };
  const stripped = stripOurs(parsed.hooks);
  if ("error" in stripped) return { ok: false, reason: stripped.error };
  const settings: Json = { ...parsed.root };
  if (Object.keys(stripped.hooks).length > 0) settings.hooks = stripped.hooks;
  else delete settings.hooks;
  return { ok: true, settings, changed: JSON.stringify(settings) !== JSON.stringify(existing ?? {}) };
}

// ---- Berkas ------------------------------------------------------------------------------------------------------------------

type Format = { indent: string | number; eol: string; bom: boolean; finalNewline: boolean };

/** Meniru gaya berkas yang ada supaya perbedaannya hanya pada hook (indentasi, akhir baris, BOM, baris akhir). */
function detectFormat(text: string): Format {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const indent = /^([ \t]+)"/m.exec(body)?.[1] ?? 2;
  return { indent, eol: body.includes("\r\n") ? "\r\n" : "\n", bom, finalNewline: body.endsWith("\n") || body.trim() === "" };
}

function serialize(settings: Json, format: Format): string {
  const text = JSON.stringify(settings, null, format.indent).replace(/\n/g, format.eol);
  return `${format.bom ? String.fromCharCode(0xfeff) : ""}${text}${format.finalNewline ? format.eol : ""}`;
}

export type WriteOutcome = { written: boolean; backup?: string };

/**
 * Menulis pengaturan secara atomik. Berkas yang sudah ada dicadangkan dulu dan izinnya dipertahankan; berkas baru dibuat 0600.
 * Berkas sementara ada di folder yang sama (bukan /tmp) supaya penggantiannya satu langkah dan izinnya sama.
 */
function writeSettings(file: string, text: string, stamp: string): WriteOutcome {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  let backup: string | undefined;
  if (existsSync(file)) {
    mode = statSync(file).mode & 0o777;
    backup = `${file}.agentmon-backup-${stamp}`;
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
  }
  const temp = `${file}.agentmon-tmp-${process.pid}`;
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    try {
      chmodSync(temp, mode); // izin yang sama dengan berkas aslinya, tidak lebih longgar (diabaikan di Windows)
    } catch {
      /* Windows */
    }
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* tidak ada yang dibersihkan */
    }
    throw error;
  }
  return { written: true, ...(backup ? { backup } : {}) };
}

// ---- Deteksi -----------------------------------------------------------------------------------------------------------------

/** Mencari program di PATH tanpa menjalankannya. */
export function findOnPath(names: readonly string[], env: Record<string, string | undefined>): string | undefined {
  const pathText = env.PATH ?? env.Path ?? env.path ?? "";
  for (const dir of pathText.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.F_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* lanjut */
      }
    }
  }
  return undefined;
}

/** Apakah ada yang mendengarkan di 127.0.0.1:port? Hanya mencoba tersambung, tidak mengirim apa pun. */
export function isPortOpen(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ---- Perintah -----------------------------------------------------------------------------------------------------------------

export type SetupOptions = {
  home: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Folder pengaturan Claude Code. Bawaan: CLAUDE_CONFIG_DIR atau ~/.claude. */
  claudeDir?: string;
  port?: number;
  dryRun?: boolean;
  /** Lewati QR pairing (mis. HP sudah terpasang). */
  noPair?: boolean;
  now?: () => Date;
  /** Hanya untuk test. */
  findProgram?: (names: readonly string[]) => string | undefined;
  portOpen?: (port: number) => Promise<boolean>;
  pair?: (options: PairOptions) => Promise<number>;
  pairOverrides?: Partial<PairOptions>;
};

const pad = (n: number) => String(n).padStart(2, "0");
const stampOf = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Mengembalikan kode keluar: 0 = berhasil, 1 = gagal atau prasyarat kurang. */
export async function runSetup(options: SetupOptions): Promise<number> {
  const { out, err, env } = options;
  const find = options.findProgram ?? ((names: readonly string[]) => findOnPath(names, env));
  const claudeDir = options.claudeDir ?? env.CLAUDE_CONFIG_DIR?.trim() ?? join(homedir(), ".claude");
  const settingsFile = join(claudeDir, "settings.json");
  const port = options.port ?? DEFAULT_PORT;

  // 1. Deteksi agent.
  const claudeProgram = find(["claude", "claude.cmd", "claude.exe", "claude.ps1"]);
  const claudeKnown = Boolean(claudeProgram) || existsSync(claudeDir);
  const codexProgram = find(["codex", "codex.cmd", "codex.exe", "codex.ps1"]);
  if (!claudeKnown) {
    err("Claude Code tidak ditemukan di komputer ini (tidak ada program `claude` di PATH dan tidak ada folder pengaturannya).");
    err(`  Pasang Claude Code dulu, jalankan sekali, lalu ulangi setup. Folder yang dicari: ${claudeDir}`);
    err("  Bila pengaturannya di tempat lain, isi CLAUDE_CONFIG_DIR atau pakai --claude-dir <folder>.");
    return 1;
  }
  out(`Claude Code: terdeteksi${claudeProgram ? "" : " (hanya folder pengaturannya)"}`);
  if (codexProgram) out("Codex: terdeteksi, tetapi belum didukung (jalurnya menyusul di tahap 7)");

  // 2. Token dan konfigurasi hook. Token dibuat bila daemon belum pernah dijalankan (daemon memakainya ulang).
  let hookSettings: ClaudeHookSettings;
  try {
    hookSettings = buildClaudeHookSettings({ port, token: loadOrCreateToken(options.home) });
  } catch (error) {
    err(`Tidak bisa menyiapkan konfigurasi hook: ${error instanceof Error ? error.message.replace(/[0-9a-f]{64}/gi, "***") : String(error)}`);
    return 1;
  }

  // 3. Gabungkan dengan pengaturan yang ada.
  let existing: unknown;
  let format: Format = { indent: 2, eol: "\n", bom: false, finalNewline: true };
  if (existsSync(settingsFile)) {
    let text: string;
    try {
      text = readFileSync(settingsFile, "utf8");
    } catch {
      err(`Pengaturan Claude Code tidak bisa dibaca: ${settingsFile}`);
      return 1;
    }
    format = detectFormat(text);
    const body = format.bom ? text.slice(1) : text;
    if (body.trim() !== "") {
      try {
        existing = JSON.parse(body);
      } catch {
        err(`Pengaturan Claude Code bukan JSON yang sah: ${settingsFile}`);
        err("  Setup tidak mengubah apa pun. Perbaiki berkas itu (atau pindahkan), lalu ulangi.");
        return 1;
      }
    }
  }
  const merged = mergeAgentmonHooks(existing, hookSettings);
  if (!merged.ok) {
    err(`Pengaturan Claude Code tidak dikenali (${merged.reason}): ${settingsFile}`);
    err("  Setup tidak mengubah apa pun, supaya pengaturan Anda tidak rusak.");
    return 1;
  }

  const events = HOOK_EVENTS.length;
  if (!merged.changed) {
    out(`Hook: sudah terpasang dan mutakhir di ${settingsFile} (tidak ada yang diubah)`);
  } else if (options.dryRun) {
    out(`Hook: AKAN dipasang (${events} event) di ${settingsFile} [--dry-run: tidak ada yang ditulis]`);
  } else {
    try {
      const outcome = writeSettings(settingsFile, serialize(merged.settings, format), stampOf((options.now ?? (() => new Date()))()));
      out(`Hook: terpasang (${events} event) di ${settingsFile}`);
      if (outcome.backup) out(`Cadangan pengaturan lama: ${outcome.backup}`);
    } catch (error) {
      err(`Gagal menulis pengaturan Claude Code: ${error instanceof Error ? error.message.replace(/[0-9a-f]{64}/gi, "***") : String(error)}`);
      return 1;
    }
  }
  out("Hook ini berlaku untuk SEMUA sesi Claude Code Anda. Bila daemon tidak berjalan, hook gagal dengan tenang dan Claude Code berjalan seperti biasa.");
  out("Berkas pengaturan memuat token daemon: jangan dibagikan atau dimasukkan ke repo.");

  // 4. Daemon dan pairing.
  const open = await (options.portOpen ?? isPortOpen)(port);
  if (open) out(`Daemon: berjalan di 127.0.0.1:${port}`);
  else {
    out(`Daemon: belum berjalan. Nyalakan dengan: pnpm --filter @agentmon/bridge daemon`);
    out("  Agar izin bisa dijawab dari HP, jalankan dengan AGENTMON_HOLD=1. Sesi Claude Code yang SUDAH terbuka perlu dimulai ulang agar memuat hook.");
  }

  if (options.noPair || options.dryRun) {
    out(options.dryRun ? "Pairing dilewati (--dry-run)." : "Pairing dilewati (--no-pair).");
    return 0;
  }
  let relay;
  try {
    relay = resolveRelayConfig(env, options.home);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!relay) {
    out("Pairing: laptop ini belum terdaftar ke relay. Daftarkan dulu dengan perintah `register`, lalu jalankan `pair` untuk QR.");
    return 0;
  }
  const appUrl = env.AGENTMON_APP_URL?.trim();
  if (!appUrl) {
    out("Pairing: isi AGENTMON_APP_URL (alamat aplikasi HP), lalu jalankan `pair` untuk QR.");
    return 0;
  }
  out("Pairing: pindai QR berikut dengan HP Anda.");
  return (options.pair ?? runPair)({ relayUrl: relay.relayUrl, machineToken: relay.token, appUrl, out, err, ...options.pairOverrides });
}
