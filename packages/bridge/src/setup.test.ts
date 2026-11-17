// FILE INI: TEST perintah `setup` (issue #043). Jaminan utama:
//   - pengaturan milik pengguna TETAP UTUH (hook lain, kolom lain, gaya berkas),
//   - dijalankan dua kali tidak membuat hook ganda dan tidak menulis ulang,
//   - berkas pengaturan (berisi token) izinnya tidak dilonggarkan dan isinya tidak pernah dicetak,
//   - path dengan spasi berfungsi, dan prasyarat yang kurang dijelaskan tanpa mengubah apa pun.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runCli } from "./cli";
import { HOOK_EVENTS, buildClaudeHookSettings } from "./hook-config";
import { findOnPath, isAgentmonHook, mergeAgentmonHooks, removeAgentmonHooks, runSetup, type SetupOptions } from "./setup";

const TOKEN = "ab".repeat(32);
const scratch = mkdtempSync(join(tmpdir(), "agentmon setup "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ours = buildClaudeHookSettings({ token: TOKEN });
const userHook = { type: "command", command: "echo halo" };
const userHttp = { type: "http", url: "http://127.0.0.1:9000/lain", timeout: 5 };

let counter = 0;
const fresh = () => {
  const root = join(scratch, `kasus ${++counter}`);
  const home = join(root, "data agentmon");
  const claudeDir = join(root, "folder claude");
  mkdirSync(home, { recursive: true });
  return { root, home, claudeDir, file: join(claudeDir, "settings.json") };
};

type Run = { code: number; out: string[]; err: string[] };
async function setup(options: Partial<SetupOptions> & { home: string; claudeDir: string }): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSetup({
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    findProgram: (names) => (names.includes("claude") ? "/usr/bin/claude" : undefined),
    portOpen: async () => false,
    noPair: true,
    now: () => new Date(2026, 10, 18, 9, 30, 15),
    ...options,
  });
  return { code, out, err };
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8").replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), "")) as Record<string, unknown>;
const backups = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".agentmon-backup-")) : []);
const posix = process.platform !== "win32";

describe("mergeAgentmonHooks", () => {
  test("pengaturan kosong atau tanpa hooks: hanya hooks kita ditambahkan, kolom lain utuh", () => {
    const r = mergeAgentmonHooks({ theme: "dark", permissions: { allow: ["Read"] } }, ours);
    expect(r.ok && r.changed).toBe(true);
    if (!r.ok) return;
    expect(r.settings.theme).toBe("dark");
    expect(r.settings.permissions).toEqual({ allow: ["Read"] });
    expect(Object.keys(r.settings.hooks as object)).toEqual([...HOOK_EVENTS]);
  });

  test("hook milik pengguna di event yang sama dan event lain tetap ada, milik kita ditaruh sesudahnya", () => {
    const existing = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [userHook] }], Elicitation: [{ hooks: [userHook] }] } };
    const r = mergeAgentmonHooks(existing, ours);
    if (!r.ok) throw new Error(r.reason);
    const hooks = r.settings.hooks as Record<string, { hooks: unknown[] }[]>;
    expect(hooks.PreToolUse![0]).toEqual({ matcher: "Bash", hooks: [userHook] });
    expect(hooks.PreToolUse!.length).toBe(2);
    expect(isAgentmonHook(hooks.PreToolUse![1]!.hooks[0])).toBe(true);
    expect(hooks.Elicitation).toEqual([{ hooks: [userHook] }]);
  });

  test("hook http milik pengguna ke alamat lain tidak dianggap milik kita", () => {
    expect(isAgentmonHook(userHttp)).toBe(false);
    expect(isAgentmonHook({ type: "http", url: "http://127.0.0.1:9000/hook" })).toBe(true);
    expect(isAgentmonHook({ type: "http", url: "http://localhost:47821/hook" })).toBe(false); // bukan bentuk yang kita tulis
    expect(isAgentmonHook({ type: "command", command: "http://127.0.0.1:1/hook" })).toBe(false);
    const r = mergeAgentmonHooks({ hooks: { Stop: [{ hooks: [userHttp] }] } }, ours);
    if (!r.ok) throw new Error(r.reason);
    expect((r.settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop![0]!.hooks).toEqual([userHttp]);
  });

  test("idempoten: digabung dua kali sama dengan sekali, dan tidak dianggap berubah", () => {
    const first = mergeAgentmonHooks({ hooks: { Stop: [{ hooks: [userHook] }] } }, ours);
    if (!first.ok) throw new Error(first.reason);
    const second = mergeAgentmonHooks(first.settings, ours);
    if (!second.ok) throw new Error(second.reason);
    expect(second.changed).toBe(false);
    expect(JSON.stringify(second.settings)).toBe(JSON.stringify(first.settings));
    const counts = Object.values(second.settings.hooks as Record<string, { hooks: unknown[] }[]>).map((groups) => groups.flatMap((g) => g.hooks).filter(isAgentmonHook).length);
    expect(counts).toEqual(HOOK_EVENTS.map(() => 1));
  });

  test("port atau token berganti: menggantikan, tidak menambah", () => {
    const old = mergeAgentmonHooks({}, buildClaudeHookSettings({ token: "cd".repeat(32), port: 40000 }));
    if (!old.ok) throw new Error(old.reason);
    const next = mergeAgentmonHooks(old.settings, ours);
    if (!next.ok) throw new Error(next.reason);
    expect(next.changed).toBe(true);
    const text = JSON.stringify(next.settings);
    expect(text).not.toContain("40000");
    expect(text).not.toContain("cd".repeat(32));
    expect(text.match(/\/hook"/g)?.length).toBe(HOOK_EVENTS.length);
  });

  test("grup yang memuat hook pengguna DAN hook kita: hanya hook kita yang diganti", () => {
    const mixed = { hooks: { Stop: [{ hooks: [userHook, { type: "http", url: "http://127.0.0.1:1/hook", timeout: 1 }] }] } };
    const r = mergeAgentmonHooks(mixed, ours);
    if (!r.ok) throw new Error(r.reason);
    const groups = (r.settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop!;
    expect(groups[0]!.hooks).toEqual([userHook]);
    expect(groups.flatMap((g) => g.hooks).filter(isAgentmonHook).length).toBe(1);
  });

  test("hook kita dari versi lama di event yang kini tidak dipakai dibuang", () => {
    const r = mergeAgentmonHooks({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "http", url: "http://127.0.0.1:47821/hook" }] }] } }, ours);
    if (!r.ok) throw new Error(r.reason);
    expect((r.settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeUndefined();
  });

  test.each([
    ["isi bukan objek", []],
    ["isi null", null],
    ["hooks bukan objek", { hooks: [] }],
    ["hooks null", { hooks: null }],
    ["event bukan daftar", { hooks: { Stop: "x" } }],
  ])("bentuk yang tidak dikenal ditolak, tidak ditimpa: %s", (_n, existing) => {
    expect(mergeAgentmonHooks(existing, ours).ok).toBe(false);
  });

  test("bentuk grup yang tidak dikenal dibiarkan apa adanya", () => {
    const odd = { hooks: { Stop: ["aneh", { sesuatu: 1 }] } };
    const r = mergeAgentmonHooks(odd, ours);
    if (!r.ok) throw new Error(r.reason);
    expect((r.settings.hooks as Record<string, unknown[]>).Stop!.slice(0, 2)).toEqual(["aneh", { sesuatu: 1 }]);
  });
});

describe("removeAgentmonHooks (dipakai uninstall)", () => {
  test("memulihkan pengaturan semula: merge lalu remove = awal", () => {
    const original = { theme: "dark", hooks: { Stop: [{ matcher: "x", hooks: [userHook] }], Elicitation: [{ hooks: [userHttp] }] } };
    const merged = mergeAgentmonHooks(original, ours);
    if (!merged.ok) throw new Error(merged.reason);
    const removed = removeAgentmonHooks(merged.settings);
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.settings).toEqual(original);
  });
  test("tanpa hook lain: kolom hooks hilang seluruhnya", () => {
    const merged = mergeAgentmonHooks({ theme: "dark" }, ours);
    if (!merged.ok) throw new Error(merged.reason);
    const removed = removeAgentmonHooks(merged.settings);
    expect(removed.ok && removed.settings).toEqual({ theme: "dark" });
  });
  test("tidak ada yang dibuang: tidak berubah", () => {
    const r = removeAgentmonHooks({ hooks: { Stop: [{ hooks: [userHook] }] } });
    expect(r.ok && r.changed).toBe(false);
  });
});

describe("runSetup: prasyarat", () => {
  test("Claude Code tidak ditemukan: pesan jelas, kode 1, tidak ada yang dibuat", async () => {
    const k = fresh();
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, findProgram: () => undefined });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/Claude Code tidak ditemukan/);
    expect(r.err.join("\n")).toContain(k.claudeDir);
    expect(existsSync(k.claudeDir)).toBe(false);
  });

  test("hanya folder pengaturannya yang ada (program tidak di PATH): tetap terdeteksi", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, findProgram: () => undefined });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/hanya folder pengaturannya/);
  });

  test("Codex terdeteksi hanya dilaporkan, tidak dipasangi apa pun", async () => {
    const k = fresh();
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, findProgram: () => "/usr/bin/x" });
    expect(r.out.join("\n")).toMatch(/Codex: terdeteksi, tetapi belum didukung/);
  });

  test("CLAUDE_CONFIG_DIR dipakai bila --claude-dir tidak diberikan", async () => {
    const k = fresh();
    const r = await setup({ home: k.home, claudeDir: undefined as unknown as string, env: { CLAUDE_CONFIG_DIR: k.claudeDir } });
    expect(r.code).toBe(0);
    expect(existsSync(k.file)).toBe(true);
  });
});

describe("runSetup: pemasangan", () => {
  test("pemasangan pertama (path ber-spasi): berkas baru dengan enam hook, tanpa cadangan, izin 0600", async () => {
    const k = fresh();
    expect(k.root).toContain(" ");
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.code).toBe(0);
    const settings = read(k.file);
    expect(Object.keys(settings.hooks as object)).toEqual([...HOOK_EVENTS]);
    expect(backups(k.claudeDir)).toEqual([]);
    expect(readdirSync(k.claudeDir)).toEqual(["settings.json"]); // tidak ada berkas sementara tersisa
    if (posix) expect(statSync(k.file).mode & 0o777).toBe(0o600);
  });

  test("TOKEN tidak pernah dicetak, di keluaran maupun galat, dan token berasal dari berkas data daemon", async () => {
    const k = fresh();
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    const token = readFileSync(join(k.home, "token"), "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(k.file, "utf8")).toContain(token);
    expect([...r.out, ...r.err].join("\n")).not.toContain(token);
  });

  test("pengaturan pengguna tetap utuh dan dicadangkan; cadangan identik dengan aslinya", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const original = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [userHook] }] } }, null, 2) + "\n";
    writeFileSync(k.file, original);
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.code).toBe(0);
    const settings = read(k.file);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect((settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop![0]!.hooks).toEqual([userHook]);
    const b = backups(k.claudeDir);
    expect(b).toEqual(["settings.json.agentmon-backup-20261118-093015"]);
    expect(readFileSync(join(k.claudeDir, b[0]!), "utf8")).toBe(original);
    expect(r.out.join("\n")).toContain("Cadangan pengaturan lama");
  });

  test("dijalankan dua kali: hook tidak ganda, berkas tidak ditulis ulang, tidak ada cadangan baru", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, JSON.stringify({ model: "opus" }));
    await setup({ home: k.home, claudeDir: k.claudeDir });
    const after1 = readFileSync(k.file, "utf8");
    const second = await setup({ home: k.home, claudeDir: k.claudeDir, now: () => new Date(2026, 10, 18, 9, 31, 0) });
    expect(second.code).toBe(0);
    expect(second.out.join("\n")).toMatch(/sudah terpasang dan mutakhir/);
    expect(readFileSync(k.file, "utf8")).toBe(after1);
    expect(backups(k.claudeDir).length).toBe(1);
    const third = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(readFileSync(k.file, "utf8")).toBe(after1);
    expect(third.code).toBe(0);
  });

  test("gaya berkas asli dipertahankan: tab, CRLF, BOM, tanpa baris akhir", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(k.file, `${bom}{\r\n\t"model": "opus"\r\n}`);
    await setup({ home: k.home, claudeDir: k.claudeDir });
    const text = readFileSync(k.file, "utf8");
    expect(text.startsWith(bom)).toBe(true);
    expect(text).toContain('\r\n\t"model": "opus"');
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false); // semua akhir baris CRLF
    expect(text.endsWith("}")).toBe(true); // tetap tanpa baris akhir
    expect(JSON.parse(text.slice(1)).model).toBe("opus");
  });

  test.runIf(posix)("izin berkas yang sudah ada dipertahankan, tidak dilonggarkan", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, "{}");
    chmodSync(k.file, 0o640);
    await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(statSync(k.file).mode & 0o777).toBe(0o640);
    chmodSync(k.file, 0o600);
    writeFileSync(k.file, JSON.stringify({ x: 1 }));
    await setup({ home: k.home, claudeDir: k.claudeDir, now: () => new Date(2026, 10, 18, 10, 0, 0) });
    expect(statSync(k.file).mode & 0o777).toBe(0o600);
  });

  test("berkas kosong dianggap pengaturan kosong", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, "  \n");
    expect((await setup({ home: k.home, claudeDir: k.claudeDir })).code).toBe(0);
    expect(Object.keys(read(k.file).hooks as object)).toEqual([...HOOK_EVENTS]);
  });

  test.each([
    ["bukan JSON", "{rusak"],
    ["array", "[]"],
    ["hooks bukan objek", '{"hooks": []}'],
    ["event bukan daftar", '{"hooks": {"Stop": 1}}'],
  ])("pengaturan yang tidak sah: %s -> kode 1, berkas tidak berubah, tanpa cadangan", async (_n, content) => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, content);
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("tidak mengubah apa pun");
    expect(readFileSync(k.file, "utf8")).toBe(content);
    expect(backups(k.claudeDir)).toEqual([]);
  });

  test("--dry-run: tidak menulis apa pun (termasuk cadangan), tetapi melaporkan yang akan terjadi", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, '{"model":"opus"}');
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/AKAN dipasang/);
    expect(readFileSync(k.file, "utf8")).toBe('{"model":"opus"}');
    expect(backups(k.claudeDir)).toEqual([]);
  });

  test("tidak pernah menulis ke dalam folder proyek (cwd): hanya ke folder pengaturan pengguna", async () => {
    const k = fresh();
    const project = join(k.root, "proyek");
    mkdirSync(project);
    const before = process.cwd();
    process.chdir(project);
    try {
      await setup({ home: k.home, claudeDir: k.claudeDir });
    } finally {
      process.chdir(before);
    }
    expect(readdirSync(project)).toEqual([]);
  });
});

describe("runSetup: daemon dan pairing", () => {
  test("melaporkan daemon berjalan atau belum, dan cara menyalakannya", async () => {
    const k = fresh();
    const off = await setup({ home: k.home, claudeDir: k.claudeDir, portOpen: async () => false });
    expect(off.out.join("\n")).toMatch(/Daemon: belum berjalan/);
    expect(off.out.join("\n")).toMatch(/AGENTMON_HOLD=1/);
    const on = await setup({ home: k.home, claudeDir: k.claudeDir, portOpen: async (p) => p === 47821 });
    expect(on.out.join("\n")).toMatch(/Daemon: berjalan di 127\.0\.0\.1:47821/);
  });

  test("port khusus ikut ke konfigurasi hook", async () => {
    const k = fresh();
    await setup({ home: k.home, claudeDir: k.claudeDir, port: 51234 });
    expect(readFileSync(k.file, "utf8")).toContain("http://127.0.0.1:51234/hook");
  });

  test("belum terdaftar ke relay: petunjuk, kode 0 (pemasangan hook tetap berhasil)", async () => {
    const k = fresh();
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, noPair: false });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/belum terdaftar ke relay/);
  });

  test("relay terdaftar tetapi AGENTMON_APP_URL kosong: petunjuk", async () => {
    const k = fresh();
    const env = { AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40) };
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, noPair: false, env });
    expect(r.out.join("\n")).toMatch(/AGENTMON_APP_URL/);
  });

  test("relay dan alamat aplikasi ada: QR ditampilkan lewat pairing, kodenya diteruskan", async () => {
    const k = fresh();
    const env = { AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40), AGENTMON_APP_URL: "https://app.contoh.com" };
    const seen: { relayUrl: string; appUrl: string }[] = [];
    const r = await setup({
      home: k.home,
      claudeDir: k.claudeDir,
      noPair: false,
      env,
      pair: async (o) => (seen.push({ relayUrl: o.relayUrl, appUrl: o.appUrl }), 7),
    });
    expect(seen).toEqual([{ relayUrl: "https://relay.contoh.com", appUrl: "https://app.contoh.com" }]);
    expect(r.code).toBe(7);
  });

  test("--no-pair dan --dry-run melewati pairing", async () => {
    const k = fresh();
    const env = { AGENTMON_RELAY_URL: "https://relay.contoh.com", AGENTMON_RELAY_TOKEN: "t".repeat(40), AGENTMON_APP_URL: "https://app.contoh.com" };
    let called = 0;
    const pair = async () => (called++, 0);
    await setup({ home: k.home, claudeDir: k.claudeDir, noPair: true, env, pair });
    await setup({ home: k.home, claudeDir: k.claudeDir, noPair: false, dryRun: true, env, pair });
    expect(called).toBe(0);
  });
});

describe("findOnPath", () => {
  test("menemukan program di PATH (folder ber-spasi) dan tidak menemukan yang tidak ada", () => {
    const dir = join(scratch, "bin dengan spasi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude.cmd"), "");
    const sep = process.platform === "win32" ? ";" : ":";
    const env = { PATH: `${join(scratch, "tidak-ada")}${sep}${dir}` };
    expect(findOnPath(["claude", "claude.cmd"], env)).toBe(join(dir, "claude.cmd"));
    expect(findOnPath(["codex"], env)).toBeUndefined();
    expect(findOnPath(["claude"], {})).toBeUndefined();
  });
});

describe("perintah CLI: setup", () => {
  test("terhubung ke CLI dengan --dry-run, --claude-dir, dan AGENTMON_HOME; tanpa menyentuh pengaturan nyata", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["setup", "--dry-run", "--claude-dir", k.claudeDir], { env: { AGENTMON_HOME: k.home, PATH: "" }, out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/AKAN dipasang/);
    expect(existsSync(k.file)).toBe(false);
  });

  test("argumen salah atau port tidak sah ditolak", async () => {
    const k = fresh();
    const io = { out: () => undefined, err: () => undefined };
    expect(await runCli(["setup", "--aneh"], { env: { AGENTMON_HOME: k.home }, ...io })).toBe(2);
    expect(await runCli(["setup", "--claude-dir"], { env: { AGENTMON_HOME: k.home }, ...io })).toBe(2);
    expect(await runCli(["setup"], { env: { AGENTMON_HOME: k.home, AGENTMON_PORT: "abc" }, ...io })).toBe(1);
  });
});
