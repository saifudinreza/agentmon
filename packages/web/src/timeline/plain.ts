// =====================================================================================
// FILE INI: markdown -> teks polos = "PENGUPAS" untuk pesan dari agent.
// =====================================================================================
//
// Pesan akhir agent ("Agent berhenti") dan pemberitahuannya ditulis dalam markdown: **tebal**, `kode`, # judul, - daftar,
// [tautan](alamat). Di timeline HP tanda-tandanya tampil mentah dan mengganggu. Fungsi ini membuangnya dan menyisakan
// teksnya saja, TIDAK merender markdown menjadi HTML: isi berasal dari agent dan bisa memuat apa saja, jadi hasilnya tetap
// teks yang dilepas oleh React (tidak ada tautan yang bisa diketuk, tidak ada gambar yang memuat alamat luar). Tag HTML
// SENGAJA tidak dibuang: `Array<string>` dan `<div>` di teks teknis harus tetap terbaca, dan React menampilkannya apa adanya.
//
// Masukan dipotong dulu supaya pola-polanya tidak pernah bekerja di teks sangat panjang. Semua pola dibatasi panjangnya
// (tidak ada pengulangan tanpa batas yang bisa meledak pada masukan jahat).
const MAX_INPUT = 4000;

export function markdownToPlain(input: unknown): string {
  if (typeof input !== "string") return "";
  let text = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  text = text
    // Blok kode berpagar: pagar dibuang, isinya dipertahankan.
    .replace(/^[ \t]{0,3}(```|~~~)[^\n]{0,80}$/gm, "")
    // Gambar dan tautan: hanya teksnya. Alamatnya dibuang (tidak pernah ditampilkan sebagai tautan).
    // Alamat boleh memuat satu tingkat kurung ((javascript:alert(1))), jadi kurung bersarang ikut dibuang.
    .replace(/!\[([^\]\n]{0,200})\]\((?:[^()\n]|\([^()\n]{0,200}\)){0,2000}\)/g, "$1")
    .replace(/\[([^\]\n]{1,200})\]\((?:[^()\n]|\([^()\n]{0,200}\)){0,2000}\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]{1,2000})>/g, "$1")
    // Judul, kutipan, garis pemisah, baris pemisah tabel.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}([-*_][ \t]*){3,}$/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "")
    // Penanda daftar (- * + 1. 1)) dan kotak centang.
    .replace(/^[ \t]{0,12}(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    // Pipa tabel menjadi pemisah biasa.
    .replace(/[ \t]*\|[ \t]*/g, " · ")
    // Tebal, miring, coret, dan kode sebaris (yang di dalamnya hanya satu baris).
    .replace(/(\*\*|__)(?=\S)([^\n]{1,300}?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=[^\s*])([^\n*]{1,300}?)(?<=[^\s*])\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=[^\s_])([^\n_]{1,300}?)(?<=[^\s_])_(?![\w_])/g, "$1")
    .replace(/~~(?=\S)([^\n]{1,300}?)(?<=\S)~~/g, "$1")
    .replace(/`{1,3}([^`\n]{1,300})`{1,3}/g, "$1")
    // Garis miring terbalik yang melepas tanda markdown (\* \_ \#).
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
  return text;
}
