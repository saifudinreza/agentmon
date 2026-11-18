// FILE INI: TEST autostart (issue #044). Yang diuji:
//   - isi berkas per OS (plist, unit systemd, skrip VBS) termasuk kutipan untuk path ber-spasi dan karakter khusus,
//   - urutan perintah sistem yang dijalankan per OS (dengan exec palsu: tidak menyentuh launchctl, systemctl, atau registri asli),
//   - tidak ada rahasia (token, alamat relay) yang ditulis ke berkas autostart,
//   - perintah CLI `autostart` dan laporan `status`.
// Pemasangan SUNGGUHAN di macOS dan Linux tidak bisa dijalankan di CI Windows; yang teruji di sini adalah berkas dan perintahnya.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("menyala saat login, dinyalakan lagi hanya bila berhenti karena galat, dan ada jeda", () => {
    const plist = buildLaunchAgentPlist(launch());
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
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
    expect(unit).toMatch(/\[Service\][\s\S]*Restart=on-failure/);
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
    expect(readFileSync(file, "utf8")).toContain("Restart=on-failure");
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
    expect(rec.calls.length).toBe(2);
    expect(rec.calls.every((c) => c.file === "powershell.exe")).toBe(true);
    const [set, kill] = rec.calls.map((c) => c.args[c.args.length - 1]!);
    expect(set).toContain("Set-ItemProperty");
    expect(set).toContain("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(set).toContain(`wscript.exe //B //Nologo "${script}"`);
    expect(kill).toContain("taskkill");
    expect(kill).toContain(WINDOWS_VBS_NAME);
    expect(rec.spawned).toEqual([{ file: "wscript.exe", args: ["//B", "//Nologo", script] }]);
    expect(rec.calls[0]!.args).toContain("-NonInteractive");
  });
  test("apostrof di path digandakan dalam skrip PowerShell (tidak bisa menyuntikkan perintah)", async () => {
    const sb = sandbox();
    const dataDir = join(sb.root, "O'Brien'; Remove-Item x; '");
    mkdirSync(dataDir, { recursive: true });
    const { o, rec } = options({ platform: "win32", dataDir });
    await installAutostart(o);
    const set = rec.calls[0]!.args.at(-1)!;
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
    const { o, rec, sb } = options({ platform: "win32" });
    await installAutostart(o);
    rec.calls.length = 0;
    expect(await removeAutostart(o)).toBe(0);
    const scripts = rec.calls.map((c) => c.args.at(-1)!);
    expect(scripts[0]).toContain("Remove-ItemProperty");
    expect(scripts[1]).toContain("taskkill");
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
    const code = await runCli(["autostart", "status"], { env: { AGENTMON_HOME: sandbox().dataDir, AGENTMON_PORT: "47999" }, ...deps });
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
