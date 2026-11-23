// =====================================================================================
// FILE INI: pintu masuk libsodium = satu-satunya tempat pustaka kripto dimuat (issue #033, docs/security-e2e.md bagian 7).
// =====================================================================================
//
// libsodium (build WASM biasa, bukan sumo) dimuat BELAKANGAN lewat import dinamis, supaya app dan daemon yang belum butuh
// kripto tetap ringan, dan harus menunggu `sodium.ready` sebelum fungsi apa pun dipanggil. Semua fungsi di folder ini menerima
// objek `Sodium` yang SUDAH siap sebagai argumen pertama, jadi memuatnya cukup di satu tempat (di sini) dan fungsinya sendiri
// sinkron dan mudah diuji.
import type * as SodiumModule from "libsodium-wrappers";

export type Sodium = typeof SodiumModule;

let loading: Promise<Sodium> | undefined;

/** Memuat libsodium sekali (lazy) dan menunggunya siap. Pemanggilan berikutnya memakai hasil yang sama. */
export function loadSodium(): Promise<Sodium> {
  loading ??= import("libsodium-wrappers")
    .then(async (module) => {
      const sodium = ((module as unknown as { default?: Sodium }).default ?? module) as Sodium;
      await sodium.ready;
      return sodium;
    })
    .catch((error: unknown) => {
      loading = undefined; // gagal memuat (jaringan putus, chunk hilang) tidak boleh terkunci selamanya: boleh dicoba lagi
      throw error;
    });
  return loading;
}
