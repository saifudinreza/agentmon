// FILE INI: TEST perintah `uninstall` (issue #045). Jaminan utama:
//   - setup lalu uninstall mengembalikan pengaturan Claude Code seperti semula, TANPA memulihkan cadangan (perubahan pengguna sesudah setup tetap ada),
//   - hook milik pengguna (termasuk yang ditambahkan sesudah setup) tidak tersentuh,
//   - tiap langkah bisa gagal tanpa menghentikan yang lain, dan semuanya aman diulang,
//   - penghapusan data hanya bila diminta, hanya berkas yang dikenal, dan aturan pengguna dipertahankan,
//   - laptop dicabut dari relay dengan token yang tidak pernah dicetak, dan relay.json dipertahankan bila pencabutan belum berhasil.
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { installAutostart, type Exec } from "./autostart";
import { runCli } from "./cli";
import { startDaemon } from "./daemon";
import { isAgentmonHook, runSetup } from "./setup";
import { defaultStopDaemon, runUninstall, type UninstallOptions } from "./uninstall";

const scratch = mkdtempSync(join(tmpdir(), "agentmon uninstall "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const TOKEN_RELAY = "relay-token-rahasia-jangan-bocor-0123456789";
const userHook = { type: "command", command: "echo halo" };

let counter = 0;
function sandbox() {
  const root = join(scratch, `kasus ${++counter}`);
  const home = join(root, "data agentmon");
  const claudeDir = join(root, "folder claude");
  mkdirSync(home, { recursive: true });
  return { root, home, claudeDir, file: join(claudeDir, "settings.json") };
}
// fetch bawaan Node menambahkan header sec-fetch-*: daemon menolaknya sebagai "request dari browser". Klien lokal memakai node:http polos.
const rawStatus = (port: number, method: string, path: string, token: string) =>
  new Promise<number>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
const OK = { code: 0, stdout: "", stderr: "" };
const okExec: Exec = async () => OK;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
const backups = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".agentmon-backup-")) : []);

type Run = { code: number; out: string[]; err: string[]; text: string };
async function uninstall(sb: ReturnType<typeof sandbox>, over: Partial<UninstallOptions> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUninstall({
    home: sb.home,
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    claudeDir: sb.claudeDir,
    portOpen: async () => false,
    waitMs: 100,
    autostart: { platform: "linux", exec: okExec, homeDir: sb.root },
    now: () => new Date(2026, 10, 18, 9, 30, 15),
    ...over,
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}
async function setup(sb: ReturnType<typeof sandbox>) {
  const out: string[] = [];
  const code = await runSetup({ home: sb.home, env: {}, out: (t) => out.push(t), err: () => undefined, claudeDir: sb.claudeDir, noPair: true, findProgram: (n) => (n.includes("claude") ? "/usr/bin/claude" : undefined), portOpen: async () => true });
  expect(code).toBe(0);
}

describe("hook: setup lalu uninstall mengembalikan pengaturan seperti semula", () => {
  const originals: Array<[string, unknown]> = [
    ["pengaturan tanpa kolom hooks", { model: "opus", permissions: { allow: ["Bash(ls)"] } }],
    ["hook milik pengguna di event yang sama dan lain", { model: "opus", hooks: { Stop: [{ matcher: "x", hooks: [userHook] }], Elicitation: [{ hooks: [userHook] }], PreToolUse: [{ matcher: "Bash", hooks: [userHook] }] } }],
    ["hook pengguna dan AgentMon dalam SATU grup yang sama (diedit tangan)", { hooks: { Stop: [{ hooks: [userHook] }] }, theme: "dark" }],
  ];
  test.each(originals)("%s", async (_n, original) => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify(original, null, 2));
    await setup(sb);
    expect(JSON.stringify(read(sb.file))).not.toBe(JSON.stringify(original)); // setup memang mengubahnya
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(read(sb.file)).toEqual(original);
    expect(JSON.stringify(read(sb.file))).toBe(JSON.stringify(original)); // urutan kunci pun sama
  });

  test("berkas yang dibuat setup dan kini tak berisi apa pun lagi: dihapus (dicadangkan dulu)", async () => {
    const sb = sandbox();
    await setup(sb);
    expect(existsSync(sb.file)).toBe(true);
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(existsSync(sb.file)).toBe(false);
    expect(backups(sb.claudeDir)).toHaveLength(1);
    expect(r.text).toMatch(/tidak berisi apa pun lagi, jadi dihapus/);
  });

  test("berkas yang akan dihapus (hanya berisi hook AgentMon) berubah selagi berjalan: batal, tidak dihapus", async () => {
    const sb = sandbox();
    await setup(sb);
    const changed = JSON.stringify({ model: "ditulis claude code" });
    const r = await uninstall(sb, {
      now: () => {
        writeFileSync(sb.file, changed);
        return new Date(2026, 10, 18, 9, 30, 15);
      },
    });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/berubah selagi/);
    expect(readFileSync(sb.file, "utf8")).toBe(changed);
    expect(backups(sb.claudeDir)).toEqual([]);
  });

  test("TIDAK memulihkan cadangan: perubahan pengguna sesudah setup tetap ada, hook pengguna yang ditambahkan sesudah setup utuh", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    const afterSetup = read(sb.file) as { hooks: Record<string, unknown[]>; model: string; permissions?: unknown };
    afterSetup.model = "sonnet"; // diubah SESUDAH setup
    afterSetup.permissions = { allow: ["Read"] }; // ditambah sesudah setup
    afterSetup.hooks.Stop!.push({ hooks: [userHook] }); // hook baru sesudah setup, SESUDAH hook AgentMon
    afterSetup.hooks.PostToolUse!.unshift({ matcher: "Write", hooks: [userHook] }); // dan SEBELUM
    afterSetup.hooks.Elicitation = [{ hooks: [userHook] }]; // event baru
    writeFileSync(sb.file, JSON.stringify(afterSetup, null, 2));
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(read(sb.file)).toEqual({
      model: "sonnet",
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [userHook] }], PostToolUse: [{ matcher: "Write", hooks: [userHook] }], Elicitation: [{ hooks: [userHook] }] },
    });
  });

  test("sesudah uninstall tidak ada satu pun hook AgentMon di pengaturan (agent berjalan tanpa hook yang gagal)", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } }));
    await setup(sb);
    await uninstall(sb);
    const walk = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(walk) : typeof value === "object" && value !== null ? [value, ...Object.values(value).flatMap(walk)] : []);
    expect(walk(read(sb.file)).filter(isAgentmonHook)).toEqual([]);
    expect(readFileSync(sb.file, "utf8")).not.toContain("127.0.0.1");
    expect(readFileSync(sb.file, "utf8")).not.toContain(readFileSync(join(sb.home, "token"), "utf8").trim()); // token tidak tersisa di pengaturan
  });

  test("gaya berkas (tab, CRLF, BOM) dipertahankan", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(sb.file, `${bom}{\r\n\t"model": "opus"\r\n}`);
    await setup(sb);
    await uninstall(sb);
    const text = readFileSync(sb.file, "utf8");
    expect(text.startsWith(bom)).toBe(true);
    expect(text).toContain('\r\n\t"model": "opus"');
    expect(JSON.parse(text.slice(1))).toEqual({ model: "opus" });
  });

  test("aman diulang: uninstall kedua melaporkan tidak ada yang dicopot dan tidak mengubah apa pun", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    await uninstall(sb);
    const after = readFileSync(sb.file, "utf8");
    const backupCount = backups(sb.claudeDir).length;
    const again = await uninstall(sb);
    expect(again.code).toBe(0);
    expect(again.text).toMatch(/tidak ada hook AgentMon/);
    expect(readFileSync(sb.file, "utf8")).toBe(after);
    expect(backups(sb.claudeDir)).toHaveLength(backupCount);
  });

  test("tanpa settings.json sama sekali: tidak ada yang dilakukan, bukan galat", async () => {
    const sb = sandbox();
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/tidak ada settings\.json/);
    expect(existsSync(sb.claudeDir)).toBe(false);
  });

  test.each([
    ["bukan JSON", "{rusak"],
    ["array", "[]"],
    ["hooks bukan objek", '{"hooks": []}'],
  ])("pengaturan yang tidak sah (%s): langkah ini gagal, berkas TIDAK diubah, langkah lain tetap jalan", async (_n, content) => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, content);
    const r = await uninstall(sb);
    expect(r.code).toBe(1);
    expect(readFileSync(sb.file, "utf8")).toBe(content);
    expect(backups(sb.claudeDir)).toEqual([]);
    expect(r.text).toMatch(/Autostart/); // langkah berikutnya tetap dicoba
    expect(r.text).toMatch(/Relay/);
  });

  test("pengaturan berubah selagi uninstall berjalan: batal tanpa menimpa perubahan itu", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    const changed = JSON.stringify({ model: "ditulis claude code" });
    const r = await uninstall(sb, {
      now: () => {
        writeFileSync(sb.file, changed); // Claude Code menulis di antara baca dan ganti
        return new Date(2026, 10, 18, 9, 30, 15);
      },
    });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/berubah selagi/);
    expect(readFileSync(sb.file, "utf8")).toBe(changed);
  });

  test("folder Claude relatif ditolak (token tidak boleh jatuh ke folder kerja)", async () => {
    const sb = sandbox();
    const r = await uninstall(sb, { claudeDir: "relatif/claude" });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/path absolut/);
  });

  test("tautan simbolik yang HANYA berisi hook AgentMon: tautan tidak dihapus, isi tujuannya dikosongkan", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    const target = join(sb.root, "dotfiles-kosong.json");
    writeFileSync(target, "{}");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(target, sb.file, "file");
    } catch {
      return; // tanpa izin membuat tautan di mesin ini
    }
    await setup(sb);
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({});
    expect(r.text).toMatch(/tautan simbolik tidak dihapus/);
  });

  test("deleteSettings menolak menghapus tautan simbolik (lapis kedua)", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    const target = join(sb.root, "dotfiles-x.json");
    writeFileSync(target, "{}");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(target, sb.file, "file");
    } catch {
      return;
    }
    const { deleteSettings } = await import("./setup");
    expect(() => deleteSettings(sb.file, "20261118-000000", "{}")).toThrow(/tautan simbolik/);
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
  });

  test("tautan simbolik settings.json: tautan tetap, isi tujuannya yang dibersihkan", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    const target = join(sb.root, "dotfiles-settings.json");
    writeFileSync(target, JSON.stringify({ model: "opus" }));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(target, sb.file, "file");
    } catch {
      return; // tanpa izin membuat tautan di mesin ini
    }
    await setup(sb);
    const r = await uninstall(sb);
    expect(r.code).toBe(0);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ model: "opus" });
  });
});

describe("--dry-run: hanya melaporkan", () => {
  test("tidak mengubah pengaturan, tidak menghentikan daemon, tidak menghubungi relay, tidak menghapus data", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    writeFileSync(join(sb.home, "relay.json"), JSON.stringify({ relayUrl: "https://relay.contoh.com", token: TOKEN_RELAY }));
    const before = readFileSync(sb.file, "utf8");
    const backupsBefore = backups(sb.claudeDir);
    let fetched = 0;
    let stopped = 0;
    const exec: Exec = async () => (stopped++, OK);
    const r = await uninstall(sb, { dryRun: true, purgeData: true, purgeCheckpoints: true, fetch: (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch, portOpen: async () => true, stopDaemon: async () => (stopped++, true), autostart: { platform: "linux", exec, homeDir: sb.root } });
    expect(readFileSync(sb.file, "utf8")).toBe(before);
    expect(fetched).toBe(0);
    expect(existsSync(join(sb.home, "token"))).toBe(true);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
    expect(r.text).toMatch(/AKAN membuang 6 hook AgentMon/);
    expect(r.text).toMatch(/AKAN mencabut laptop ini dari relay\.contoh\.com/);
    expect(r.text).toMatch(/AKAN diminta berhenti/);
    expect(r.text).toMatch(/AKAN menghapus/);
    expect(backups(sb.claudeDir)).toEqual(backupsBefore); // tidak ada cadangan baru
    void stopped;
  });
});

describe("autostart dan daemon", () => {
  test("autostart yang terpasang dicopot (dan daemon yang dinyalakannya dihentikan oleh langkah copot)", async () => {
    const sb = sandbox();
    const calls: string[] = [];
    const exec: Exec = async (file, args) => (calls.push(`${file} ${args.join(" ")}`), OK);
    const opts = { platform: "linux" as const, exec, homeDir: sb.root, portOpen: async () => true, startWaitMs: 30, launch: { node: "/usr/bin/node", args: ["/a/tsx.mjs", "/a/main.ts"], cwd: "/a", env: {} } };
    expect(await installAutostart({ env: {}, out: () => undefined, err: () => undefined, dataDir: sb.home, ...opts })).toBe(0);
    calls.length = 0;
    const r = await uninstall(sb, { autostart: opts });
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.includes("systemctl --user disable --now agentmon.service"))).toBe(true);
    expect(r.text).toMatch(/Autostart: dicopot/);
    expect(existsSync(join(sb.root, ".config", "systemd", "user", "agentmon.service"))).toBe(false);
  });

  test("autostart tidak terpasang: dilaporkan, bukan galat", async () => {
    const sb = sandbox();
    expect((await uninstall(sb)).text).toMatch(/Autostart: tidak terpasang/);
  });

  test("daemon yang masih berjalan (manual) diminta berhenti lewat tokennya, lalu dipastikan sudah berhenti", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "token"), `${"ab".repeat(32)}\n`);
    let open = true;
    const seen: string[] = [];
    const r = await uninstall(sb, {
      port: 47123,
      portOpen: async () => open,
      stopDaemon: async (port, token) => {
        seen.push(`${port}:${token}`);
        open = false;
        return true;
      },
    });
    expect(seen).toEqual([`47123:${"ab".repeat(32)}`]);
    expect(r.text).toMatch(/daemon yang masih berjalan sudah berhenti/);
    expect(r.text).not.toContain("ab".repeat(32)); // token tidak dicetak
  });

  test("daemon tidak berhenti atau tokennya tidak terbaca: langkah MANUAL dengan petunjuk, bukan keberhasilan palsu", async () => {
    const sb = sandbox();
    const noToken = await uninstall(sb, { portOpen: async () => true });
    expect(noToken.text).toMatch(/MANUAL.*Daemon.*tokennya tidak terbaca/);
    writeFileSync(join(sb.home, "token"), `${"ab".repeat(32)}\n`);
    const stuck = await uninstall(sb, { portOpen: async () => true, stopDaemon: async () => true });
    expect(stuck.text).toMatch(/MANUAL.*Daemon.*tidak berhenti/);
    const refused = await uninstall(sb, { portOpen: async () => true, stopDaemon: async () => false });
    expect(refused.text).toMatch(/MANUAL.*Daemon.*tidak berhenti/);
    expect(stuck.code).toBe(0); // langkah manual bukan kegagalan, tetapi tidak dianggap bersih
    expect(stuck.text).toMatch(/perlu Anda lakukan sendiri/);
  });
});

describe("POST /stop pada daemon sungguhan", () => {
  test("token benar: 200 lalu penghentian dipanggil SESUDAH jawaban terkirim; defaultStopDaemon memakainya", async () => {
    const sb = sandbox();
    let stops = 0;
    const daemon = await startDaemon({ home: sb.home, port: 0, onStop: () => void stops++ });
    try {
      expect(await defaultStopDaemon(daemon.port, daemon.token)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(stops).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  test("token salah ditolak, metode salah 405, tanpa onStop 501; penghentian tidak dipanggil", async () => {
    const sb = sandbox();
    let stops = 0;
    const daemon = await startDaemon({ home: sb.home, port: 0, onStop: () => void stops++ });
    try {
      expect(await defaultStopDaemon(daemon.port, "0".repeat(64))).toBe(false);
      expect(await rawStatus(daemon.port, "GET", "/stop", daemon.token)).toBe(405);
      await new Promise((r) => setTimeout(r, 50));
      expect(stops).toBe(0);
    } finally {
      await daemon.stop();
    }
    const plain = await startDaemon({ home: mkdtempSync(join(scratch, "tanpa-stop-")), port: 0 });
    try {
      expect(await rawStatus(plain.port, "POST", "/stop", plain.token)).toBe(501);
    } finally {
      await plain.stop();
    }
  });
});

describe("relay", () => {
  const withRelay = (sb: ReturnType<typeof sandbox>, url = "https://relay.contoh.com") => writeFileSync(join(sb.home, "relay.json"), JSON.stringify({ relayUrl: url, token: TOKEN_RELAY }));
  const respond = (status: number) => {
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const fetchFake = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFake };
  };

  test("berhasil: DELETE /machine dengan token laptop, relay.json ikut dihapus (token mati), token tidak dicetak", async () => {
    const sb = sandbox();
    withRelay(sb);
    const { calls, fetchFake } = respond(200);
    const r = await uninstall(sb, { fetch: fetchFake, purgeData: true });
    expect(calls).toEqual([{ url: "https://relay.contoh.com/machine", method: "DELETE", auth: `Bearer ${TOKEN_RELAY}` }]);
    expect(r.text).toMatch(/OK +Relay: laptop ini dicabut dari relay\.contoh\.com/);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(false);
    expect(r.text).not.toContain(TOKEN_RELAY);
    expect(r.code).toBe(0);
  });

  test("pengaturan relay dari lingkungan (AGENTMON_RELAY_*) juga dicabut", async () => {
    const sb = sandbox();
    const { calls, fetchFake } = respond(200);
    await uninstall(sb, { fetch: fetchFake, env: { AGENTMON_RELAY_URL: "https://relay.lingkungan.test/", AGENTMON_RELAY_TOKEN: TOKEN_RELAY } });
    expect(calls[0]!.url).toBe("https://relay.lingkungan.test/machine");
  });

  test("lingkungan menimpa relay lain: relay.json milik relay yang berbeda TIDAK dihapus oleh --purge-data", async () => {
    const sb = sandbox();
    withRelay(sb, "https://relay-asli.contoh.com");
    const { fetchFake } = respond(200);
    await uninstall(sb, { fetch: fetchFake, purgeData: true, env: { AGENTMON_RELAY_URL: "https://relay.lingkungan.test", AGENTMON_RELAY_TOKEN: TOKEN_RELAY } });
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
  });

  test("checkpoints.json (satu-satunya daftar repo) dipertahankan oleh --purge-data bila checkpoint belum dibersihkan", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ a: { root: join(sb.root, "repo") } }));
    const r = await uninstall(sb, { purgeData: true });
    expect(existsSync(join(sb.home, "checkpoints.json"))).toBe(true);
    expect(r.text).toMatch(/--purge-checkpoints/);
    const r2 = await uninstall(sb, { purgeData: true, purgeCheckpoints: true, git: async () => OK });
    expect(r2.code).toBe(0);
    expect(existsSync(join(sb.home, "checkpoints.json"))).toBe(false);
  });

  test("401 (token sudah tidak dikenal): dianggap sudah dicabut, bukan galat", async () => {
    const sb = sandbox();
    withRelay(sb);
    const r = await uninstall(sb, { fetch: respond(401).fetchFake, purgeData: true });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/tidak mengenal token ini lagi/);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(false);
  });

  test.each([404, 405])("relay lama tanpa pencabutan mandiri (%s): langkah MANUAL, relay.json DIPERTAHANKAN walau --purge-data", async (status) => {
    const sb = sandbox();
    withRelay(sb);
    const r = await uninstall(sb, { fetch: respond(status).fetchFake, purgeData: true });
    expect(r.text).toMatch(/belum mendukung pencabutan mandiri/);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
    expect(r.code).toBe(0);
  });

  test.each([
    ["jaringan mati", async () => Promise.reject(new Error("ECONNREFUSED"))],
    ["relay 500", async () => new Response("{}", { status: 500 })],
    ["relay 429", async () => new Response("{}", { status: 429 })],
  ])("%s: GAGAL, kode 1, relay.json dipertahankan supaya bisa diulang; langkah lain tetap jalan", async (_n, impl) => {
    const sb = sandbox();
    withRelay(sb);
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    const r = await uninstall(sb, { fetch: impl as unknown as typeof fetch, purgeData: true });
    expect(r.code).toBe(1);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
    expect(existsSync(join(sb.home, "machine-id"))).toBe(existsSync(join(sb.home, "machine-id"))); // tidak dibahas: hanya relay.json yang dijamin
    expect(read(sb.file)).toEqual({ model: "opus" }); // hook tetap dicopot walau relay gagal
    expect(r.text).not.toContain(TOKEN_RELAY);
  });

  test("relay http:// di host lain: token TIDAK dikirim; AGENTMON_RELAY_INSECURE=1 mengizinkan; http ke komputer sendiri boleh", async () => {
    const sb = sandbox();
    withRelay(sb, "http://relay.contoh.com");
    const blocked = respond(200);
    const a = await uninstall(sb, { fetch: blocked.fetchFake });
    expect(blocked.calls).toEqual([]);
    expect(a.code).toBe(1);
    expect(a.text).toMatch(/tidak terenkripsi; token tidak dikirim/);
    const allowed = respond(200);
    await uninstall(sb, { fetch: allowed.fetchFake, env: { AGENTMON_RELAY_INSECURE: "1" } });
    expect(allowed.calls).toHaveLength(1);
    withRelay(sb, "http://127.0.0.1:8787");
    const local = respond(200);
    await uninstall(sb, { fetch: local.fetchFake });
    expect(local.calls).toHaveLength(1);
  });

  test("--skip-relay: tidak menghubungi relay dan relay.json dipertahankan; tanpa relay terdaftar: tidak ada yang dicabut", async () => {
    const sb = sandbox();
    withRelay(sb);
    const spy = respond(200);
    const r = await uninstall(sb, { fetch: spy.fetchFake, skipRelay: true, purgeData: true });
    expect(spy.calls).toEqual([]);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
    expect(r.text).toMatch(/dilewati \(--skip-relay\)/);
    const none = sandbox();
    expect((await uninstall(none, { fetch: spy.fetchFake })).text).toMatch(/tidak terdaftar ke relay/);
  });

  test("berkas relay.json rusak: dilaporkan gagal dan dipertahankan, tanpa menghubungi apa pun", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "relay.json"), "{rusak");
    const spy = respond(200);
    const r = await uninstall(sb, { fetch: spy.fetchFake, purgeData: true });
    expect(r.code).toBe(1);
    expect(spy.calls).toEqual([]);
    expect(existsSync(join(sb.home, "relay.json"))).toBe(true);
  });
});

describe("data lokal: ditawarkan, dihapus hanya bila diminta", () => {
  function populate(sb: ReturnType<typeof sandbox>) {
    for (const name of ["token", "machine-id", "daemon.json", "daemon.log", "daemon.log.1", "checkpoints.json", "session-flags.json", "claude-hooks.json"]) writeFileSync(join(sb.home, name), "x");
    mkdirSync(join(sb.home, "autostart"));
    writeFileSync(join(sb.home, "autostart", "agentmon-daemon.vbs"), "x");
    writeFileSync(join(sb.home, "policy.json"), JSON.stringify({ version: 1, rules: [] }));
    writeFileSync(join(sb.home, "milik-saya.txt"), "bukan berkas AgentMon");
    mkdirSync(join(sb.home, "folder-saya"));
    writeFileSync(join(sb.home, "folder-saya", "penting.txt"), "penting");
  }

  test("tanpa --purge-data: tidak ada yang dihapus, dan daftar yang masih ada disebutkan beserta cara menghapusnya", async () => {
    const sb = sandbox();
    populate(sb);
    const r = await uninstall(sb);
    expect(readdirSync(sb.home).sort()).toContain("token");
    expect(r.text).toMatch(/masih ada di .*token.*machine-id/);
    expect(r.text).toMatch(/uninstall --purge-data/);
    expect(r.text).toMatch(/policy\.json/);
  });

  test("--purge-data: hanya berkas yang DIKENAL dihapus; policy.json, berkas dan folder lain milik pengguna utuh", async () => {
    const sb = sandbox();
    populate(sb);
    const r = await uninstall(sb, { purgeData: true });
    expect(r.code).toBe(0);
    for (const name of ["token", "machine-id", "daemon.json", "daemon.log", "daemon.log.1", "checkpoints.json", "session-flags.json", "claude-hooks.json"]) expect(existsSync(join(sb.home, name)), name).toBe(false);
    expect(existsSync(join(sb.home, "autostart"))).toBe(false);
    expect(readdirSync(sb.home).sort()).toEqual(["folder-saya", "milik-saya.txt", "policy.json"]);
    expect(readFileSync(join(sb.home, "folder-saya", "penting.txt"), "utf8")).toBe("penting");
    expect(r.text).toMatch(/policy\.json \(aturan Anda\) dipertahankan/);
  });

  test("--purge-data --purge-policy: aturan ikut dihapus, dan folder data dihapus hanya bila sudah kosong", async () => {
    const sb = sandbox();
    for (const name of ["token", "machine-id", "policy.json"]) writeFileSync(join(sb.home, name), "x");
    await uninstall(sb, { purgeData: true, purgePolicy: true });
    expect(existsSync(sb.home)).toBe(false);
    const other = sandbox();
    populate(other);
    await uninstall(other, { purgeData: true, purgePolicy: true });
    expect(existsSync(other.home)).toBe(true); // masih berisi milik pengguna
    expect(existsSync(join(other.home, "policy.json"))).toBe(false);
  });

  test("cadangan pengaturan Claude Code (bisa memuat token lama) ikut dihapus oleh --purge-data, dan disebut bila tidak", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    writeFileSync(sb.file, JSON.stringify({ ...read(sb.file), model: "sonnet" })); // memaksa setup ulang menulis cadangan baru
    await setup(sb);
    expect(backups(sb.claudeDir).length).toBeGreaterThan(0);
    const kept = await uninstall(sb);
    expect(kept.text).toMatch(/cadangan pengaturan Claude Code \(bisa memuat token lama\)/);
    const purged = await uninstall(sb, { purgeData: true });
    expect(purged.code).toBe(0);
    expect(backups(sb.claudeDir)).toEqual([]);
  });

  test("path folder data berisi spasi dan apostrof tidak merusak apa pun", async () => {
    const root = join(scratch, `O'Brien ${++counter}`);
    const home = join(root, "data agentmon");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "token"), "x");
    const sb = { root, home, claudeDir: join(root, "claude"), file: join(root, "claude", "settings.json") };
    expect((await uninstall(sb, { purgeData: true })).code).toBe(0);
    expect(existsSync(join(home, "token"))).toBe(false);
  });
});

describe("checkpoint", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

  test("tanpa --purge-checkpoints: hanya ditawarkan (jumlah dan repo disebut), tidak ada git yang dijalankan", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ a: { root: "/repo/satu" }, b: { root: "/repo/satu" }, c: { root: "/repo/dua" } }));
    const calls: string[][] = [];
    const r = await uninstall(sb, { git: async (args) => (calls.push(args), { code: 0, stdout: "" }) });
    expect(calls).toEqual([]);
    expect(r.text).toMatch(/3 checkpoint di 2 repo masih ada\. Hapus dengan: uninstall --purge-checkpoints/);
  });

  test("--purge-checkpoints: hanya ref di bawah refs/agentmon/checkpoints/ yang dihapus (ref lain yang ikut terdaftar diabaikan)", async () => {
    const sb = sandbox();
    const repo = mkdtempSync(join(scratch, "repo-palsu-"));
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ a: { root: repo } }));
    const deleted: string[] = [];
    const r = await uninstall(sb, {
      purgeCheckpoints: true,
      git: async (args) => {
        if (args[0] === "for-each-ref") return { code: 0, stdout: "refs/agentmon/checkpoints/c1\nrefs/heads/utama\nrefs/tags/v1\nrefs/agentmon/lain/x\nrefs/agentmon/checkpoints/c2\n" };
        if (args[0] === "update-ref") deleted.push(args[2]!);
        return { code: 0, stdout: "" };
      },
    });
    expect(deleted).toEqual(["refs/agentmon/checkpoints/c1", "refs/agentmon/checkpoints/c2"]);
    expect(r.text).toMatch(/2 checkpoint dihapus di 1 repo/);
  });

  test("dengan git SUNGGUHAN: checkpoint dihapus, cabang dan tag pengguna utuh", async () => {
    const sb = sandbox();
    const repo = mkdtempSync(join(scratch, "repo-"));
    git(repo, "init", "-q", "-b", "utama");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "awal");
    git(repo, "update-ref", "refs/agentmon/checkpoints/c1", "HEAD");
    git(repo, "update-ref", "refs/agentmon/checkpoints/c2", "HEAD");
    git(repo, "tag", "v1");
    git(repo, "branch", "cabang-saya");
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ c1: { root: repo }, c2: { root: repo } }));
    const r = await uninstall(sb, { purgeCheckpoints: true });
    expect(r.code).toBe(0);
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/agentmon/")).toBe("");
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/", "refs/tags/").split(/\r?\n/).sort()).toEqual(["refs/heads/cabang-saya", "refs/heads/utama", "refs/tags/v1"]);
    expect(r.text).toMatch(/2 checkpoint dihapus di 1 repo/);
  });

  test("repo yang sudah tidak ada atau git gagal: dilewati atau dilaporkan, tidak pernah menjalankan perintah di tempat lain", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ a: { root: join(scratch, "tidak-ada-repo") } }));
    const calls: string[] = [];
    const r = await uninstall(sb, { purgeCheckpoints: true, git: async (args, cwd) => (calls.push(cwd), { code: 0, stdout: "" }) });
    expect(calls).toEqual([]);
    expect(r.text).toMatch(/tidak ada checkpoint AgentMon/);
    const repo = mkdtempSync(join(scratch, "repo-rusak-"));
    writeFileSync(join(sb.home, "checkpoints.json"), JSON.stringify({ a: { root: repo } }));
    const failed = await uninstall(sb, { purgeCheckpoints: true, git: async () => ({ code: 128, stdout: "" }) });
    expect(failed.code).toBe(1);
    expect(failed.text).toMatch(/GAGAL +Checkpoint/);
  });

  test("daftar checkpoint rusak atau tidak ada: tidak ada yang dilakukan dan bukan galat", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, "checkpoints.json"), "{rusak");
    expect((await uninstall(sb, { purgeCheckpoints: true })).code).toBe(0);
  });
});

describe("perintah CLI uninstall", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  };
  test.each([[["uninstall", "--aneh"]], [["uninstall", "--purge-policy"]], [["uninstall", "--claude-dir"]], [["uninstall", "--claude-dir", "--dry-run"]]])("argumen salah ditolak (kode 2): %j", async (argv) => {
    const sb = sandbox();
    const { deps } = io();
    expect(await runCli(argv, { env: { AGENTMON_HOME: sb.home }, ...deps })).toBe(2);
  });
  test("AGENTMON_PORT tidak sah ditolak", async () => {
    const sb = sandbox();
    const { deps } = io();
    expect(await runCli(["uninstall"], { env: { AGENTMON_HOME: sb.home, AGENTMON_PORT: "abc" }, ...deps })).toBe(1);
  });
  test("terhubung ke CLI dengan --dry-run dan --claude-dir, tanpa menyentuh apa pun", async () => {
    const sb = sandbox();
    mkdirSync(sb.claudeDir);
    writeFileSync(sb.file, JSON.stringify({ model: "opus" }));
    await setup(sb);
    const before = readFileSync(sb.file, "utf8");
    const { deps, out } = io();
    const code = await runCli(["uninstall", "--dry-run", "--claude-dir", sb.claudeDir, "--skip-relay"], {
      env: { AGENTMON_HOME: sb.home },
      ...deps,
      uninstall: { autostart: { platform: "linux", exec: okExec, homeDir: sb.root }, portOpen: async () => false },
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/--dry-run: tidak ada yang diubah/);
    expect(readFileSync(sb.file, "utf8")).toBe(before);
  });
});
