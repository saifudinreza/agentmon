// FILE INI: TEST perintah `setup` (issue #043). Jaminan utama:
//   - pengaturan milik pengguna TETAP UTUH (hook lain, kolom lain, gaya berkas),
//   - dijalankan dua kali tidak membuat hook ganda dan tidak menulis ulang,
//   - berkas pengaturan (berisi token) izinnya tidak dilonggarkan dan isinya tidak pernah dicetak,
//   - path dengan spasi berfungsi, dan prasyarat yang kurang dijelaskan tanpa mengubah apa pun.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
// Hook AgentMon dikenali dari alamat DAN header Bearer 64-heksadesimal: fixture "hook lama kita" harus memuat keduanya.
const BEARER = { Authorization: `Bearer ${"cd".repeat(32)}` };
const oldOurs = (url: string) => ({ type: "http", url, headers: BEARER, timeout: 1 });

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
    expect(isAgentmonHook(oldOurs("http://127.0.0.1:9000/hook"))).toBe(true);
    expect(isAgentmonHook(oldOurs("http://localhost:47821/hook"))).toBe(true); // versi lama yang memakai localhost
    expect(isAgentmonHook(oldOurs("http://127.0.0.1:47821/hook/"))).toBe(true);
    // hook alat lain ke alamat yang mirip (tanpa header Bearer 64-heksadesimal) BUKAN milik kita
    expect(isAgentmonHook({ type: "http", url: "http://127.0.0.1:8080/hook" })).toBe(false);
    expect(isAgentmonHook({ type: "http", url: "http://127.0.0.1:8080/hook", headers: { Authorization: "Bearer pendek" } })).toBe(false);
    expect(isAgentmonHook({ type: "http", url: "http://127.0.0.1:8080/hook", headers: { "X-Api-Key": "cd".repeat(32) } })).toBe(false);
    expect(isAgentmonHook({ type: "http", url: "http://evil.test:47821/hook", headers: BEARER })).toBe(false);
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
    const mixed = { hooks: { Stop: [{ hooks: [userHook, oldOurs("http://127.0.0.1:1/hook")] }] } };
    const r = mergeAgentmonHooks(mixed, ours);
    if (!r.ok) throw new Error(r.reason);
    const groups = (r.settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop!;
    expect(groups[0]!.hooks).toEqual([userHook]);
    expect(groups.flatMap((g) => g.hooks).filter(isAgentmonHook).length).toBe(1);
  });

  test("hook kita dari versi lama di event yang kini tidak dipakai dibuang", () => {
    const r = mergeAgentmonHooks({ hooks: { UserPromptSubmit: [{ hooks: [oldOurs("http://127.0.0.1:47821/hook")] }] } }, ours);
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
    const token = readFileSync(join(k.home, "hook-token"), "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(k.file, "utf8")).toContain(token);
    expect([...r.out, ...r.err].join("\n")).not.toContain(token);
  });

  test("issue #82: pengaturan Claude Code hanya memuat token HOOK; token kendali (berkas token) tidak pernah ditulis ke sana", async () => {
    const k = fresh();
    mkdirSync(k.home, { recursive: true });
    const control = "cd".repeat(32);
    writeFileSync(join(k.home, "token"), `${control}\n`);
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    const hook = readFileSync(join(k.home, "hook-token"), "utf8").trim();
    expect(hook).not.toBe(control);
    const text = readFileSync(k.file, "utf8");
    expect(text).toContain(hook);
    expect(text).not.toContain(control);
    expect([...r.out, ...r.err].join("\n")).not.toContain(control);
    expect(readFileSync(join(k.home, "token"), "utf8").trim()).toBe(control); // setup tidak menyentuh token kendali
  });

  test("issue #82: daemon LAMA yang menolak token hook (401) membuat setup memperingatkan; daemon baru (405) tidak", async () => {
    const old = await setup({ home: fresh().home, claudeDir: fresh().claudeDir, portOpen: async () => true, probeHook: async () => 401 });
    expect(old.out.join("\n")).toMatch(/daemon yang berjalan masih versi lama/);
    const current = await setup({ home: fresh().home, claudeDir: fresh().claudeDir, portOpen: async () => true, probeHook: async () => 405 });
    expect(current.out.join("\n")).not.toMatch(/versi lama/);
    const down = await setup({ home: fresh().home, claudeDir: fresh().claudeDir, portOpen: async () => true, probeHook: async () => undefined });
    expect(down.out.join("\n")).not.toMatch(/versi lama/);
  });

  test("issue #82: token KENDALI yang tertinggal di pengaturan lama atau cadangan diperingatkan, dan tidak dicetak", async () => {
    const control = "ef".repeat(32);
    const withControlInSettings = fresh();
    mkdirSync(withControlInSettings.claudeDir);
    mkdirSync(withControlInSettings.home, { recursive: true });
    writeFileSync(join(withControlInSettings.home, "token"), `${control}\n`);
    writeFileSync(withControlInSettings.file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "http", url: "http://127.0.0.1:47821/hook", headers: { Authorization: `Bearer ${control}` } }] }] } }));
    const r = await setup({ home: withControlInSettings.home, claudeDir: withControlInSettings.claudeDir });
    expect(r.out.join("\n")).toMatch(/token KENDALI/);
    expect([...r.out, ...r.err].join("\n")).not.toContain(control);

    const clean = fresh();
    mkdirSync(clean.home, { recursive: true });
    writeFileSync(join(clean.home, "token"), `${control}\n`);
    expect((await setup({ home: clean.home, claudeDir: clean.claudeDir })).out.join("\n")).not.toMatch(/token KENDALI/);
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

// ---- Regresi review PR #81 ---------------------------------------------------------------------------------------------------
describe("review #81: hook alat lain dan hook lama", () => {
  test("hook alat lain ke 127.0.0.1:8080/hook (tanpa Bearer 64-heksadesimal) tidak dibuang atau diganti", () => {
    const other = { type: "http", url: "http://127.0.0.1:8080/hook", timeout: 3 };
    const r = mergeAgentmonHooks({ hooks: { Stop: [{ hooks: [other] }] } }, ours);
    if (!r.ok) throw new Error(r.reason);
    expect((r.settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop![0]!.hooks).toEqual([other]);
    expect(r.replaced).toBe(0);
  });

  test("hook lama kita yang memakai localhost atau /hook/ diganti, tidak jadi ganda; jumlah yang diganti dilaporkan", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const legacy = { hooks: { Stop: [{ hooks: [oldOurs("http://localhost:47821/hook")] }], PreToolUse: [{ hooks: [oldOurs("http://127.0.0.1:47821/hook/")] }] } };
    writeFileSync(k.file, JSON.stringify(legacy));
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.out.join("\n")).toContain("menggantikan 2 hook AgentMon lama");
    const hooks = read(k.file).hooks as Record<string, { hooks: unknown[] }[]>;
    for (const event of HOOK_EVENTS) expect(hooks[event]!.flatMap((g) => g.hooks).filter(isAgentmonHook).length, event).toBe(1);
    expect(JSON.stringify(hooks)).not.toContain("localhost");
  });

  test("setup ulang setelah pengguna menambah hook di event yang sama: tidak menulis ulang dan tidak ada cadangan baru", async () => {
    const k = fresh();
    await setup({ home: k.home, claudeDir: k.claudeDir });
    const settings = read(k.file) as { hooks: Record<string, unknown[]> };
    settings.hooks.Stop!.push({ hooks: [userHook] }); // ditambahkan SESUDAH hook kita
    settings.hooks.PreToolUse!.unshift({ matcher: "Bash", hooks: [userHook] }); // dan sebelumnya
    writeFileSync(k.file, JSON.stringify(settings, null, 2));
    const before = readFileSync(k.file, "utf8");
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, now: () => new Date(2026, 10, 18, 11, 0, 0) });
    expect(r.out.join("\n")).toMatch(/sudah terpasang dan mutakhir/);
    expect(readFileSync(k.file, "utf8")).toBe(before);
    expect(backups(k.claudeDir)).toEqual([]);
  });
});

describe("review #81: folder harus absolut dan token tidak boleh jatuh ke folder kerja", () => {
  test.each(["settings-rel", "./relatif", "../naik", "~/.claude"])("claudeDir relatif ditolak tanpa menulis apa pun: %s", async (dir) => {
    const k = fresh();
    const project = join(k.root, "proyek");
    mkdirSync(project);
    const before = process.cwd();
    process.chdir(project);
    try {
      const viaOption = await setup({ home: k.home, claudeDir: dir });
      const viaEnv = await setup({ home: k.home, claudeDir: undefined as unknown as string, env: { CLAUDE_CONFIG_DIR: dir } });
      expect(viaOption.code).toBe(1);
      expect(viaEnv.code).toBe(1);
      expect(viaOption.err.join("\n")).toMatch(/path absolut/);
    } finally {
      process.chdir(before);
    }
    expect(readdirSync(project)).toEqual([]);
    expect(readdirSync(k.root).sort()).toEqual(["data agentmon", "proyek"]);
  });

  test("CLAUDE_CONFIG_DIR kosong atau hanya spasi jatuh ke folder bawaan (tidak ke folder kerja)", async () => {
    const k = fresh();
    const project = join(k.root, "proyek");
    mkdirSync(project);
    const before = process.cwd();
    process.chdir(project);
    try {
      for (const value of ["", "   "]) {
        const r = await setup({ home: k.home, claudeDir: undefined as unknown as string, env: { CLAUDE_CONFIG_DIR: value }, dryRun: true });
        expect(r.out.join("\n")).toContain(join(homedir(), ".claude", "settings.json"));
      }
    } finally {
      process.chdir(before);
    }
    expect(readdirSync(project)).toEqual([]);
  });

  test("--claude-dir yang diikuti opsi lain ditolak (tidak membuat folder bernama --dry-run)", async () => {
    const k = fresh();
    const err: string[] = [];
    const project = join(k.root, "proyek");
    mkdirSync(project);
    const before = process.cwd();
    process.chdir(project);
    try {
      expect(await runCli(["setup", "--claude-dir", "--dry-run"], { env: { AGENTMON_HOME: k.home }, out: () => undefined, err: (t) => err.push(t) })).toBe(2);
    } finally {
      process.chdir(before);
    }
    expect(readdirSync(project)).toEqual([]);
    expect(err.join("\n")).toMatch(/path absolut/);
  });
});

describe("review #81: --dry-run benar-benar tidak menulis apa pun", () => {
  test("tidak membuat folder data maupun berkas token", async () => {
    const root = join(scratch, `kering ${++counter}`);
    const home = join(root, "belum ada");
    const claudeDir = join(root, "claude");
    mkdirSync(claudeDir, { recursive: true });
    const r = await setup({ home, claudeDir, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/AKAN dipasang/);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(claudeDir)).toEqual([]);
  });

  test("memakai token yang sudah ada untuk menghitung, tanpa mengubahnya", async () => {
    const k = fresh();
    await setup({ home: k.home, claudeDir: k.claudeDir });
    const token = readFileSync(join(k.home, "hook-token"), "utf8");
    const dry = await setup({ home: k.home, claudeDir: k.claudeDir, dryRun: true });
    expect(dry.out.join("\n")).toMatch(/sudah terpasang dan mutakhir/);
    expect(readFileSync(join(k.home, "hook-token"), "utf8")).toBe(token);
  });
});

describe("review #81: penulisan yang gagal atau bentrok", () => {
  test("pengaturan berubah selagi setup berjalan: batal, perubahan pihak lain tidak hilang, tanpa cadangan atau berkas sisa", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, '{"model":"opus"}');
    const r = await setup({
      home: k.home,
      claudeDir: k.claudeDir,
      now: () => {
        writeFileSync(k.file, '{"model":"sonnet","ditulis":"claude code"}'); // Claude Code menulis di antara baca dan ganti
        return new Date(2026, 10, 18, 9, 30, 15);
      },
    });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/berubah selagi setup berjalan/);
    expect(readFileSync(k.file, "utf8")).toBe('{"model":"sonnet","ditulis":"claude code"}');
    expect(readdirSync(k.claudeDir)).toEqual(["settings.json"]);
  });

  test("dua pemasangan dalam detik yang sama: nama cadangan tidak bentrok dan tidak gagal", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const same = () => new Date(2026, 10, 18, 9, 30, 15);
    writeFileSync(k.file, '{"a":1}');
    expect((await setup({ home: k.home, claudeDir: k.claudeDir, now: same })).code).toBe(0);
    writeFileSync(k.file, '{"a":2}');
    expect((await setup({ home: k.home, claudeDir: k.claudeDir, now: same })).code).toBe(0);
    expect(backups(k.claudeDir)).toEqual(["settings.json.agentmon-backup-20261118-093015", "settings.json.agentmon-backup-20261118-093015-2"]);
  });

  test("cadangan lama dipangkas: hanya 5 terbaru yang disimpan (cadangan lama bisa memuat token)", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    for (let i = 0; i < 8; i++) {
      writeFileSync(k.file, JSON.stringify({ putaran: i }));
      await setup({ home: k.home, claudeDir: k.claudeDir, now: () => new Date(2026, 10, 18, 9, 30, i) });
    }
    const kept = backups(k.claudeDir);
    expect(kept.length).toBe(5);
    expect(kept[0]).toBe("settings.json.agentmon-backup-20261118-093003");
    expect(kept[4]).toBe("settings.json.agentmon-backup-20261118-093007");
  });

  test("berkas yang tidak ada hubungannya (mirip nama) tidak ikut terpangkas", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const milik = join(k.claudeDir, "settings.json.bak");
    writeFileSync(milik, "punya saya");
    for (let i = 0; i < 8; i++) {
      writeFileSync(k.file, JSON.stringify({ putaran: i }));
      await setup({ home: k.home, claudeDir: k.claudeDir, now: () => new Date(2026, 10, 18, 9, 30, i) });
    }
    expect(readFileSync(milik, "utf8")).toBe("punya saya");
  });

  test("settings.json berupa tautan simbolik: tautan tetap, berkas tujuannya yang diperbarui", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    const dotfiles = join(k.root, "dotfiles");
    mkdirSync(dotfiles);
    const target = join(dotfiles, "claude-settings.json");
    writeFileSync(target, '{"model":"opus"}');
    try {
      symlinkSync(target, k.file, "file");
    } catch {
      return; // tidak ada izin membuat tautan simbolik di mesin ini
    }
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.code).toBe(0);
    expect(lstatSync(k.file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).model).toBe("opus");
    expect(Object.keys(JSON.parse(readFileSync(target, "utf8")).hooks)).toEqual([...HOOK_EVENTS]);
    expect(r.out.join("\n")).toContain(target);
  });

  test("disableAllHooks: true menimbulkan peringatan", async () => {
    const k = fresh();
    mkdirSync(k.claudeDir);
    writeFileSync(k.file, '{"disableAllHooks":true}');
    const r = await setup({ home: k.home, claudeDir: k.claudeDir });
    expect(r.out.join("\n")).toMatch(/disableAllHooks.*mengabaikan semua hook/);
  });

  test("pengaturan relay rusak setelah hook terpasang: peringatan, bukan kegagalan", async () => {
    const k = fresh();
    writeFileSync(join(k.home, "relay.json"), "{rusak"); // berkas pengaturan relay yang rusak membuat resolveRelayConfig melempar galat
    const r = await setup({ home: k.home, claudeDir: k.claudeDir, noPair: false });
    expect(r.code).toBe(0);
    expect(r.err.join("\n")).toMatch(/Pairing dilewati/);
    expect(existsSync(k.file)).toBe(true);
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
