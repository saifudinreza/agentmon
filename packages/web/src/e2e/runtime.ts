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

/** Runtime yang sedang hidup (sinkron), atau undefined bila belum ada pairing E2E dan belum dihidupkan. */
export const getE2e = (): E2eRuntime | undefined => runtime;

/** Menghidupkan runtime (memuat libsodium dan membuka brankas). Aman dipanggil berulang. Melempar bila penyimpanan tidak tersedia atau rusak. */
export function ensureE2e(backend: KeyBackend = indexedDbBackend()): Promise<E2eRuntime> {
  starting ??= (async () => {
    const s = await loadSodium();
    const keyring = await openKeyring(s, backend);
    runtime = { s, keyring, gate: createGate(s, keyring) };
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
export async function initE2eIfPresent(backend: KeyBackend = indexedDbBackend()): Promise<E2eRuntime | undefined> {
  let raw: string | undefined;
  try {
    raw = await backend.read();
  } catch (error) {
    if (error instanceof KeyringError) throw error;
    return undefined; // IndexedDB tidak tersedia
  }
  if (raw === undefined) return undefined;
  const live = await ensureE2e(backend);
  return live.keyring.anySecured() ? live : undefined;
}

/** Hanya untuk tes. */
export function resetE2eForTests(): void {
  runtime = undefined;
  starting = undefined;
}
