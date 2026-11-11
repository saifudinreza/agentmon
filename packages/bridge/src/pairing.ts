// =====================================================================================
// FILE INI: perintah `pair` di laptop = "MENCETAK TIKET QR" lalu menunggu HP memindainya.
// =====================================================================================
//
// Urutan kerjanya:
//   1. Catat HP yang sudah terpasang (supaya yang lama tidak dianggap baru).
//   2. Minta kode sekali pakai ke relay (butuh token laptop).
//   3. Tampilkan kode itu sebagai QR di terminal, juga sebagai tulisan alamat untuk jaga-jaga.
//   4. Tunggu: tiap beberapa detik tanya relay "sudah ada HP baru?". Begitu ada, beri tahu
//      namanya dan selesai. Bila kode kedaluwarsa duluan, beri tahu dan keluar.
//
// ANALOGI: seperti mencetak tiket antrean lalu menunggu di loket sampai tiketnya dipanggil.
//
// QR berisi alamat aplikasi HP (PWA) dengan kode di FRAGMEN alamat (lihat @agentmon/shared
// pairing.ts), jadi kode tidak masuk log server mana pun dan tempat rahasia E2E nanti sudah siap.
//
// Semua yang berhubungan dengan dunia luar (jaringan, jam, tidur, pencetak QR) bisa diganti dari
// luar, supaya test berjalan cepat dan tidak butuh relay sungguhan.
import {
  buildPairingUrl,
  PairCodeResponseSchema,
  PairedDevicesResponseSchema,
  sanitizeForTerminal,
  type PairedDevice,
} from "@agentmon/shared";
import { renderQrForTerminal } from "./qr";

export type PairOptions = {
  /** Alamat dasar relay, misalnya https://relay.contoh.com */
  relayUrl: string;
  /** Token laptop untuk relay. */
  machineToken: string;
  /** Alamat aplikasi HP (PWA) yang dibuka QR. */
  appUrl: string;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Pencetak QR untuk terminal. Bawaannya memakai blok setengah tinggi supaya QR ringkas. */
  renderQr?: (text: string) => Promise<string>;
};

const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_MS = 2000;

// Pencetak sendiri (qr.ts): setengah blok, hitam di atas putih, terbaca di terminal gelap maupun terang.
const defaultRenderQr = (text: string): Promise<string> => Promise.resolve(renderQrForTerminal(text));

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Mengembalikan kode keluar: 0 = ada HP baru terpasang, 1 = gagal atau kedaluwarsa. */
export async function runPair(options: PairOptions): Promise<number> {
  const { out, err } = options;
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const render = options.renderQr ?? defaultRenderQr;
  const base = options.relayUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${options.machineToken}` };

  // Pemeriksaan alamat di awal, supaya salah ketik langsung dijelaskan dengan bahasa manusia.
  try {
    buildPairingUrl(options.appUrl, { code: "x".repeat(32), relayUrl: options.relayUrl });
  } catch (error) {
    err(`Alamat tidak valid: ${error instanceof Error ? error.message : String(error)}. Periksa AGENTMON_RELAY_URL dan AGENTMON_APP_URL.`);
    return 1;
  }

  // Satu fungsi untuk semua panggilan: gagal jaringan dan jawaban aneh dijadikan satu bentuk.
  type Reply = { status: number; body: unknown };
  const call = async (method: "GET" | "POST", path: string): Promise<Reply | undefined> => {
    try {
      const res = await http(`${base}${path}`, { method, headers: auth, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch {
      return undefined;
    }
  };

  const unreachable = () => {
    err(`Relay tidak terjangkau di ${base}. Periksa alamatnya dan koneksi internet.`);
    return 1;
  };
  const rejected = (status: number) => {
    err(
      status === 401
        ? "Relay menolak token laptop ini (AGENTMON_RELAY_TOKEN salah, atau laptop belum terdaftar di relay)."
        : `Relay menjawab dengan galat ${status}.`,
    );
    return 1;
  };

  // 1. HP yang sudah terpasang sekarang. Juga memeriksa token sejak awal.
  const before = await call("GET", "/pair/devices");
  if (!before) return unreachable();
  if (before.status !== 200) return rejected(before.status);
  const known = new Set<string>();
  const parsedBefore = PairedDevicesResponseSchema.safeParse(before.body);
  if (!parsedBefore.success) {
    err("Jawaban relay tidak dikenali. Mungkin versi relay tidak cocok.");
    return 1;
  }
  for (const device of parsedBefore.data.devices) known.add(device.id);

  // 2. Minta kode.
  const created = await call("POST", "/pair/code");
  if (!created) return unreachable();
  if (created.status === 429) {
    // Relay memakai 429 untuk dua sebab yang saran perbaikannya berbeda, jadi dibedakan.
    const reason = (created.body as { error?: unknown }).error;
    err(
      reason === "too-many-codes"
        ? "Terlalu banyak kode yang masih berlaku. Tunggu beberapa menit sampai kode lama kedaluwarsa, lalu coba lagi."
        : "Terlalu sering meminta kode. Tunggu sebentar (sekitar setengah menit), lalu coba lagi.",
    );
    return 1;
  }
  if (created.status !== 201) return rejected(created.status);
  const code = PairCodeResponseSchema.safeParse(created.body);
  if (!code.success) {
    err("Jawaban relay tidak dikenali. Mungkin versi relay tidak cocok.");
    return 1;
  }
  const expiresAt = Date.parse(code.data.expiresAt);

  // 3. Tampilkan.
  const url = buildPairingUrl(options.appUrl, { code: code.data.code, relayUrl: options.relayUrl });
  out(await render(url));
  out("Pindai QR di atas dengan kamera HP. Bila QR tidak terbaca, buka alamat ini di HP:");
  out(url);
  out(`Berlaku sampai ${new Date(expiresAt).toLocaleTimeString()} dan hanya bisa dipakai sekali. Jangan bagikan ke siapa pun.`);
  out("Menunggu HP...");

  // 4. Menunggu. Gangguan sesaat saat bertanya tidak menghentikan penantian.
  while (now() < expiresAt) {
    await sleep(pollMs);
    const reply = await call("GET", "/pair/devices");
    if (reply?.status !== 200) continue;
    const parsed = PairedDevicesResponseSchema.safeParse(reply.body);
    if (!parsed.success) continue;
    const fresh: PairedDevice[] = parsed.data.devices.filter((device) => !known.has(device.id));
    if (fresh.length > 0) {
      // Nama datang dari HP (tidak tepercaya). Karakter kontrol diganti supaya tidak bisa
      // menghapus layar atau menyamarkan tulisan lain di terminal.
      for (const device of fresh) out(`Perangkat baru terpasang: ${sanitizeForTerminal(device.name)}`);
      return 0;
    }
  }
  err("Kode kedaluwarsa sebelum ada HP yang memindainya. Jalankan perintah pair lagi untuk membuat kode baru.");
  return 1;
}
