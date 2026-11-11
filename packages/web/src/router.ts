// =====================================================================================
// FILE INI: perpindahan layar = "PAPAN PENUNJUK ARAH" yang sangat sederhana.
// =====================================================================================
//
// Aplikasi baru punya dua layar (beranda dan pairing), jadi pustaka router belum dibutuhkan. Cukup
// membaca jalur alamat (/pair) dan memakai History API browser. Bila layar bertambah banyak,
// file ini bisa diganti pustaka router tanpa mengubah komponen yang memakainya (usePath dan navigate).
import { useEffect, useState } from "react";

/** Jalur tanpa garis miring di akhir; kosong menjadi "/". */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Jalur alamat saat ini, dan memperbarui komponen saat pengguna berpindah layar atau menekan tombol kembali. */
export function usePath(): string {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));
  useEffect(() => {
    const update = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

/** Pindah ke layar lain. `replace` mengganti catatan riwayat saat ini (tombol kembali tidak kembali ke sini). */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  // pushState/replaceState tidak memicu popstate sendiri; dipicu manual supaya usePath ikut berubah.
  window.dispatchEvent(new PopStateEvent("popstate"));
}
