// =====================================================================================
// FILE INI: menyimpan hasil pairing di HP = "DOMPET" tempat kunci laptop disimpan.
// =====================================================================================
//
// Yang disimpan per relay: nomor perangkat ini, TOKEN perangkat (kunci untuk tersambung ke relay),
// dan daftar laptop yang sudah dipasangkan. Satu HP bisa dipasangkan ke beberapa laptop di relay
// yang sama dan memakai SATU token; relay yang berbeda punya token masing-masing.
//
// Token adalah rahasia: siapa pun yang memegangnya bisa tersambung ke relay sebagai HP ini. Ia hanya
// ada di penyimpanan perangkat ini, tidak pernah ditulis ke alamat (URL) atau log. Kelak (tahap 4)
// kunci enkripsi juga disimpan di sini.
//
// Data dibaca dengan SANGAT hati-hati: isinya bisa rusak, berasal dari versi lama, atau diubah orang
// lain di perangkat itu. Bentuk yang tidak dikenal dianggap kosong, bukan membuat aplikasi gagal.
import { z } from "zod";

export const PAIRINGS_STORAGE_KEY = "agentmon.pairings";

const MachineSchema = z.object({ id: z.string().min(1), name: z.string(), pairedAt: z.string() });
const PairingSchema = z.object({
  relayUrl: z.string().min(1),
  deviceId: z.string().min(1),
  deviceToken: z.string().min(16),
  machines: z.array(MachineSchema),
});
const FileSchema = z.object({ v: z.literal(1), pairings: z.array(PairingSchema) });

export type PairedMachine = z.infer<typeof MachineSchema>;
export type StoredPairing = z.infer<typeof PairingSchema>;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Menyeragamkan alamat relay supaya "https://Relay.contoh.com/" dan "https://relay.contoh.com" dianggap
 * relay yang sama. Mengembalikan undefined bila bukan alamat yang sah.
 */
export function normalizeRelayUrl(relayUrl: string): string | undefined {
  try {
    const url = new URL(relayUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** Semua pairing yang tersimpan. Penyimpanan rusak, kosong, atau tidak bisa dibaca menghasilkan daftar kosong. */
export function loadPairings(storage: ReadableStorage | undefined): StoredPairing[] {
  try {
    const raw = storage?.getItem(PAIRINGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.pairings : [];
  } catch {
    return [];
  }
}

export function findPairing(pairings: StoredPairing[], relayUrl: string): StoredPairing | undefined {
  const wanted = normalizeRelayUrl(relayUrl);
  return wanted === undefined ? undefined : pairings.find((p) => normalizeRelayUrl(p.relayUrl) === wanted);
}

export type SaveInput = {
  relayUrl: string;
  deviceId: string;
  /** Token baru. Tidak ada bila HP memakai token lama untuk memasangkan laptop tambahan. */
  deviceToken?: string;
  machine: PairedMachine;
};

/**
 * Menyimpan hasil pairing. Laptop yang sama dipasangkan lagi memperbarui catatannya (tidak ganda).
 * Mengembalikan pairing yang tersimpan, atau undefined bila gagal (penyimpanan penuh atau tidak bisa dipakai):
 * pemanggil harus memberi tahu pengguna, karena pairing yang tidak tersimpan hilang saat aplikasi ditutup.
 */
export function savePairing(storage: WritableStorage | undefined, input: SaveInput): StoredPairing | undefined {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  if (!storage || relayUrl === undefined) return undefined;

  const all = loadPairings(storage);
  const existing = findPairing(all, relayUrl);
  const token = input.deviceToken ?? existing?.deviceToken;
  if (token === undefined) return undefined; // tanpa token tidak ada gunanya menyimpan

  const machines = [...(existing?.machines ?? []).filter((m) => m.id !== input.machine.id), input.machine];
  const saved: StoredPairing = { relayUrl, deviceId: input.deviceId, deviceToken: token, machines };
  const next = [...all.filter((p) => p !== existing), saved];

  try {
    storage.setItem(PAIRINGS_STORAGE_KEY, JSON.stringify({ v: 1, pairings: next }));
    // Dibaca kembali: penyimpanan yang diam-diam tidak menyimpan (mode privat tertentu) ketahuan di sini.
    return findPairing(loadPairings(storage), relayUrl);
  } catch {
    return undefined;
  }
}

/** Membuang token relay tertentu (misalnya perangkat ini sudah dicabut) beserta daftar laptopnya. */
export function removePairing(storage: WritableStorage | undefined, relayUrl: string): void {
  if (!storage) return;
  try {
    const all = loadPairings(storage);
    const existing = findPairing(all, relayUrl);
    if (!existing) return;
    storage.setItem(PAIRINGS_STORAGE_KEY, JSON.stringify({ v: 1, pairings: all.filter((p) => p !== existing) }));
  } catch {
    // diabaikan
  }
}
