// Lokasi data daemon di laptop dan token rahasia untuk autentikasi lokal.
//
// Semua data daemon ada di satu folder (bawaan: ~/.agentmon). Folder itu bisa diganti
// lewat AGENTMON_HOME, terutama supaya test tidak menyentuh data asli.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function agentmonHome(): string {
  return process.env.AGENTMON_HOME ?? join(homedir(), ".agentmon");
}

export function paths(home: string) {
  return {
    token: join(home, "token"),
    state: join(home, "daemon.json"),
    log: join(home, "daemon.log"),
    machineId: join(home, "machine-id"),
  };
}

// Bentuk token yang sah: 64 karakter heksadesimal. Satu definisi untuk semua pemakai
// (pembaca berkas token dan pembuat konfigurasi hook), supaya tidak bisa menyimpang.
export function isValidToken(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}

// Token dibuat sekali lalu dipakai ulang. Disimpan sebagai berkas biasa supaya hook
// dan CLI di laptop yang sama bisa membacanya, sedangkan program dari luar tidak.
export function loadOrCreateToken(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = paths(home).token;
  try {
    // Flag "wx" = buat hanya bila belum ada, dan atomik. Jika dua daemon berebut
    // membuat token, hanya satu yang menang dan yang lain membaca hasilnya.
    // Mode 0o600 membatasi berkas untuk pemilik (diabaikan di Windows, yang memakai
    // izin folder profil pengguna).
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!isValidToken(token)) {
    throw new Error(`Berkas token rusak: ${file}. Hapus berkas itu lalu jalankan ulang.`);
  }
  return token;
}

// Identitas laptop ini untuk kolom `machineId` di setiap event. Dibuat sekali lalu tetap,
// supaya relay dan HP bisa membedakan beberapa laptop milik satu pengguna. Berupa UUID
// acak, bukan nama komputer, sehingga tidak membocorkan informasi pribadi.
export function loadOrCreateMachineId(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = paths(home).machineId;
  try {
    writeFileSync(file, `${randomUUID()}
`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = readFileSync(file, "utf8").trim();
  if (id === "") throw new Error(`Berkas machine-id kosong: ${file}. Hapus berkas itu lalu jalankan ulang.`);
  return id;
}

// Perbandingan waktu-tetap: lama pemeriksaan tidak bergantung pada berapa karakter
// yang benar, jadi token tidak bisa ditebak lewat selisih waktu respons.
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
