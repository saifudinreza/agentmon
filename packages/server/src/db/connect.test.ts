import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { attachPoolErrorHandler, openPostgres, redactConnectionSecrets } from "./connect";

describe("attachPoolErrorHandler", () => {
  test("tanpa penangan, galat koneksi idle dilempar dan akan mematikan proses (alasan penangan ini wajib ada)", () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    expect(() => pool.emit("error", new Error("koneksi idle diputus server"))).toThrow("koneksi idle diputus server");
    void pool.end();
  });

  test("dengan penangan, galat hanya dicatat dan tidak dilempar", () => {
    const logs: string[] = [];
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    attachPoolErrorHandler(pool, { info: () => undefined, error: (m) => logs.push(m) });

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(() => pool.emit("error", new Error("galat lagi"))).not.toThrow(); // berulang pun aman

    expect(logs).toEqual(["kesalahan koneksi database: Connection terminated unexpectedly", "kesalahan koneksi database: galat lagi"]);
    void pool.end();
  });

  test("tanpa pencatat pun tidak melempar", () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    attachPoolErrorHandler(pool);
    expect(() => pool.emit("error", new Error("x"))).not.toThrow();
    void pool.end();
  });

  test("kata sandi di alamat database yang kebetulan ada di pesan galat disamarkan di log", () => {
    const logs: string[] = [];
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    attachPoolErrorHandler(pool, { info: () => undefined, error: (m) => logs.push(m) });
    pool.emit("error", new Error("gagal tersambung ke postgres://pengguna:RAHASIA-SANDI@host.example/db"));
    expect(logs.join("\n")).not.toContain("RAHASIA-SANDI");
    expect(logs.join("\n")).toContain("postgres://pengguna:***@host.example/db");
    void pool.end();
  });

  test("openPostgres sudah memasangnya: galat pada kolam miliknya tidak melempar", async () => {
    const logs: string[] = [];
    const handle = openPostgres("postgres://u:p@127.0.0.1:1/db", { logger: { info: () => undefined, error: (m) => logs.push(m) } });
    // Mengambil kolam lewat Drizzle: db.$client adalah Pool yang dipakai.
    const pool = (handle.db as unknown as { $client: Pool }).$client;
    expect(() => pool.emit("error", new Error("idle putus"))).not.toThrow();
    expect(logs).toEqual(["kesalahan koneksi database: idle putus"]);
    await handle.close();
  });
});

describe("redactConnectionSecrets", () => {
  test.each([
    ["postgres://pengguna:kata-sandi@host/db", "postgres://pengguna:***@host/db"],
    ["postgresql://a:b@h:5432/d?sslmode=require", "postgresql://a:***@h:5432/d?sslmode=require"],
    ["dua alamat postgres://u1:s1@h1/x dan postgres://u2:s2@h2/y", "dua alamat postgres://u1:***@h1/x dan postgres://u2:***@h2/y"],
    ["tanpa alamat, hanya teks biasa", "tanpa alamat, hanya teks biasa"],
    ["alamat tanpa kata sandi postgres://host/db", "alamat tanpa kata sandi postgres://host/db"],
  ])("%s", (input, expected) => {
    expect(redactConnectionSecrets(input)).toBe(expected);
  });
});
