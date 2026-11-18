// =====================================================================================
// FILE INI: autostart = "ALARM" yang menyalakan daemon sendiri saat Anda masuk ke laptop, dan menyalakannya lagi bila mati.
// =====================================================================================
//
// Mengapa perlu: daemon yang berhenti membuat HP melihat laptop "Offline" dan sesi Claude Code tidak terdeteksi. Sampai issue ini,
// daemon hanya hidup selama terminalnya terbuka.
//
// Mekanisme per pengguna, TANPA hak admin (PRD FR-52):
//   - macOS   : LaunchAgent (~/Library/LaunchAgents). RunAtLoad + KeepAlive: menyala saat login, dinyalakan lagi bila berhenti.
//   - Linux   : unit systemd PENGGUNA (~/.config/systemd/user). Restart=always. Menyala saat login; untuk menyala saat boot
//               tanpa login, pengguna perlu `loginctl enable-linger` (kami hanya memberi tahu, tidak mengubahnya).
//   - Windows : kunci Run milik pengguna (HKCU) yang menjalankan skrip VBS tersembunyi (wscript //B). Skrip itu menjalankan daemon
//               TANPA jendela dan mengulang bila berhenti. (Penjadwal Tugas dengan "saat masuk" butuh hak admin; folder Startup dan
//               kunci Run tidak.)
//
// Yang ditulis ke berkas hanyalah perintah, folder, dan beberapa variabel non-rahasia (AGENTMON_HOME, AGENTMON_PORT, AGENTMON_HOLD).
// Token dan alamat relay TIDAK ditulis: daemon membacanya dari ~/.agentmon.
//
// Daemon dijalankan dari salinan kode ini (node + tsx + src/main.ts), jadi bila folder proyek dipindah atau dependensi diperbarui,
// jalankan `autostart install` lagi.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./daemon";
import { agentmonHome } from "./home";
import { isPortOpen } from "./setup";

export type Platform = "win32" | "darwin" | "linux";

/** Perintah yang menjalankan daemon. Semua path absolut. */
export type DaemonLaunch = {
  node: string;
  /** Argumen sesudah node: skrip tsx dan titik masuk daemon. */
  args: string[];
  cwd: string;
  /** Variabel lingkungan non-rahasia yang ikut dibawa. */
  env: Record<string, string>;
};

export const LABEL = "dev.agentmon.daemon";
export const SYSTEMD_UNIT = "agentmon.service";
export const WINDOWS_RUN_NAME = "AgentMon";
export const WINDOWS_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_VBS_NAME = "agentmon-daemon.vbs";

// ---- Perintah peluncur ----------------------------------------------------------------------------------------------------

export type LaunchOptions = { env: Record<string, string | undefined>; hold: boolean };

/** Menyusun perintah daemon dari lokasi kode ini. Melempar galat bila tsx atau titik masuknya tidak ditemukan. */
export function resolveDaemonLaunch(options: LaunchOptions): DaemonLaunch {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = join(here, "main.ts");
  const cwd = resolve(here, "..");
  // Tautan node_modules/tsx stabil antar versi (jalur di penyimpanan pnpm memuat nomor versi).
  const tsx = join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(main)) throw new Error(`Titik masuk daemon tidak ditemukan: ${main}`);
  if (!existsSync(tsx)) throw new Error(`tsx tidak ditemukan di ${tsx}. Jalankan pnpm install dulu.`);
  const env: Record<string, string> = {};
  const home = options.env.AGENTMON_HOME?.trim();
  if (home) env.AGENTMON_HOME = resolve(home);
  const port = options.env.AGENTMON_PORT?.trim();
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`AGENTMON_PORT tidak valid: ${port}`);
    env.AGENTMON_PORT = String(n);
  }
  if (options.hold) env.AGENTMON_HOLD = "1";
  return { node: process.execPath, args: [tsx, main], cwd, env };
}

/** Karakter yang tidak bisa dikutip dengan aman di salah satu format: ditolak sejak awal. */
function assertSafe(launch: DaemonLaunch): void {
  for (const value of [launch.node, launch.cwd, ...launch.args, ...Object.values(launch.env)]) {
    if (/[\r\n\0"]/.test(value)) throw new Error(`Path atau nilai memuat karakter yang tidak didukung (tanda kutip atau baris baru): ${value.replace(/[\r\n\0]/g, "?")}`);
  }
}

// ---- Pembuat berkas ---------------------------------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * LaunchAgent macOS: menyala saat login dan SELALU dinyalakan lagi bila berhenti. Daemon yang mendapati daemon lain sedang berjalan
 * keluar dengan kode 0, jadi `SuccessfulExit=false` akan membuat autostart mati diam-diam sampai login berikutnya. Berhenti sungguhan
 * dilakukan lewat `autostart remove` (bootout), bukan dengan membunuh prosesnya.
 */
export function buildLaunchAgentPlist(launch: DaemonLaunch): string {
  assertSafe(launch);
  const env = Object.entries(launch.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const args = [launch.node, ...launch.args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(launch.cwd)}</string>
${env ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n` : ""}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Adaptive</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

// systemd: tanda kutip ganda, dan `%` serta `$` punya arti khusus.
const systemdArg = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const systemdEnv = (k: string, v: string) => `Environment="${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** Unit systemd pengguna: dinyalakan lagi 5 detik setelah berhenti, apa pun sebabnya (kode 0 pun, lihat catatan plist). `systemctl stop` tetap menghentikannya. */
export function buildSystemdUnit(launch: DaemonLaunch): string {
  assertSafe(launch);
  const env = Object.entries(launch.env).map(([k, v]) => systemdEnv(k, v));
  return `[Unit]
Description=AgentMon daemon (menghubungkan agent ke HP Anda)

[Service]
Type=simple
ExecStart=${[launch.node, ...launch.args].map(systemdArg).join(" ")}
WorkingDirectory=${launch.cwd.replace(/%/g, "%%")}
${env.length ? `${env.join("\n")}\n` : ""}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

const vbs = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Skrip VBS untuk Windows: menjalankan daemon TANPA jendela (gaya jendela 0) dan menunggu sampai berhenti, lalu mengulang.
 * Bila daemon berhenti kurang dari 20 detik setelah mulai (galat atau sudah ada yang berjalan), jeda ulang 30 detik supaya
 * tidak berputar cepat; selain itu 3 detik.
 */
export function buildWindowsLauncher(launch: DaemonLaunch): string {
  assertSafe(launch);
  // WScript.Shell.Run mengekspansi %VARIABEL% di baris perintah: path yang memuat % akan berubah makna.
  for (const value of [launch.node, launch.cwd, ...launch.args]) {
    if (value.includes("%")) throw new Error(`Path memuat tanda % yang tidak didukung di Windows: ${value}`);
  }
  const commandLine = [launch.node, ...launch.args].map((a) => `"${a}"`).join(" ");
  const env = Object.entries(launch.env).map(([k, v]) => `proc("${k}") = ${vbs(v)}`);
  return [
    "' AgentMon: menjalankan daemon tanpa jendela dan menyalakannya lagi bila berhenti. Dibuat oleh `autostart install`.",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "Set proc = shell.Environment(\"Process\")",
    ...env,
    `shell.CurrentDirectory = ${vbs(launch.cwd)}`,
    "Do",
    "  started = Timer",
    `  shell.Run ${vbs(commandLine)}, 0, True`,
    "  elapsed = Timer - started",
    "  If elapsed < 0 Then elapsed = elapsed + 86400", // Timer kembali ke 0 tengah malam
    "  If elapsed < 20 Then",
    "    WScript.Sleep 30000",
    "  Else",
    "    WScript.Sleep 3000",
    "  End If",
    "Loop",
    "",
  ].join("\r\n");
}

/** wscript membaca .vbs sebagai ANSI kecuali berkasnya UTF-16 dengan BOM; path dengan huruf non-ASCII butuh itu. */
export const encodeVbs = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

export const windowsRunValue = (vbsPath: string) => `wscript.exe //B //Nologo "${vbsPath}"`;

// ---- Operasi per OS -----------------------------------------------------------------------------------------------------------

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

export const defaultExec: Exec = (file, args) =>
  new Promise((resolveExec) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, encoding: "utf8" }, (error, stdout, stderr) => {
      // `error.code` berupa angka (kode keluar program) atau teks (ENOENT bila programnya tidak ada).
      const raw = (error as { code?: unknown } | null)?.code;
      const code = error ? (typeof raw === "number" ? raw : 1) : 0;
      resolveExec({ code, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || "") });
    });
  });

export type AutostartOptions = {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  hold?: boolean;
  platform?: Platform;
  /** Folder rumah pengguna (hanya untuk test). */
  homeDir?: string;
  /** Folder data AgentMon (tempat skrip Windows disimpan). */
  dataDir?: string;
  exec?: Exec;
  spawnDetached?: (file: string, args: string[]) => void;
  launch?: DaemonLaunch;
  uid?: number;
  userName?: string;
  portOpen?: (port: number) => Promise<boolean>;
  /** Berapa lama menunggu daemon menjawab setelah dinyalakan (milidetik, bawaan 10000). Hanya untuk test. */
  startWaitMs?: number;
};

export type AutostartStatus = { supported: boolean; enabled: boolean; mechanism: string; detail?: string };

const ctx = (o: AutostartOptions) => ({
  platform: o.platform ?? (process.platform as Platform),
  home: o.homeDir ?? homedir(),
  // Selalu absolut: nilai Run yang memuat path relatif akan gagal diam-diam saat login (folder kerja berbeda).
  data: resolve(o.dataDir ?? (o.env.AGENTMON_HOME?.trim() ? o.env.AGENTMON_HOME : agentmonHome())),
  exec: o.exec ?? defaultExec,
  spawnDetached:
    o.spawnDetached ??
    ((file: string, args: string[]) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => undefined); // galat start (program tidak ada) dilaporkan lewat pemeriksaan "daemon menjawab", bukan melempar
      child.unref();
    }),
});

const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = (home: string, env: Record<string, string | undefined>) => {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // Spesifikasi XDG: nilai relatif tidak sah dan diabaikan.
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "systemd", "user", SYSTEMD_UNIT);
};
const vbsPath = (data: string) => join(data, "autostart", WINDOWS_VBS_NAME);

// PowerShell menganggap ‘ ’ ‚ ‛ (U+2018, U+2019, U+201A, U+201B) sama dengan apostrof: ikut digandakan, kalau tidak, satu apostrof
// tipografis di path (mis. nama pengguna O’Brien) menutup string dan sisanya dijalankan sebagai perintah.
const PS_QUOTES = new RegExp(`['${[0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c)).join("")}]`, "g");
export const psQuote = (s: string) => `'${s.replace(PS_QUOTES, (q) => q + q)}'`;
const powershell = (exec: Exec, script: string) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
/**
 * Menghentikan peluncur yang menjalankan skrip INI (beserta daemon di bawahnya), bukan peluncur AgentMon milik folder data lain.
 * Selalu keluar 0: tidak ada yang dihentikan bukan galat.
 */
export const killScript = (script: string) =>
  `$p = [WildcardPattern]::Escape(${psQuote(script)}); Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -like ('*' + $p + '*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }; exit 0`;
const STARTUP_APPROVED = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
/**
 * Mencetak nilai kunci Run kita, lalu DISABLED bila pengguna mematikannya di Pengaturan > Aplikasi Startup. Selalu keluar 0.
 * Keluaran dipaksa UTF-8: tanpa itu PowerShell memakai kodepage OEM lewat pipa dan path berhuruf non-ASCII (Müller, O’Brien)
 * berubah, sehingga nilai Run kita tidak dikenali lagi.
 */
const READ_RUN_SCRIPT = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $v = (Get-ItemProperty -Path ${psQuote(WINDOWS_RUN_KEY)} -Name ${WINDOWS_RUN_NAME} -ErrorAction SilentlyContinue).${WINDOWS_RUN_NAME}; "$v"; $a = (Get-ItemProperty -Path ${psQuote(STARTUP_APPROVED)} -Name ${WINDOWS_RUN_NAME} -ErrorAction SilentlyContinue).${WINDOWS_RUN_NAME}; if ($a -and ($a[0] -band 1)) { 'DISABLED' }; exit 0`;

async function readRun(exec: Exec): Promise<{ value: string; disabled: boolean }> {
  const r = await powershell(exec, READ_RUN_SCRIPT);
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
  return { value: lines[0] ?? "", disabled: lines.includes("DISABLED") };
}

function writeFile(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows */
  }
}

// ---- Status ----------------------------------------------------------------------------------------------------------------------

export async function autostartStatus(options: AutostartOptions): Promise<AutostartStatus> {
  const c = ctx(options);
  if (c.platform === "darwin") {
    const file = plistPath(c.home);
    if (!existsSync(file)) return { supported: true, enabled: false, mechanism: "LaunchAgent" };
    const loaded = await c.exec("launchctl", ["print", `gui/${options.uid ?? process.getuid?.() ?? 0}/${LABEL}`]);
    return { supported: true, enabled: true, mechanism: "LaunchAgent", detail: loaded.code === 0 ? "dimuat" : "berkas ada tetapi belum dimuat (masuk ulang atau jalankan install)" };
  }
  if (c.platform === "linux") {
    const file = unitPath(c.home, options.env);
    if (!existsSync(file)) return { supported: true, enabled: false, mechanism: "systemd (pengguna)" };
    const enabled = await c.exec("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]);
    const active = await c.exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    return { supported: true, enabled: enabled.code === 0, mechanism: "systemd (pengguna)", detail: active.stdout.trim() === "active" ? "aktif" : `tidak aktif (${active.stdout.trim() || "tidak diketahui"})` };
  }
  if (c.platform === "win32") {
    const file = vbsPath(c.data);
    const run = await readRun(c.exec);
    const mechanism = "kunci Run pengguna (skrip tersembunyi)";
    if (run.value && run.value !== windowsRunValue(file)) return { supported: true, enabled: false, mechanism, detail: `kunci Run menunjuk ke instalasi lain (${run.value})` };
    if (run.value && run.disabled) return { supported: true, enabled: false, mechanism, detail: "dimatikan di Pengaturan > Aplikasi Startup" };
    return { supported: true, enabled: Boolean(run.value) && existsSync(file), mechanism };
  }
  return { supported: false, enabled: false, mechanism: "tidak didukung di sistem operasi ini" };
}

// ---- Pasang dan copot -------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(500, Math.max(10, timeoutMs / 20)));
  }
}

/** Mengembalikan kode keluar: 0 berhasil, 1 gagal. */
export async function installAutostart(options: AutostartOptions): Promise<number> {
  const { out, err } = options;
  const c = ctx(options);
  let launch: DaemonLaunch;
  try {
    launch = options.launch ?? resolveDaemonLaunch({ env: options.env, hold: Boolean(options.hold) });
    assertSafe(launch);
  } catch (error) {
    err(`Tidak bisa menyiapkan perintah daemon: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const port = Number(launch.env.AGENTMON_PORT) || DEFAULT_PORT;
  const probe = options.portOpen ?? isPortOpen;
  const alreadyRunning = await probe(port); // daemon yang dijalankan manual?

  if (c.platform === "darwin") {
    const file = plistPath(c.home);
    const uid = options.uid ?? process.getuid?.() ?? 0;
    writeFile(file, buildLaunchAgentPlist(launch));
    await c.exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]); // memuat ulang bila sudah ada; galatnya tidak penting
    const boot = await c.exec("launchctl", ["bootstrap", `gui/${uid}`, file]);
    if (boot.code !== 0) {
      err(`launchctl gagal memuat LaunchAgent (${boot.code}): ${boot.stderr.trim() || "tanpa pesan"}`);
      err(`  Berkasnya sudah ditulis di ${file}; daemon akan menyala saat Anda masuk lagi.`);
      return 1;
    }
    out(`Autostart terpasang (LaunchAgent): ${file}`);
    out("Daemon dinyalakan sekarang dan setiap kali Anda masuk, dan dinyalakan lagi bila berhenti.");
  } else if (c.platform === "linux") {
    const probe = await c.exec("systemctl", ["--user", "show-environment"]);
    if (probe.code !== 0) {
      err("systemd pengguna tidak tersedia (perintah `systemctl --user` gagal). Autostart otomatis hanya mendukung systemd.");
      err("  Alternatif: tambahkan perintah daemon ke program yang dijalankan saat login desktop Anda.");
      return 1;
    }
    const file = unitPath(c.home, options.env);
    writeFile(file, buildSystemdUnit(launch));
    const steps: [string, string[]][] = [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]],
    ];
    for (const [file2, args] of steps) {
      const r = await c.exec(file2, args);
      if (r.code !== 0) {
        err(`${file2} ${args.join(" ")} gagal (${r.code}): ${r.stderr.trim() || "tanpa pesan"}`);
        return 1;
      }
    }
    out(`Autostart terpasang (systemd pengguna): ${file}`);
    out("Daemon dinyalakan sekarang dan setiap kali Anda masuk, dan dinyalakan lagi 5 detik setelah berhenti.");
    const linger = await c.exec("loginctl", ["show-user", options.userName ?? userInfo().username, "--property=Linger"]);
    if (/Linger=no/.test(linger.stdout)) out("Catatan: daemon belum menyala saat laptop baru hidup sebelum Anda masuk. Untuk itu jalankan sekali: loginctl enable-linger $USER");
  } else if (c.platform === "win32") {
    const script = vbsPath(c.data);
    // VBScript sedang dihapus bertahap oleh Microsoft: tanpa wscript.exe peluncur ini tidak bisa jalan.
    const where = await c.exec("where.exe", ["wscript.exe"]);
    if (where.code !== 0) {
      err("wscript.exe tidak ditemukan (VBScript mungkin dinonaktifkan di Windows ini), jadi peluncur tersembunyi tidak bisa dipasang.");
      err("  Jalankan daemon manual dengan: pnpm --filter @agentmon/bridge daemon");
      return 1;
    }
    try {
      writeFile(script, encodeVbs(buildWindowsLauncher(launch)));
    } catch (error) {
      err(`Tidak bisa membuat skrip peluncur: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const value = windowsRunValue(script);
    const previous = await readRun(c.exec);
    const set = await powershell(c.exec, `$ErrorActionPreference = 'Stop'; Set-ItemProperty -Path ${psQuote(WINDOWS_RUN_KEY)} -Name ${WINDOWS_RUN_NAME} -Value ${psQuote(value)}`);
    if (set.code !== 0) {
      err(`Gagal menulis kunci Run pengguna (${set.code}): ${set.stderr.trim() || "tanpa pesan"}`);
      return 1;
    }
    if (previous.value && previous.value !== value) {
      out(`Catatan: kunci Run yang sebelumnya menunjuk ke instalasi lain DIGANTIKAN: ${previous.value}`);
      out("  Peluncur instalasi lain yang sedang berjalan tidak dihentikan; ia berhenti saat Anda mencopotnya dari folder datanya.");
    }
    await powershell(c.exec, killScript(script)); // peluncur lama dari folder data INI diganti, bukan ditumpuk
    c.spawnDetached("wscript.exe", ["//B", "//Nologo", script]);
    out(`Autostart terpasang (kunci Run pengguna): ${script}`);
    out("Daemon dinyalakan sekarang tanpa jendela terminal dan setiap kali Anda masuk, dan dinyalakan lagi bila berhenti.");
  } else {
    err(`Autostart belum didukung di sistem operasi ini (${c.platform}).`);
    return 1;
  }
  // Jangan melapor "menyala" bila belum terbukti: daemon manual yang sedang berjalan menahan port, dan yang gagal start tidak menjawab.
  if (alreadyRunning) {
    out(`Catatan: sudah ada daemon yang berjalan di 127.0.0.1:${port} (mungkin dijalankan manual). Autostart baru bertugas setelah daemon itu berhenti; hentikan dulu agar yang diawasi autostart yang aktif.`);
  } else {
    const up = await waitUntil(() => probe(port), options.startWaitMs ?? 10_000);
    if (up) out(`Daemon menjawab di 127.0.0.1:${port}.`);
    else {
      err(`Daemon belum menjawab di 127.0.0.1:${port} setelah dinyalakan. Autostart sudah terpasang, tetapi periksa ${join(c.data, "daemon.log")} dan pastikan node serta pnpm install berfungsi.`);
      return 1;
    }
  }
  if (launch.env.AGENTMON_HOLD === "1") out("Penahanan izin untuk HP: AKTIF (AGENTMON_HOLD=1).");
  else out("Penahanan izin untuk HP: mati. Pasang ulang dengan --hold bila izin harus ditunggu dari HP.");
  out("Daemon dijalankan dari salinan kode ini; jalankan `autostart install` lagi bila folder proyek dipindah atau dependensi diperbarui.");
  return 0;
}

export async function removeAutostart(options: AutostartOptions): Promise<number> {
  const { out, err } = options;
  const c = ctx(options);
  const rm = (path: string) => {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  };
  if (c.platform === "darwin") {
    const file = plistPath(c.home);
    await c.exec("launchctl", ["bootout", `gui/${options.uid ?? process.getuid?.() ?? 0}/${LABEL}`]);
    const removed = rm(file);
    out(removed ? `Autostart dicopot: ${file}` : "Autostart tidak terpasang (tidak ada yang dicopot).");
  } else if (c.platform === "linux") {
    const file = unitPath(c.home, options.env);
    if (existsSync(file)) {
      await c.exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      rm(file);
      await c.exec("systemctl", ["--user", "daemon-reload"]);
      out(`Autostart dicopot: ${file}`);
    } else out("Autostart tidak terpasang (tidak ada yang dicopot).");
  } else if (c.platform === "win32") {
    const script = vbsPath(c.data);
    const had = existsSync(script);
    const run = await readRun(c.exec);
    const ours = run.value === windowsRunValue(script);
    // Kunci Run hanya satu per pengguna. Bila menunjuk ke instalasi LAIN, jangan dihapus dan jangan menghentikan apa pun milik mereka.
    if (run.value && !ours) {
      out(`Kunci Run menunjuk ke instalasi lain (${run.value}); tidak diubah.`);
    } else if (ours) {
      const del = await powershell(c.exec, `Remove-ItemProperty -Path ${psQuote(WINDOWS_RUN_KEY)} -Name ${WINDOWS_RUN_NAME} -ErrorAction SilentlyContinue; exit 0`);
      if (del.code !== 0) {
        err(`Gagal mencopot kunci Run pengguna (${del.code}): ${del.stderr.trim() || "tanpa pesan"}`);
        return 1;
      }
    }
    await powershell(c.exec, killScript(script)); // hanya peluncur dari folder data INI
    rm(script);
    out(ours || had ? `Autostart dicopot: ${script}` : "Autostart tidak terpasang (tidak ada yang dicopot).");
  } else {
    err(`Autostart belum didukung di sistem operasi ini (${c.platform}).`);
    return 1;
  }
  out("Daemon yang dinyalakan oleh autostart ikut dihentikan; daemon yang Anda jalankan sendiri di terminal tidak disentuh.");
  return 0;
}

/** Menampilkan keadaan autostart dan apakah daemon sedang menjawab. */
export async function reportAutostart(options: AutostartOptions): Promise<number> {
  const status = await autostartStatus(options);
  const port = Number(options.env.AGENTMON_PORT) || DEFAULT_PORT;
  const running = await (options.portOpen ?? isPortOpen)(port);
  if (!status.supported) options.out(`Autostart: ${status.mechanism}`);
  else if (status.enabled) options.out(`Autostart: aktif (${status.mechanism}${status.detail ? `; ${status.detail}` : ""})`);
  else options.out(`Autostart: belum dipasang (${status.mechanism}). Pasang dengan: autostart install`);
  options.out(running ? `Daemon: berjalan di 127.0.0.1:${port}` : `Daemon: tidak berjalan di 127.0.0.1:${port}`);
  return 0;
}
