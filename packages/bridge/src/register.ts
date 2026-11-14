// =====================================================================================
// FILE INI: perintah `register` = "MENDAFTAR JADI ANGGOTA" relay, sekali, oleh pemilik relay.
// =====================================================================================
//
// Relay yang baru di-deploy tidak mengenal laptop mana pun. `register` mengirim nomor laptop ini (UUID dari berkas
// machine-id, nomor yang sama dengan yang dipakai daemon di setiap event) dan namanya ke relay, memakai RAHASIA ADMIN
// yang hanya dimiliki pemilik relay. Relay membuat token, menyimpan HASH-nya, dan memberikan token itu SEKALI. Token
// disimpan di relay.json (relay-config.ts) dan dipakai otomatis oleh daemon dan perintah lain.
//
// ATURAN:
//   - Rahasia admin hanya dibaca dari AGENTMON_ADMIN_SECRET, bukan dari argumen perintah (argumen tercatat di riwayat
//     shell dan terlihat di daftar proses).
//   - Rahasia admin tidak dikirim lewat sambungan tanpa enkripsi ke host selain komputer ini (kecuali dinyalakan dengan
//     sadar), sama seperti token laptop.
//   - Token TIDAK dicetak, kecuali diminta (--print-token) atau bila berkas gagal ditulis: token hanya diberikan sekali,
//     jadi dalam kasus itu dicetak ke stderr daripada hilang.
//   - Nomor yang sudah terdaftar tidak ditimpa kecuali --rotate (token hilang atau bocor): daftar dua kali tidak boleh
//     diam-diam memutus laptop yang sedang berjalan.
import { hostname as osHostname } from "node:os";
import { MachineRegisterResponseSchema, sanitizeForTerminal } from "@agentmon/shared";
import { loadOrCreateMachineId, paths } from "./home";
import { loadRelayConfig, saveRelayConfig } from "./relay-config";
import { isLoopbackHost } from "./relay-client";

export type RegisterOptions = {
  /** Alamat dasar relay, misalnya https://relay.contoh.com */
  relayUrl: string;
  /** Rahasia admin relay (ADMIN_SECRET di relay). */
  adminSecret: string;
  /** Folder data daemon (tempat machine-id dan relay.json). */
  home: string;
  /** Nama yang tampil di HP. Bawaan: nama komputer. */
  name?: string;
  /** Mengganti token laptop yang sudah terdaftar. */
  rotate?: boolean;
  /** Mencetak AGENTMON_RELAY_URL dan AGENTMON_RELAY_TOKEN ke layar. */
  printToken?: boolean;
  /** Izinkan http:// ke host selain komputer ini. Rahasia admin dikirim tanpa enkripsi; hanya untuk jaringan tepercaya. */
  allowInsecure?: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  /** Hanya untuk test. */
  hostname?: () => string;
  /** Hanya untuk test: penyimpan pengaturan (bawaannya menulis relay.json). */
  save?: typeof saveRelayConfig;
};

const REQUEST_TIMEOUT_MS = 15_000;

/** Nama bawaan dari nama komputer: dipangkas 64 karakter, karakter kontrol dan format dibuang, dan tidak pernah kosong. */
export function defaultMachineName(hostname: string): string {
  // Karakter kontrol dibuang, begitu juga karakter format (mis. U+202E yang membalik arah teks dan bisa menyamarkan nama).
  const cleaned = sanitizeForTerminal(hostname).replace(/\?/g, "").replace(/\p{Cf}/gu, "").trim().slice(0, 64).trim();
  return cleaned || "Laptop";
}

/** Mengembalikan kode keluar: 0 = terdaftar dan tersimpan, 1 = gagal, 2 = pemakaian salah. */
export async function runRegister(options: RegisterOptions): Promise<number> {
  const { out, err } = options;
  const http = options.fetch ?? fetch;

  let url: URL;
  try {
    url = new URL(options.relayUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new RangeError("harus diawali https:// atau http://");
  } catch (error) {
    err(`Alamat relay tidak valid: ${error instanceof Error ? error.message : String(error)}. Periksa AGENTMON_RELAY_URL.`);
    return 2;
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !options.allowInsecure) {
    err(
      `Alamat relay ${url.hostname} tidak memakai enkripsi (http), sehingga rahasia admin akan terkirim sebagai teks biasa. Pakai https://. Hanya untuk jaringan tepercaya, izinkan dengan AGENTMON_RELAY_INSECURE=1.`,
    );
    return 2;
  }
  const base = options.relayUrl.replace(/\/+$/, "");

  let machineId: string;
  try {
    machineId = loadOrCreateMachineId(options.home);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Sudah terdaftar di relay yang sama? Jangan menghubungi relay dulu: pendaftaran kedua pasti ditolak (409), dan
  // memberi tahu lebih awal lebih jelas daripada galat dari relay.
  let existing: ReturnType<typeof loadRelayConfig>;
  try {
    existing = loadRelayConfig(options.home);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const sameRelay = existing && existing.relayUrl.replace(/\/+$/, "").toLowerCase() === base.toLowerCase();
  if (sameRelay && !options.rotate) {
    err(`Laptop ini sudah terdaftar di ${url.host} (pengaturan tersimpan di ${paths(options.home).relay}).`);
    err("Bila token hilang atau bocor dan ingin menggantinya, jalankan lagi dengan --rotate.");
    return 1;
  }

  const name = options.name?.trim() || defaultMachineName((options.hostname ?? osHostname)());

  let response: Response;
  try {
    response = await http(`${base}/admin/machines`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.adminSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: machineId, name, ...(options.rotate ? { rotate: true } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    err(`Relay tidak terjangkau di ${base}. Periksa alamatnya dan koneksi internet (relay gratis bisa butuh sekitar satu menit untuk bangun; coba lagi).`);
    return 1;
  }

  const body: unknown = await response.json().catch(() => ({}));
  const reason = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : undefined;

  if (response.status !== 201) {
    switch (response.status) {
      case 401:
        err("Relay menolak rahasia admin (AGENTMON_ADMIN_SECRET tidak sama dengan ADMIN_SECRET di relay).");
        break;
      case 404:
        err(
          reason === "not-found"
            ? "Nomor laptop ini belum terdaftar di relay, jadi tidak ada token yang bisa diganti. Jalankan tanpa --rotate."
            : "Relay tidak membuka pendaftaran laptop: ADMIN_SECRET belum diisi di relay, atau versi relay terlalu lama.",
        );
        break;
      case 409:
        err("Nomor laptop ini sudah terdaftar di relay. Bila token hilang atau bocor, jalankan lagi dengan --rotate.");
        break;
      case 429:
        err("Terlalu banyak percobaan, atau pendaftaran sedang dikunci sementara. Tunggu beberapa menit, lalu coba lagi.");
        break;
      case 400:
        err("Relay menolak data pendaftaran (nama tidak sah?). Coba nama lain dengan --name.");
        break;
      default:
        err(`Relay menjawab dengan galat ${response.status}.`);
    }
    return 1;
  }

  const parsed = MachineRegisterResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.machineId !== machineId) {
    err("Jawaban relay tidak dikenali. Mungkin versi relay tidak cocok. Pendaftaran mungkin sudah tercatat di relay; coba --rotate.");
    return 1;
  }

  // Token hanya diberikan sekali. Bila menyimpannya gagal, mencetaknya adalah satu-satunya cara tidak kehilangannya.
  let file: string;
  try {
    file = (options.save ?? saveRelayConfig)(options.home, { relayUrl: base, token: parsed.data.token });
  } catch (error) {
    err(`Laptop SUDAH terdaftar di relay, tetapi pengaturannya gagal disimpan (${error instanceof Error ? error.message : String(error)}).`);
    err("Token hanya diberikan sekali, jadi ini ditampilkan sekarang. Simpan, lalu isi sebagai variabel lingkungan:");
    err(`  AGENTMON_RELAY_URL=${base}`);
    err(`  AGENTMON_RELAY_TOKEN=${parsed.data.token}`);
    return 1;
  }

  out(`${options.rotate ? "Token laptop diganti" : "Laptop terdaftar"} di ${url.host}.`);
  out(`  nomor: ${machineId}`);
  out(`  nama:  ${name}`);
  out(`Pengaturan relay disimpan di ${file}. Daemon dan perintah pair, devices, dan revoke membacanya otomatis.`);
  if (options.printToken) {
    out(`  AGENTMON_RELAY_URL=${base}`);
    out(`  AGENTMON_RELAY_TOKEN=${parsed.data.token}`);
    out("Token ditampilkan karena diminta. Jangan dibagikan atau disimpan di tempat lain yang bisa dibaca orang.");
  } else {
    out("Token tidak ditampilkan. Tambahkan --print-token bila perlu menyalinnya ke tempat lain.");
  }
  out(options.rotate ? "Jalankan ulang daemon bila sedang berjalan: sambungan lamanya sudah diputus relay." : "Mulai (atau jalankan ulang) daemon untuk menyambung, lalu pasangkan HP dengan perintah pair.");
  return 0;
}
