// =====================================================================================
// FILE INI: "SAKLAR" E2E di PWA = satu-satunya tempat libsodium dan brankas kunci dihidupkan (issue #033; docs/security-e2e.md bagian 7).
// =====================================================================================
//
// libsodium dimuat BELAKANGAN (lazy): pengguna tanpa pairing E2E tidak memuat satu byte pun kode kripto. Saat aplikasi dibuka, brankas
// dibaca; bila ada isinya, libsodium dimuat dan gerbang dibuat SEBELUM layar digambar (event pertama pun harus lewat gerbang). Bila tidak ada,
// tidak ada yang dimuat sampai pairing E2E pertama (`ensureE2e`).
import { loadSodium } from "@agentmon/shared/crypto";
import { createGate, type E2eGate } from "./gate";
import { indexedDbBackend, KeyringError, openKeyring, type KeyBackend, type Keyring } from "./keyring";
import type { Sodium } from "@agentmon/shared/crypto";

export type E2eRuntime = { s: Sodium; keyring: Keyring; gate: E2eGate };

let runtime: E2eRuntime | undefined;
let starting: Promise<E2eRuntime> | undefined;
// Nomor laptop yang ditandai E2E di penyimpanan pairing (diisi dari localStorage oleh main.tsx dan RelayProvider).
let markers: ReadonlySet<string> = new Set();
export const setE2eMarkers = (ids: ReadonlySet<string>): void => {
  markers = ids;
};
export const isMarkedE2e = (machineId: string): boolean => markers.has(machineId);

/** Keadaan E2E sebuah laptop untuk layar: tidak E2E, E2E dengan kunci, atau E2E tetapi kuncinya tidak ada (pairing terputus atau brankas hilang). */
export function e2eStatus(machineId: string): "none" | "ok" | "no-keys" {
  if (runtime?.keyring.secured(machineId)) return "ok";
  return markers.has(machineId) ? "no-keys" : "none";
}

/** Runtime yang sedang hidup (sinkron), atau undefined bila belum ada pairing E2E dan belum dihidupkan. */
export const getE2e = (): E2eRuntime | undefined => runtime;

/** Menghidupkan runtime (memuat libsodium dan membuka brankas). Aman dipanggil berulang. Melempar bila penyimpanan tidak tersedia atau rusak. */
export function ensureE2e(backend: KeyBackend = indexedDbBackend()): Promise<E2eRuntime> {
  starting ??= (async () => {
    const s = await loadSodium();
    const keyring = await openKeyring(s, backend);
    runtime = { s, keyring, gate: createGate(s, keyring, (id) => markers.has(id), () => markers.size > 0) };
    return runtime;
  })().catch((error: unknown) => {
    starting = undefined; // boleh dicoba lagi (mis. penyimpanan baru diizinkan)
    throw error;
  });
  return starting;
}

/**
 * Dipanggil saat aplikasi dibuka: bila brankas sudah berisi laptop E2E, hidupkan runtime SEKARANG. Penyimpanan yang tidak ada (mode privat tertentu)
 * dianggap belum ada E2E. Brankas yang RUSAK tidak disembunyikan: galatnya dilempar supaya layar menjelaskannya, bukan diam-diam menjadi "polos".
 */
export async function initE2eIfPresent(backend: KeyBackend = indexedDbBackend(), options: { required?: boolean } = {}): Promise<E2eRuntime | undefined> {
  let raw: string | undefined;
  try {
    raw = await backend.read();
  } catch (error) {
    if (error instanceof KeyringError) throw error;
    // IndexedDB tidak tersedia. Tanpa laptop E2E itu tidak masalah (tidak ada yang dilindungi); dengan laptop E2E (`required`) HP TIDAK boleh diam-diam
    // berjalan tanpa gerbang, jadi galatnya dilempar dan layar menjelaskannya.
    if (options.required) throw new KeyringError("Penyimpanan kunci tidak tersedia.");
    return undefined;
  }
  // Ada laptop E2E di penyimpanan pairing: gerbang WAJIB hidup walau brankasnya kosong (dibersihkan peramban), supaya event polos ditolak.
  if (raw === undefined && !options.required) return undefined;
  const live = await ensureE2e(backend);
  return live.keyring.anySecured() || options.required ? live : undefined;
}

/** Hanya untuk tes. */
export function resetE2eForTests(): void {
  runtime = undefined;
  starting = undefined;
}
