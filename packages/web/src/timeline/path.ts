// Meringkas jalur berkas untuk DAFTAR di layar HP (timeline dan antrean izin). Jalur penuh tetap tersedia: di timeline lewat
// ketukan pada baris, di antrean lewat layar keputusan (yang menampilkan jalur UTUH, karena yang disetujui harus sama dengan
// yang terlihat). Fungsi ini hanya mengubah tampilan ringkas, tidak pernah dipakai untuk keputusan.

/** Nama bidang input alat yang berisi jalur berkas. */
export const PATH_KEYS: ReadonlySet<string> = new Set(["file_path", "path", "notebook_path"]);

/** Jalur lebih panjang dari ini diringkas. */
export const MAX_SHORT_PATH = 44;

function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * Jalur ringkas: "…/folder/berkas.ts" (dua bagian terakhir), atau hanya nama berkas bila itu pun terlalu panjang, atau
 * dipotong di tengah bila satu bagian saja sudah panjang. Jalur yang sudah pendek tidak berubah.
 */
export function shortenPath(path: string, max: number = MAX_SHORT_PATH): string {
  if (path.length <= max) return path;
  const sep = path.includes("/") || !path.includes("\\") ? "/" : "\\";
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  if (parts.length <= 1) return middleEllipsis(path, max);
  const prefix = `…${sep}`;
  const lastTwo = parts.slice(-2).join(sep);
  if (parts.length > 2 || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    if (prefix.length + lastTwo.length <= max) return `${prefix}${lastTwo}`;
    const name = parts[parts.length - 1]!;
    if (prefix.length + name.length <= max) return `${prefix}${name}`;
    return `${prefix}${middleEllipsis(name, max - prefix.length)}`;
  }
  return middleEllipsis(path, max);
}
