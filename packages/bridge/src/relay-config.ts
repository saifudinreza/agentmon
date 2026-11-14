// =====================================================================================
// FILE INI: pengaturan relay di laptop = "KARTU ANGGOTA" yang disimpan setelah laptop terdaftar di relay.
// =====================================================================================
//
// Perintah `register` menyimpan alamat relay dan token laptop di folder data daemon (relay.json). Daemon dan perintah
// `pair`, `devices`, dan `revoke` membacanya, jadi tidak perlu variabel lingkungan yang harus disalin ke setiap terminal.
//
// ATURAN MEMILIH SUMBER (resolveRelayConfig):
//   - AGENTMON_RELAY_URL dan AGENTMON_RELAY_TOKEN keduanya diisi: dipakai apa adanya (lingkungan menang).
//   - Hanya AGENTMON_RELAY_URL diisi: token dari berkas dipakai HANYA bila alamatnya sama dengan yang di berkas.
//     Token milik satu relay tidak boleh terkirim ke relay lain hanya karena alamatnya diganti sementara.
//   - Tidak ada yang diisi: berkas.
//
// KEAMANAN: token disimpan sebagai teks biasa di berkas yang hanya bisa dibaca pemilik (mode 0600 di macOS dan Linux;
// Windows mengikuti izin folder profil pengguna). Token tidak pernah dicetak atau dicatat oleh modul ini.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./home";

export type RelayConfig = { relayUrl: string; token: string };
export type ResolvedRelayConfig = RelayConfig & { source: "env" | "file" };

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Sama dengan batas minimum token di relay (16); token hasil `register` selalu 64 karakter heksadesimal.
function isPlausibleToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && !/\s/.test(value);
}

/** Pengaturan tersimpan, atau undefined bila belum ada. Berkas yang rusak melempar galat yang menyebut lokasinya (tanpa isinya). */
export function loadRelayConfig(home: string): RelayConfig | undefined {
  const file = paths(home).relay;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Berkas pengaturan relay rusak: ${file}. Jalankan register ulang (dengan --rotate bila nomor laptop sudah terdaftar).`);
  }
  const config = parsed as { relayUrl?: unknown; token?: unknown } | null;
  if (!config || !isHttpUrl(config.relayUrl) || !isPlausibleToken(config.token)) {
    throw new Error(`Isi berkas pengaturan relay tidak sah: ${file}. Jalankan register ulang (dengan --rotate bila nomor laptop sudah terdaftar).`);
  }
  return { relayUrl: config.relayUrl, token: config.token };
}

/** Menyimpan pengaturan. Ditulis ke berkas sementara lalu dipindah, supaya berkas lama tidak rusak setengah jalan. */
export function saveRelayConfig(home: string, config: RelayConfig): string {
  const file = paths(home).relay;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ relayUrl: config.relayUrl, token: config.token }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

const sameRelay = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/**
 * Pengaturan relay yang berlaku, atau undefined bila tidak ada. Berkas yang rusak melempar galat (lihat loadRelayConfig):
 * lebih baik berhenti dengan penjelasan daripada diam-diam berjalan tanpa relay.
 */
export function resolveRelayConfig(env: Record<string, string | undefined>, home: string): ResolvedRelayConfig | undefined {
  const envUrl = env.AGENTMON_RELAY_URL?.trim() || undefined;
  const envToken = env.AGENTMON_RELAY_TOKEN?.trim() || undefined;
  if (envUrl && envToken) return { relayUrl: envUrl, token: envToken, source: "env" };

  const saved = loadRelayConfig(home);
  if (!saved) return undefined;
  // Token tanpa alamat dari lingkungan tidak masuk akal (alamat berasal dari berkas); alamat lingkungan yang berbeda
  // dari berkas berarti token berkas bukan untuk relay itu.
  if (envUrl && !sameRelay(envUrl, saved.relayUrl)) return undefined;
  if (envToken && !envUrl) return { ...saved, token: envToken, source: "env" };
  return { ...saved, source: "file" };
}
