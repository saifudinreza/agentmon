// FILE INI: TEST autostart (issue #044). Yang diuji:
//   - isi berkas per OS (plist, unit systemd, skrip VBS) termasuk kutipan untuk path ber-spasi dan karakter khusus,
//   - urutan perintah sistem yang dijalankan per OS (dengan exec palsu: tidak menyentuh launchctl, systemctl, atau registri asli),
//   - tidak ada rahasia (token, alamat relay) yang ditulis ke berkas autostart,
//   - perintah CLI `autostart` dan laporan `status`.
// Pemasangan SUNGGUHAN di macOS dan Linux tidak bisa dijalankan di CI Windows; yang teruji di sini adalah berkas dan perintahnya.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { startDaemon } from "./daemon";
import {
  LABEL,
  SYSTEMD_UNIT,
  WINDOWS_VBS_NAME,
  autostartStatus,
  buildLaunchAgentPlist,
  buildSystemdUnit,
  buildWindowsLauncher,
  encodeVbs,
  installAutostart,
  psQuote,
  removeAutostart,
  reportAutostart,
  resolveDaemonLaunch,
  windowsRunValue,
  type AutostartOptions,
  type DaemonLaunch,
  type Exec,
} from "./autostart";
import { runCli } from "./cli";
import { countPairedDevices } from "./pairing";

const scratch = mkdtempSync(join(tmpdir(), "agentmon autostart "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const launch = (over: Partial<DaemonLaunch> = {}): DaemonLaunch => ({
  node: "/usr/local/bin/node",
  args: ["/opt/agentmon/node_modules/tsx/dist/cli.mjs", "/opt/agentmon/src/main.ts"],
  cwd: "/opt/agentmon",
  env: {},
  ...over,
});

let counter = 0;
const sandbox = () => {
  const root = join(scratch, `kasus ${++counter}`);
  const homeDir = join(root, "rumah pengguna");
  const dataDir = join(root, "data agentmon");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { root, homeDir, dataDir };
};

type Call = { file: string; args: string[] };
function recorder(replies: Record<string, Partial<{ code: number; stdout: string; stderr: string }>> = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const key = Object.keys(replies).find((k) => `${file} ${args.join(" ")}`.includes(k));
    return { code: 0, stdout: "", stderr: "", ...(key ? replies[key] : {}) };
  };
  const spawned: Call[] = [];
  return { exec, calls, spawned, spawnDetached: (file: string, args: string[]) => spawned.push({ file, args }) };
}
const line = (c: Call) => `${c.file} ${c.args.join(" ")}`;

function options(over: Partial<AutostartOptions> & { platform: NonNullable<AutostartOptions["platform"]> }) {
  const sb = sandbox();
  const out: string[] = [];
  const err: string[] = [];
  const rec = recorder();
  // Panggilan pertama = pemeriksaan sebelum memasang (belum ada daemon); sesudahnya daemon "menjawab".
  let probes = 0;
  const o: AutostartOptions = {
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    homeDir: sb.homeDir,
    dataDir: sb.dataDir,
    exec: rec.exec,
    spawnDetached: rec.spawnDetached,
    launch: launch(),
    uid: 501,
    userName: "dono",
    portOpen: async () => probes++ > 0,
    startWaitMs: 50,
    ...over,
  };
  return { o, out, err, rec, sb };
}

describe("resolveDaemonLaunch", () => {
  test("menunjuk ke node saat ini, tsx, dan titik masuk daemon (path absolut yang ada)", () => {
    const l = resolveDaemonLaunch({ env: {}, hold: false });
    expect(l.node).toBe(process.execPath);
    expect(l.args.length).toBe(2);
    for (const p of [l.args[0]!, l.args[1]!, l.cwd]) expect(existsSync(p), p).toBe(true);
    expect(l.args[1]).toMatch(/main\.ts$/);
    expect(l.env).toEqual({});
  });
  test("hanya variabel non-rahasia yang ikut, AGENTMON_HOLD hanya bila diminta", () => {
    const l = resolveDaemonLaunch({ env: { AGENTMON_HOME: "relatif/data", AGENTMON_PORT: "50000", AGENTMON_RELAY_TOKEN: "rahasia".repeat(5), AGENTMON_RELAY_URL: "https://r.test", PATH: "/x" }, hold: true });
    expect(Object.keys(l.env).sort()).toEqual(["AGENTMON_HOLD", "AGENTMON_HOME", "AGENTMON_PORT"]);
    expect(l.env.AGENTMON_HOLD).toBe("1");
    expect(l.env.AGENTMON_PORT).toBe("50000");
    expect(l.env.AGENTMON_HOME).toMatch(/data$/);
    expect(l.env.AGENTMON_HOME).not.toBe("relatif/data"); // dibuat absolut
  });
  test("port tidak sah ditolak", () => {
    expect(() => resolveDaemonLaunch({ env: { AGENTMON_PORT: "abc" }, hold: false })).toThrow(/AGENTMON_PORT tidak valid/);
    expect(() => resolveDaemonLaunch({ env: { AGENTMON_PORT: "70000" }, hold: false })).toThrow();
  });
});

describe("buildLaunchAgentPlist (macOS)", () => {
  test("menyala saat login, SELALU dinyalakan lagi (keluar kode 0 karena sudah ada daemon lain tidak boleh mematikannya), dan ada jeda", () => {
    const plist = buildLaunchAgentPlist(launch());
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).not.toContain("SuccessfulExit");
    expect(plist).toContain("<string>Adaptive</string>");
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/agentmon/src/main.ts</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
  });
  test("path ber-spasi dan karakter XML di-escape", () => {
    const plist = buildLaunchAgentPlist(launch({ cwd: "/Users/Dono & Co/<proyek>/agent mon", args: ["/Users/Dono & Co/x y/cli.mjs", "/a/main.ts"], env: { AGENTMON_HOME: "/data/a&b" } }));
    expect(plist).toContain("/Users/Dono &amp; Co/&lt;proyek&gt;/agent mon");
    expect(plist).toContain("<string>/Users/Dono &amp; Co/x y/cli.mjs</string>");
    expect(plist).toContain("<string>/data/a&amp;b</string>");
    expect(plist).not.toContain("Dono & Co");
  });
  test("variabel lingkungan hanya ditulis bila ada", () => {
    expect(buildLaunchAgentPlist(launch())).not.toContain("EnvironmentVariables");
    expect(buildLaunchAgentPlist(launch({ env: { AGENTMON_HOLD: "1" } }))).toMatch(/EnvironmentVariables[\s\S]*AGENTMON_HOLD[\s\S]*<string>1<\/string>/);
  });
});

describe("buildSystemdUnit (Linux)", () => {
  test("restart setelah galat, menyala saat login, tidak ada hak admin yang diminta", () => {
    const unit = buildSystemdUnit(launch());
    expect(unit).toMatch(/\[Service\][\s\S]*Restart=always/);
    expect(unit).not.toContain("network-online"); // tidak berpengaruh pada unit pengguna
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/agentmon/node_modules/tsx/dist/cli.mjs" "/opt/agentmon/src/main.ts"');
    expect(unit).toContain("WorkingDirectory=/opt/agentmon");
    expect(unit).not.toMatch(/User=|^\s*Group=/m);
  });
  test("tanda kutip, backslash, % dan $ di path di-escape", () => {
    const unit = buildSystemdUnit(launch({ args: ["/opt/100% $HOME/a b/cli.mjs", "/opt/x/main.ts"], cwd: "/opt/100%/x", env: { AGENTMON_HOME: "/data/50%" } }));
    expect(unit).toContain('"/opt/100%% $$HOME/a b/cli.mjs"');
    expect(unit).toContain("WorkingDirectory=/opt/100%%/x");
    expect(unit).toContain('Environment="AGENTMON_HOME=/data/50%%"');
  });
});

describe("buildWindowsLauncher (VBS tersembunyi)", () => {
  const sample = launch({ node: "C:\\Program Files\\nodejs\\node.exe", args: ["D:\\Dev\\proyek saya\\tsx\\cli.mjs", "D:\\Dev\\proyek saya\\src\\main.ts"], cwd: "D:\\Dev\\proyek saya", env: { AGENTMON_HOME: "C:\\Users\\Dono\\.agentmon", AGENTMON_HOLD: "1" } });
  const script = buildWindowsLauncher(sample);

  test("menjalankan daemon dengan jendela tersembunyi (gaya 0), menunggu, lalu mengulang", () => {
    expect(script).toMatch(/shell\.Run .*, 0, True/);
    expect(script).toMatch(/^Do\r?$/m);
    expect(script).toMatch(/^Loop\r?$/m);
    expect(script).toMatch(/WScript\.Sleep 30000/); // berhenti terlalu cepat: jeda panjang
    expect(script).toMatch(/WScript\.Sleep 3000/);
    expect(script.split("\r\n").length).toBeGreaterThan(8);
    expect(script).not.toMatch(/[^\r]\n/); // semua akhir baris CRLF
  });
  test("kutipan: path ber-spasi dikutip dua kali dengan benar di dalam string VBS", () => {
    expect(script).toContain('""C:\\Program Files\\nodejs\\node.exe"" ""D:\\Dev\\proyek saya\\tsx\\cli.mjs"" ""D:\\Dev\\proyek saya\\src\\main.ts""');
    expect(script).toContain('shell.CurrentDirectory = "D:\\Dev\\proyek saya"');
    expect(script).toContain('proc("AGENTMON_HOME") = "C:\\Users\\Dono\\.agentmon"');
    expect(script).toContain('proc("AGENTMON_HOLD") = "1"');
  });
  test("dikodekan UTF-16 dengan BOM supaya path berhuruf non-ASCII terbaca wscript", () => {
    const withUnicode = buildWindowsLauncher(launch({ cwd: "C:\\Users\\Müller\\agent" }));
    const bytes = encodeVbs(withUnicode);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(bytes.subarray(2).toString("utf16le")).toContain("Müller");
  });
  test("nilai Run mengarah ke wscript //B (tanpa jendela)", () => {
    expect(windowsRunValue("C:\\a b\\agentmon-daemon.vbs")).toBe('wscript.exe //B //Nologo "C:\\a b\\agentmon-daemon.vbs"');
  });
});

describe("path atau nilai yang tidak bisa dikutip dengan aman ditolak", () => {
  test.each([
    ["tanda kutip ganda", launch({ cwd: '/opt/a"b' })],
    ["baris baru di path", launch({ args: ["/a\n/b", "/c"] })],
    ["NUL", launch({ node: "/usr/bin/node\0" })],
    ["nilai lingkungan dengan kutip", launch({ env: { AGENTMON_HOME: 'x"y' } })],
  ])("%s", (_n, bad) => {
    expect(() => buildLaunchAgentPlist(bad)).toThrow(/tidak didukung/);
    expect(() => buildSystemdUnit(bad)).toThrow(/tidak didukung/);
    expect(() => buildWindowsLauncher(bad)).toThrow(/tidak didukung/);
  });
});

describe("pemasangan macOS", () => {
  test("menulis plist, memuat ulang (bootout lalu bootstrap) di domain pengguna", async () => {
    const { o, out, rec, sb } = options({ platform: "darwin" });
    expect(await installAutostart(o)).toBe(0);
    const file = join(sb.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
    expect(readFileSync(file, "utf8")).toContain(LABEL);
    expect(rec.calls.map(line)).toEqual([`launchctl bootout gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${file}`]);
    expect(out.join("\n")).toContain("LaunchAgent");
  });
  test("bootstrap gagal: kode 1, pesan jelas, berkas tetap ditulis (menyala saat masuk lagi)", async () => {
    const rec = recorder({ bootstrap: { code: 5, stderr: "Bootstrap failed: 5" } });
    const { o, err, sb } = options({ platform: "darwin", exec: rec.exec });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/launchctl gagal memuat/);
    expect(existsSync(join(sb.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(true);
  });
  test("pencopotan: bootout dan berkas dihapus; yang tidak ada dijelaskan", async () => {
    const { o, out, rec, sb } = options({ platform: "darwin" });
    await installAutostart(o);
    rec.calls.length = 0;
    expect(await removeAutostart(o)).toBe(0);
    expect(rec.calls.map(line)).toEqual([`launchctl bootout gui/501/${LABEL}`]);
    expect(existsSync(join(sb.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
    out.length = 0;
    await removeAutostart(o);
    expect(out.join("\n")).toMatch(/tidak terpasang/);
  });
  test("status: tidak ada, ada dan dimuat, ada tetapi belum dimuat", async () => {
    const { o, sb } = options({ platform: "darwin" });
    expect((await autostartStatus(o)).enabled).toBe(false);
    await installAutostart(o);
    expect(await autostartStatus(o)).toMatchObject({ enabled: true, detail: "dimuat" });
    const notLoaded = recorder({ print: { code: 113 } });
    expect(await autostartStatus({ ...o, exec: notLoaded.exec })).toMatchObject({ enabled: true });
    expect((await autostartStatus({ ...o, exec: notLoaded.exec })).detail).toMatch(/belum dimuat/);
    void sb;
  });
});

describe("pemasangan Linux", () => {
  test("menulis unit di ~/.config/systemd/user, daemon-reload, lalu enable --now", async () => {
    const { o, rec, sb } = options({ platform: "linux" });
    expect(await installAutostart(o)).toBe(0);
    const file = join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
    expect(readFileSync(file, "utf8")).toContain("Restart=always");
    expect(rec.calls.map(line)).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
      "loginctl show-user dono --property=Linger",
    ]);
  });
  test("XDG_CONFIG_HOME dihormati", async () => {
    const sb = sandbox();
    const xdg = join(sb.root, "xdg config");
    const { o } = options({ platform: "linux", env: { XDG_CONFIG_HOME: xdg }, homeDir: sb.homeDir });
    expect(await installAutostart(o)).toBe(0);
    expect(existsSync(join(xdg, "systemd", "user", SYSTEMD_UNIT))).toBe(true);
  });
  test("tanpa systemd pengguna: pesan jelas, kode 1, tidak ada berkas", async () => {
    const rec = recorder({ "show-environment": { code: 1, stderr: "Failed to connect to bus" } });
    const { o, err, sb } = options({ platform: "linux", exec: rec.exec });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/systemd pengguna tidak tersedia/);
    expect(existsSync(join(sb.homeDir, ".config"))).toBe(false);
  });
  test("enable gagal: kode 1 dengan pesan", async () => {
    const rec = recorder({ enable: { code: 1, stderr: "gagal" } });
    const { o, err } = options({ platform: "linux", exec: rec.exec });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/enable --now.*gagal/);
  });
  test("linger belum menyala: catatan cara menyalakannya (tidak diubah otomatis)", async () => {
    const rec = recorder({ "show-user": { stdout: "Linger=no\n" } });
    const { o, out } = options({ platform: "linux", exec: rec.exec });
    await installAutostart(o);
    expect(out.join("\n")).toMatch(/loginctl enable-linger/);
    expect(rec.calls.some((c) => c.args.includes("enable-linger"))).toBe(false);
  });
  test("pencopotan: disable --now, berkas dihapus, daemon-reload", async () => {
    const { o, rec, sb } = options({ platform: "linux" });
    await installAutostart(o);
    rec.calls.length = 0;
    expect(await removeAutostart(o)).toBe(0);
    expect(rec.calls.map(line)).toEqual([`systemctl --user disable --now ${SYSTEMD_UNIT}`, "systemctl --user daemon-reload"]);
    expect(existsSync(join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT))).toBe(false);
  });
  test("status memakai is-enabled dan is-active", async () => {
    const rec = recorder({ "is-active": { stdout: "active\n" } });
    const { o } = options({ platform: "linux", exec: rec.exec });
    await installAutostart({ ...o, exec: recorder().exec });
    expect(await autostartStatus(o)).toMatchObject({ enabled: true, detail: "aktif" });
  });
});

describe("pemasangan Windows", () => {
  test("menulis skrip tersembunyi (UTF-16 BOM), kunci Run lewat PowerShell, menghentikan peluncur lama, lalu menyalakan tanpa jendela", async () => {
    const { o, rec, sb } = options({ platform: "win32" });
    expect(await installAutostart(o)).toBe(0);
    const script = join(sb.dataDir, "autostart", WINDOWS_VBS_NAME);
    const bytes = readFileSync(script);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toContain("shell.Run");
    expect(rec.calls.map((c) => c.file)).toEqual(["where.exe", "powershell.exe", "powershell.exe", "powershell.exe"]);
    const [, read, set, kill] = rec.calls.map((c) => c.args[c.args.length - 1]!);
    expect(read).toContain("Get-ItemProperty");
    expect(read).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"); // path non-ASCII tidak boleh rusak lewat pipa
    expect(set).toContain("Set-ItemProperty");
    expect(set).toContain("$ErrorActionPreference = 'Stop'");
    expect(set).toContain("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(set).toContain(`wscript.exe //B //Nologo "${script}"`);
    expect(kill).toContain("taskkill");
    expect(kill).toContain(WINDOWS_VBS_NAME);
    expect(rec.spawned).toEqual([{ file: "wscript.exe", args: ["//B", "//Nologo", script] }]);
    expect(rec.calls[1]!.args).toContain("-NonInteractive");
  });
  test("apostrof di path digandakan dalam skrip PowerShell (tidak bisa menyuntikkan perintah)", async () => {
    const sb = sandbox();
    const dataDir = join(sb.root, "O'Brien'; Remove-Item x; '");
    mkdirSync(dataDir, { recursive: true });
    const { o, rec } = options({ platform: "win32", dataDir });
    await installAutostart(o);
    const set = rec.calls.map((c) => c.args.at(-1)!).find((s) => s.includes("Set-ItemProperty"))!;
    expect(set).toContain("O''Brien''; Remove-Item x; ''");
    expect(set).not.toMatch(/[^']'; Remove-Item x/);
  });
  test("gagal menulis kunci Run: kode 1, peluncur tidak dinyalakan", async () => {
    const rec = recorder({ "Set-ItemProperty": { code: 1, stderr: "akses ditolak" } });
    const { o, err } = options({ platform: "win32", exec: rec.exec, spawnDetached: rec.spawnDetached });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/Gagal menulis kunci Run/);
    expect(rec.spawned).toEqual([]);
  });
  test("pencopotan: kunci Run dihapus, peluncur dihentikan, skrip dihapus", async () => {
    const win = fakeWindows();
    const { o, sb } = options({ platform: "win32", exec: win.exec });
    await installAutostart(o);
    win.scripts.length = 0;
    expect(await removeAutostart(o)).toBe(0);
    expect(win.scripts.some((s) => s.includes("Remove-ItemProperty"))).toBe(true);
    expect(win.scripts.some((s) => s.includes("taskkill"))).toBe(true);
    expect(win.state.value).toBeUndefined();
    expect(existsSync(join(sb.dataDir, "autostart", WINDOWS_VBS_NAME))).toBe(false);
  });
  test("status: aktif hanya bila kunci Run menunjuk skrip kita DAN skripnya ada", async () => {
    const sb = sandbox();
    const script = join(sb.dataDir, "autostart", WINDOWS_VBS_NAME);
    const installed = recorder();
    await installAutostart({ ...options({ platform: "win32", dataDir: sb.dataDir, homeDir: sb.homeDir }).o, exec: installed.exec, spawnDetached: installed.spawnDetached });
    const yes = recorder({ "Get-ItemProperty": { stdout: `wscript.exe //B //Nologo "${script}"\n` } });
    expect((await autostartStatus({ ...options({ platform: "win32", dataDir: sb.dataDir }).o, exec: yes.exec })).enabled).toBe(true);
    const other = recorder({ "Get-ItemProperty": { stdout: "program-lain.exe\n" } });
    expect((await autostartStatus({ ...options({ platform: "win32", dataDir: sb.dataDir }).o, exec: other.exec })).enabled).toBe(false);
    const none = recorder({ "Get-ItemProperty": { stdout: "" } });
    expect((await autostartStatus({ ...options({ platform: "win32", dataDir: sb.dataDir }).o, exec: none.exec })).enabled).toBe(false);
  });
});

describe("keamanan dan umum", () => {
  test("tidak ada token atau alamat relay yang tertulis di berkas autostart mana pun", async () => {
    const secret = "TOKEN-RAHASIA-JANGAN-BOCOR-1234567890";
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { o, sb } = options({ platform, env: { AGENTMON_RELAY_TOKEN: secret, AGENTMON_RELAY_URL: "https://relay-rahasia.test", AGENTMON_ADMIN_SECRET: secret }, launch: resolveDaemonLaunch({ env: { AGENTMON_RELAY_TOKEN: secret }, hold: false }) });
      await installAutostart(o);
      const files = [join(sb.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`), join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT), join(sb.dataDir, "autostart", WINDOWS_VBS_NAME)].filter(existsSync);
      expect(files.length).toBe(1);
      const raw = readFileSync(files[0]!);
      const text = platform === "win32" ? raw.subarray(2).toString("utf16le") : raw.toString("utf8");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("relay-rahasia");
    }
  });
  test("perintah sistem dijalankan sebagai berkas+argumen (tanpa shell), jadi path ber-spasi aman", async () => {
    const { o, rec } = options({ platform: "darwin" });
    await installAutostart(o);
    for (const c of rec.calls) expect(c.file).toBe("launchctl");
    expect(rec.calls[1]!.args[2]).toContain("rumah pengguna");
  });
  test("--hold menaruh AGENTMON_HOLD=1 dan dilaporkan; tanpa itu dilaporkan mati", async () => {
    const on = options({ platform: "linux", launch: launch({ env: { AGENTMON_HOLD: "1" } }) });
    await installAutostart(on.o);
    expect(on.out.join("\n")).toMatch(/Penahanan izin untuk HP: AKTIF/);
    expect(readFileSync(join(on.sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT), "utf8")).toContain('Environment="AGENTMON_HOLD=1"');
    const off = options({ platform: "linux" });
    await installAutostart(off.o);
    expect(off.out.join("\n")).toMatch(/Penahanan izin untuk HP: mati/);
  });
  test("dijalankan dua kali: tetap berhasil dan berkasnya sama (tidak menumpuk)", async () => {
    const { o, sb } = options({ platform: "linux" });
    await installAutostart(o);
    const first = readFileSync(join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT), "utf8");
    expect(await installAutostart(o)).toBe(0);
    expect(readFileSync(join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT), "utf8")).toBe(first);
  });
  test("sistem operasi yang tidak didukung: pesan jelas, kode 1", async () => {
    const { o, err } = options({ platform: "freebsd" as never });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/belum didukung/);
    expect((await autostartStatus(o)).supported).toBe(false);
  });
  test("perintah daemon tidak bisa disiapkan: pesan jelas, tidak menulis apa pun", async () => {
    const { o, err, sb } = options({ platform: "linux", launch: undefined as never, env: { AGENTMON_PORT: "abc" } });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/Tidak bisa menyiapkan perintah daemon/);
    expect(existsSync(join(sb.homeDir, ".config"))).toBe(false);
  });
});

describe("reportAutostart", () => {
  test("melaporkan autostart dan apakah daemon menjawab di port", async () => {
    const { o, out } = options({ platform: "linux", portOpen: async (p) => p === 47821 });
    await reportAutostart(o);
    expect(out.join("\n")).toMatch(/Autostart: belum dipasang/);
    expect(out.join("\n")).toContain("Daemon: berjalan di 127.0.0.1:47821");
    out.length = 0;
    await reportAutostart({ ...o, portOpen: async () => false, env: { AGENTMON_PORT: "50111" } });
    expect(out.join("\n")).toContain("Daemon: tidak berjalan di 127.0.0.1:50111");
  });
});

describe("perintah CLI autostart dan status", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  };
  test.each([[["autostart"]], [["autostart", "aneh"]], [["autostart", "install", "--aneh"]], [["autostart", "status", "--hold"]], [["autostart", "remove", "--hold"]]])("argumen salah ditolak: %j", async (argv) => {
    const { deps, err } = io();
    expect(await runCli(argv, { env: { AGENTMON_HOME: sandbox().dataDir }, ...deps })).toBe(2);
    expect(err.join("\n")).toMatch(/Pemakaian: autostart/);
  });
  test("autostart status berjalan lewat CLI tanpa daemon dan tanpa mengubah apa pun", async () => {
    const { deps, out } = io();
    const code = await runCli(["autostart", "status"], { env: { AGENTMON_HOME: sandbox().dataDir, AGENTMON_PORT: "47999" }, ...deps, autostart: { platform: "linux", exec: recorder().exec } });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Autostart:/);
    expect(out.join("\n")).toContain("Daemon: tidak berjalan di 127.0.0.1:47999");
  });

  test("status melaporkan daemon, relay, jumlah HP, dan autostart", async () => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0, relayStatus: () => ({ configured: true, state: "ready", phoneReachable: true }) });
    try {
      const { deps, out } = io();
      const fetchFake = (async () => new Response(JSON.stringify({ devices: [{ id: "d1", name: "iPhone", pairedAt: "2026-11-01T00:00:00.000Z" }, { id: "d2", name: "iPad", pairedAt: "2026-11-02T00:00:00.000Z" }] }), { status: 200 })) as unknown as typeof fetch;
      const code = await runCli(["status"], {
        env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port), AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40) },
        ...deps,
        pair: { fetch: fetchFake },
        autostartStatus: async () => ({ supported: true, enabled: true, mechanism: "LaunchAgent", detail: "dimuat" }),
      });
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain(`Daemon: berjalan di 127.0.0.1:${daemon.port}`);
      expect(text).toContain("Relay: tersambung, ada HP yang online");
      expect(text).toContain("Perangkat: 2 HP terpasang");
      expect(text).toContain("Mulai otomatis: aktif (LaunchAgent; dimuat)");
      expect(text).not.toContain("t".repeat(40));
    } finally {
      await daemon.stop();
    }
  });

  test.each([
    [{ configured: true, state: "connecting", phoneReachable: false }, "Relay: menyambung"],
    [{ configured: true, state: "disconnected", phoneReachable: false }, "Relay: terputus"],
    [{ configured: true, state: "ready", phoneReachable: false }, "tidak ada HP yang online"],
    [{ configured: false, state: "off", phoneReachable: false }, "Relay: tidak dipakai"],
  ] as const)("status relay %j", async (relay, expected) => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0, relayStatus: () => relay });
    try {
      const { deps, out } = io();
      await runCli(["status"], { env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port) }, ...deps, autostartStatus: async () => ({ supported: true, enabled: false, mechanism: "x" }) });
      expect(out.join("\n")).toContain(expected);
    } finally {
      await daemon.stop();
    }
  });

  test("jumlah HP: relay yang menolak (401/500) tidak dihitung, walau isinya tampak sah", async () => {
    const body = JSON.stringify({ devices: [{ id: "d1", name: "iPhone", pairedAt: "2026-11-01T00:00:00.000Z" }] });
    const reply = (status: number) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await countPairedDevices({ relayUrl: "https://relay.contoh.com/", machineToken: "t".repeat(40), fetch: reply(200) })).toBe(1);
    expect(await countPairedDevices({ relayUrl: "https://relay.contoh.com", machineToken: "t".repeat(40), fetch: reply(401) })).toBeUndefined();
    expect(await countPairedDevices({ relayUrl: "https://relay.contoh.com", machineToken: "t".repeat(40), fetch: reply(500) })).toBeUndefined();
    expect(await countPairedDevices({ relayUrl: "https://relay.contoh.com", machineToken: "t".repeat(40), fetch: (async () => new Response("bukan json", { status: 200 })) as unknown as typeof fetch })).toBeUndefined();
  });

  test("relay tidak terjangkau atau laptop belum terdaftar: jumlah HP 'tidak diketahui', status tetap berhasil", async () => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0 });
    try {
      const noRelay = io();
      expect(await runCli(["status"], { env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port) }, ...noRelay.deps, autostartStatus: async () => ({ supported: true, enabled: false, mechanism: "x" }) })).toBe(0);
      expect(noRelay.out.join("\n")).toContain("Perangkat: tidak diketahui (laptop belum terdaftar ke relay)");
      expect(noRelay.out.join("\n")).toContain("Mulai otomatis: belum dipasang");

      const down = io();
      const failing = (async () => {
        throw new Error("jaringan mati");
      }) as unknown as typeof fetch;
      await runCli(["status"], {
        env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port), AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40) },
        ...down.deps,
        pair: { fetch: failing },
        autostartStatus: async () => ({ supported: false, enabled: false, mechanism: "tidak didukung" }),
      });
      expect(down.out.join("\n")).toContain("Perangkat: tidak diketahui (relay tidak terjangkau)");
    } finally {
      await daemon.stop();
    }
  });
});


// ---- Regresi review PR #84 ---------------------------------------------------------------------------------------------------
const OK = { code: 0, stdout: "", stderr: "" };

/** Registri Windows tiruan yang cukup untuk memeriksa pasang, copot, dan status dari beberapa folder data. */
function fakeWindows() {
  const state = { value: undefined as string | undefined, disabled: false };
  const scripts: string[] = [];
  const kills: string[] = [];
  const exec: Exec = async (file, args) => {
    if (file === "where.exe") return OK;
    const script = args.at(-1) ?? "";
    scripts.push(script);
    // PowerShell sungguhan: skrip yang tidak berakhir dengan `exit 0` membuat keluar kode 1 bila perintah terakhirnya gagal.
    // Remove-ItemProperty pada kunci yang tidak ada gagal; dengan `exit 0` tidak.
    const endsOk = /exit 0\s*$/.test(script);
    if (script.includes("Set-ItemProperty")) {
      state.value = /-Value '((?:[^']|'')*)'/.exec(script)![1]!.replace(/''/g, "'");
      return OK;
    }
    if (script.includes("Remove-ItemProperty")) {
      const existed = state.value !== undefined;
      state.value = undefined;
      return existed || endsOk ? OK : { code: 1, stdout: "", stderr: "Property AgentMon does not exist" };
    }
    if (script.includes("WildcardPattern")) {
      kills.push(script);
      return endsOk ? OK : { code: 1, stdout: "", stderr: "" };
    }
    if (script.includes("Get-ItemProperty")) return { code: 0, stdout: `${state.value ?? ""}\n${state.disabled ? "DISABLED\n" : ""}`, stderr: "" };
    return OK;
  };
  return { state, scripts, kills, exec };
}

describe("review #84: copot, kunci Run bersama, dan status Windows", () => {
  test("remove saat belum terpasang: berhasil (kode 0), tetap menghentikan peluncur yang mungkin hidup", async () => {
    const win = fakeWindows();
    const { o, out, err } = options({ platform: "win32", exec: win.exec });
    expect(await removeAutostart(o)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toMatch(/tidak terpasang/);
    expect(win.kills.length).toBe(1);
  });

  test("setiap skrip PowerShell yang bisa gagal karena 'tidak ada' berakhir dengan exit 0", async () => {
    const win = fakeWindows();
    const { o } = options({ platform: "win32", exec: win.exec });
    await installAutostart(o);
    await removeAutostart(o);
    const guarded = win.scripts.filter((s) => /Remove-ItemProperty|WildcardPattern|Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'/.test(s) && !s.includes("Set-ItemProperty"));
    expect(guarded.length).toBeGreaterThanOrEqual(3);
    for (const s of guarded) expect(s, s.slice(0, 60)).toMatch(/exit 0\s*$/);
  });

  test("dua folder data: remove dari B tidak menghapus kunci Run milik A, tidak membunuh peluncur A, dan menjelaskannya", async () => {
    const win = fakeWindows();
    const a = options({ platform: "win32", exec: win.exec });
    const b = options({ platform: "win32", exec: win.exec });
    await installAutostart(a.o);
    const valueA = win.state.value;
    expect(valueA).toContain(a.sb.dataDir);
    win.kills.length = 0;
    expect(await removeAutostart(b.o)).toBe(0);
    expect(win.state.value).toBe(valueA); // kunci A utuh
    expect(b.out.join("\n")).toMatch(/menunjuk ke instalasi lain/);
    expect(win.kills.length).toBe(1);
    expect(win.kills[0]).toContain(b.sb.dataDir.replace(/'/g, "''")); // hanya peluncur dari folder B
    expect(win.kills[0]).not.toContain(a.sb.dataDir);
    // penyaring proses memakai path lengkap folder ini, bukan sekadar nama berkas skrip yang sama di semua instalasi
    expect(win.kills[0]).toContain("-like ('*' + $p + '*')");
    expect(win.kills[0]).not.toContain(`-like '*${WINDOWS_VBS_NAME}*'`);
    expect(existsSync(join(a.sb.dataDir, "autostart", WINDOWS_VBS_NAME))).toBe(true);
  });

  test("memasang dari folder lain menggantikan kunci Run dan memberi tahu", async () => {
    const win = fakeWindows();
    const a = options({ platform: "win32", exec: win.exec });
    const b = options({ platform: "win32", exec: win.exec });
    await installAutostart(a.o);
    await installAutostart(b.o);
    expect(win.state.value).toContain(b.sb.dataDir);
    expect(b.out.join("\n")).toMatch(/DIGANTIKAN/);
  });

  test("peluncur dihentikan lewat pola yang di-escape (tanda [ ] di path tidak menjadi wildcard)", async () => {
    const win = fakeWindows();
    const sb = sandbox();
    const dataDir = join(sb.root, "data [x] [a-z]");
    mkdirSync(dataDir, { recursive: true });
    const { o } = options({ platform: "win32", exec: win.exec, dataDir });
    await installAutostart(o);
    expect(win.kills[0]).toContain("[WildcardPattern]::Escape(");
  });

  test("status: aktif hanya bila nilai Run PERSIS milik folder data ini, skripnya ada, dan tidak dimatikan di Startup apps", async () => {
    const win = fakeWindows();
    const a = options({ platform: "win32", exec: win.exec });
    const b = options({ platform: "win32", exec: win.exec });
    await installAutostart(a.o);
    expect(await autostartStatus(a.o)).toMatchObject({ enabled: true });
    const other = await autostartStatus(b.o);
    expect(other.enabled).toBe(false);
    expect(other.detail).toMatch(/instalasi lain/);
    win.state.disabled = true;
    const off = await autostartStatus(a.o);
    expect(off.enabled).toBe(false);
    expect(off.detail).toMatch(/dimatikan di Pengaturan/);
    win.state.disabled = false;
    win.state.value = undefined;
    expect((await autostartStatus(a.o)).enabled).toBe(false);
  });

  test("wscript.exe tidak ada (VBScript dinonaktifkan): pesan jelas, kode 1, tidak ada berkas dan tidak ada perubahan registri", async () => {
    const win = fakeWindows();
    const { o, err, sb } = options({ platform: "win32", exec: async (file, args) => (file === "where.exe" ? { code: 1, stdout: "", stderr: "" } : win.exec(file, args)) });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/wscript\.exe tidak ditemukan/);
    expect(existsSync(join(sb.dataDir, "autostart"))).toBe(false);
    expect(win.scripts).toEqual([]);
  });
});

describe("review #84: tanda kutip tipografis dan path relatif", () => {
  const typographic = [0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c));
  test.each(typographic.map((q) => [`U+${q.charCodeAt(0).toString(16).toUpperCase()}`, q] as const))("psQuote menggandakan %s seperti apostrof", (_n, q) => {
    expect(psQuote(`O${q}Brien`)).toBe(`'O${q}${q}Brien'`);
    expect(psQuote("O'Brien")).toBe("'O''Brien'");
  });

  test.runIf(process.platform === "win32")("di PowerShell SUNGGUHAN: path berisi tanda kutip tipografis tidak bisa menyuntikkan perintah", () => {
    const marker = join(scratch, "suntikan-berhasil.txt").replace(/\\/g, "/");
    const payloads = typographic.map((q) => `x${q}; New-Item -ItemType File -Path '${marker}' | Out-Null; ${q}y`);
    // Satu proses PowerShell untuk semua (memulai PowerShell mahal): tiap string harus terbaca UTUH sebagai satu nilai.
    const script = `$lengths = @(${payloads.map((p) => `(${psQuote(p)}).Length`).join(", ")}); $lengths -join ','`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    expect(out.split(",").map(Number)).toEqual(payloads.map((p) => p.length));
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("folder data relatif dijadikan absolut: nilai Run tidak bergantung pada folder kerja saat login", async () => {
    const win = fakeWindows();
    const sb = sandbox();
    const before = process.cwd();
    process.chdir(sb.root);
    try {
      const { o } = options({ platform: "win32", exec: win.exec, dataDir: "data relatif" });
      expect(await installAutostart(o)).toBe(0);
    } finally {
      process.chdir(before);
    }
    const value = win.state.value!;
    const path = /"(.+)"$/.exec(value)![1]!;
    expect(isAbsolute(path)).toBe(true);
    // Di macOS /var adalah tautan ke /private/var: folder kerja sesudah chdir sudah berupa jalur aslinya, jadi bandingkan jalur aslinya.
    expect(path).toBe(join(realpathSync(sb.root), "data relatif", "autostart", WINDOWS_VBS_NAME));
    expect(existsSync(path)).toBe(true);
  });

  test("XDG_CONFIG_HOME relatif diabaikan (spesifikasi XDG): jatuh ke ~/.config", async () => {
    const { o, sb } = options({ platform: "linux", env: { XDG_CONFIG_HOME: "relatif/config" } });
    await installAutostart(o);
    expect(existsSync(join(sb.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT))).toBe(true);
  });
});

describe("review #84: skrip Windows dan karakter khusus", () => {
  test("path berisi % ditolak (WScript.Shell.Run mengekspansi %VAR%)", () => {
    expect(() => buildWindowsLauncher(launch({ cwd: "C:\\Users\\100%\\x" }))).toThrow(/tanda %/);
    expect(() => buildWindowsLauncher(launch({ args: ["C:\\a\\%PATH%\\b.mjs", "C:\\m.ts"] }))).toThrow(/tanda %/);
    expect(() => buildLaunchAgentPlist(launch({ cwd: "/Users/100%/x" }))).not.toThrow(); // % hanya masalah di skrip Windows
  });
  test("Timer yang kembali ke 0 tengah malam tidak membuat jeda 30 detik yang salah", () => {
    expect(buildWindowsLauncher(launch())).toContain("If elapsed < 0 Then elapsed = elapsed + 86400");
  });
});

describe("review #84: laporan 'menyala' harus terbukti", () => {
  test("daemon manual sudah berjalan sebelum pasang: dijelaskan, tidak diklaim sebagai menyala", async () => {
    const { o, out } = options({ platform: "linux", portOpen: async () => true });
    expect(await installAutostart(o)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/sudah ada daemon yang berjalan/);
    expect(text).not.toMatch(/Daemon menjawab/);
  });
  test("daemon tidak pernah menjawab sesudah dinyalakan: kode 1 dan petunjuk log, walau berkas terpasang", async () => {
    const { o, err, sb } = options({ platform: "darwin", portOpen: async () => false });
    expect(await installAutostart(o)).toBe(1);
    expect(err.join("\n")).toMatch(/Daemon belum menjawab/);
    expect(err.join("\n")).toContain("daemon.log");
    expect(existsSync(join(sb.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(true);
  });
  test("daemon menjawab sesudah dinyalakan: dilaporkan", async () => {
    const { o, out } = options({ platform: "linux" });
    await installAutostart(o);
    expect(out.join("\n")).toMatch(/Daemon menjawab di 127\.0\.0\.1:47821/);
  });
  test("port khusus dari lingkungan dipakai untuk pemeriksaan", async () => {
    const seen: number[] = [];
    const { o } = options({ platform: "linux", launch: launch({ env: { AGENTMON_PORT: "51111" } }), portOpen: async (p) => (seen.push(p), seen.length > 1) });
    await installAutostart(o);
    expect(seen.every((p) => p === 51111)).toBe(true);
  });
});

describe("review #84: status", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  };
  const fine = async () => ({ supported: true, enabled: false, mechanism: "x" });
  const devicesBody = JSON.stringify({ devices: [{ id: "d1", name: "iPhone", pairedAt: "2026-11-01T00:00:00.000Z" }] });

  test("daemon versi lama (tanpa laporan relay) tidak dilabeli 'tidak dipakai'", async () => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0 });
    try {
      const { deps, out } = io();
      await runCli(["status"], { env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port) }, ...deps, autostartStatus: fine });
      expect(out.join("\n")).toContain("Relay: tidak dilaporkan");
      expect(out.join("\n")).not.toContain("Relay: tidak dipakai");
    } finally {
      await daemon.stop();
    }
  });

  test("token laptop TIDAK dikirim ke relay http:// di host lain; http ke komputer sendiri dan https boleh; AGENTMON_RELAY_INSECURE=1 mengizinkan", async () => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0, relayStatus: () => ({ configured: true, state: "ready", phoneReachable: false }) });
    try {
      for (const [url, insecure, expectCalled] of [
        ["http://relay.contoh.com", undefined, false],
        ["http://127.0.0.1:8787", undefined, true],
        ["https://relay.contoh.com", undefined, true],
        ["http://relay.contoh.com", "1", true],
      ] as const) {
        const urls: string[] = [];
        const fetchSpy = (async (u: string) => (urls.push(String(u)), new Response(devicesBody, { status: 200 }))) as unknown as typeof fetch;
        const { deps, out } = io();
        await runCli(["status"], {
          env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port), AGENTMON_RELAY_URL: url, AGENTMON_RELAY_TOKEN: "t".repeat(40), ...(insecure ? { AGENTMON_RELAY_INSECURE: insecure } : {}) },
          ...deps,
          pair: { fetch: fetchSpy },
          autostartStatus: fine,
        });
        expect(urls.length > 0, `${url} insecure=${insecure}`).toBe(expectCalled);
        if (!expectCalled) expect(out.join("\n")).toMatch(/alamat relay tidak terenkripsi/);
        else expect(out.join("\n")).toContain("Perangkat: 1 HP terpasang");
      }
    } finally {
      await daemon.stop();
    }
  });

  test("pemeriksaan relay dan autostart berjalan BERSAMAAN (bukan berurutan)", async () => {
    const sb = sandbox();
    const daemon = await startDaemon({ home: sb.dataDir, port: 0 });
    try {
      let autostartStarted = false;
      const fetchWaitsForAutostart = (async () => {
        // Bila `status` menunggu relay lebih dulu baru memeriksa autostart, ini tidak pernah terpenuhi (kecuali setelah batas waktu).
        const end = Date.now() + 1500;
        while (!autostartStarted && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
        return new Response(devicesBody, { status: 200 });
      }) as unknown as typeof fetch;
      const { deps } = io();
      const started = Date.now();
      await runCli(["status"], {
        env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: String(daemon.port), AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40) },
        ...deps,
        pair: { fetch: fetchWaitsForAutostart },
        autostartStatus: async () => ((autostartStarted = true), { supported: true, enabled: false, mechanism: "x" }),
      });
      expect(autostartStarted).toBe(true);
      expect(Date.now() - started).toBeLessThan(1200);
    } finally {
      await daemon.stop();
    }
  });

  test("daemon mati: pesan menyebut autostart install", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.dataDir, "token"), `${"ab".repeat(32)}\n`);
    const { deps, err } = io();
    const code = await runCli(["status"], { env: { AGENTMON_HOME: sb.dataDir, AGENTMON_PORT: "47998" }, ...deps, autostartStatus: fine });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("autostart install");
  });
});
