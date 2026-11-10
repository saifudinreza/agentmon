// =====================================================================================
// FILE INI: menghitung perbedaan dua teks, baris demi baris, menjadi daftar hunk.
// =====================================================================================
//
// ALUR:  teks lama + teks baru
//          1. dipecah menjadi baris (splitLines), dicatat gaya akhir barisnya
//          2. bagian awal dan akhir yang SAMA dibuang dulu (cara paling murah mengecilkan kerja)
//          3. sisanya dibandingkan dengan algoritma Myers, menghasilkan daftar hapus/tambah
//          4. perubahan yang berdekatan digabung menjadi hunk, lengkap dengan baris konteks
//
// ANALOGI: dua versi sebuah naskah. Langkah 2 mencoret halaman awal dan akhir yang identik.
// Langkah 3 mencari cara paling sedikit mencoret dan menulis ulang untuk mengubah naskah lama
// menjadi baru. Langkah 4 mengelompokkan coretan yang berdekatan menjadi "paragraf revisi".
//
// BATAS MEMORI: berkas besar tidak boleh menghabiskan memori daemon. Karena itu ada dua batas
// (jumlah baris yang dibandingkan, dan jarak edit maksimum). Bila terlampaui, hasilnya
// ringkasan "terlalu besar", bukan diff penuh.
import type { DiffFormat, DiffHunk, DiffLine, Eol } from "@agentmon/shared";

// ---- LANGKAH 1: memecah teks menjadi baris ---------------------------------------------

export type SplitText = {
  lines: string[]; // tanpa penanda akhir baris
  eol: Eol;
  finalNewline: boolean; // apakah teks berakhir dengan enter
};

/**
 * Memecah teks menjadi baris, sambil mencatat gaya akhir barisnya.
 *
 * Akhir baris Windows (CRLF) dan Unix (LF) dianggap SAMA saat membandingkan: baris dipotong tanpa
 * "\r". Kalau tidak, berkas Windows yang diusulkan agent dengan akhir baris Unix terlihat seperti
 * SELURUH baris berubah. Perbedaan gayanya tetap dicatat di `eol` supaya bisa ditampilkan terpisah.
 */
export function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], eol: "none", finalNewline: false };

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf; // enter polos (tanpa \r di depannya)
  const eol: Eol = crlf === 0 && lf === 0 ? "none" : crlf === 0 ? "lf" : lf === 0 ? "crlf" : "mixed";

  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  // Teks yang berakhir dengan enter menghasilkan satu elemen kosong di ujung. Itu bukan baris.
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

// ---- LANGKAH 3: algoritma Myers --------------------------------------------------------

const EQ = 0;
const DEL = 1;
const INS = 2;

/**
 * Mencari urutan hapus/tambah paling pendek untuk mengubah `a` menjadi `b` (algoritma Myers,
 * O(N·D) waktu, dengan D = jumlah baris yang berbeda). Mengembalikan undefined bila jarak edit
 * melebihi `maxD`, supaya waktu dan memori tetap terbatas.
 *
 * Tiap baris sudah diubah menjadi angka (Int32Array) agar perbandingannya cepat.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): number[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  // v[k] = titik terjauh di sumbu-x yang bisa dicapai pada diagonal k.
  const v = new Int32Array(2 * max + 3);
  // Salinan v di awal tiap putaran, dipakai untuk menelusuri jalannya kembali. Hanya bagian
  // [-d-1, d+1] yang disimpan, jadi totalnya sekitar D² angka, bukan N·D.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0; // turun: ada baris yang DITAMBAH
      } else {
        x = (v[offset + k - 1] ?? 0) + 1; // ke kanan: ada baris yang DIHAPUS
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return undefined; // terlalu banyak yang berbeda
}

// Menelusuri jalan dari ujung (n, m) kembali ke awal, mengumpulkan langkah-langkahnya.
function backtrack(trace: Int32Array[], n: number, m: number): number[] {
  const ops: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const prev = trace[d] as Int32Array;
    // prev[k + d + 1] = nilai v[k] di awal putaran d.
    const at = (k: number) => prev[k + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(EQ);
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? INS : DEL);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// ---- Hasil -----------------------------------------------------------------------------

export type TextDiffOptions = {
  contextLines?: number; // baris konteks di sekitar perubahan (bawaan 3)
  maxLines?: number; // batas baris yang dibandingkan setelah awal/akhir yang sama dibuang
  maxEditDistance?: number; // batas jumlah baris yang berbeda yang dicari secara teliti
};

export const DEFAULT_CONTEXT_LINES = 3;
export const DEFAULT_MAX_LINES = 20_000;
export const DEFAULT_MAX_EDIT_DISTANCE = 1000;

export type TextDiffResult =
  | { ok: true; hunks: DiffHunk[]; added: number; removed: number; format: DiffFormat }
  | {
      ok: false; // terlalu besar: hanya ringkasan
      oldLines: number;
      newLines: number;
      added: number; // perkiraan atas
      removed: number;
      format: DiffFormat;
    };

// Satu kelompok perubahan berurutan, dalam indeks baris (mulai dari 0) di teks lama dan baru.
type Block = { aStart: number; aEnd: number; bStart: number; bEnd: number };

/**
 * Menghitung diff dua teks. Tidak pernah melempar error.
 * Hasil `hunks` kosong bila isi barisnya sama (perbedaan format ada di `format`).
 */
export function diffText(oldText: string, newText: string, options: TextDiffOptions = {}): TextDiffResult {
  const context = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxD = options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE;

  const oldSplit = splitLines(oldText);
  const newSplit = splitLines(newText);
  const format: DiffFormat = {
    oldEol: oldSplit.eol,
    newEol: newSplit.eol,
    oldFinalNewline: oldSplit.finalNewline,
    newFinalNewline: newSplit.finalNewline,
  };
  const a = oldSplit.lines;
  const b = newSplit.lines;

  // Langkah 2: buang awal dan akhir yang sama. Untuk berkas besar dengan perubahan kecil, inilah
  // yang membuat semuanya murah: hanya bagian tengah yang perlu dibandingkan.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const tooLarge = (): TextDiffResult => ({
    ok: false,
    oldLines: a.length,
    newLines: b.length,
    added: bMid.length,
    removed: aMid.length,
    format,
  });

  if (aMid.length === 0 && bMid.length === 0) return { ok: true, hunks: [], added: 0, removed: 0, format };
  if (aMid.length + bMid.length > maxLines) return tooLarge();

  // Ubah tiap baris yang berbeda menjadi angka, supaya perbandingan di Myers cepat.
  const ids = new Map<string, number>();
  const toIds = (lines: string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });

  const ops = myers(toIds(aMid), toIds(bMid), maxD);
  if (!ops) return tooLarge();

  // Kelompokkan langkah yang berurutan menjadi blok perubahan (dalam indeks seluruh berkas).
  const blocks: Block[] = [];
  let ai = prefix;
  let bi = prefix;
  let current: Block | undefined;
  for (const op of ops) {
    if (op === EQ) {
      current = undefined;
      ai++;
      bi++;
      continue;
    }
    current ??= (blocks[blocks.push({ aStart: ai, aEnd: ai, bStart: bi, bEnd: bi }) - 1] as Block);
    if (op === DEL) {
      ai++;
      current.aEnd = ai;
    } else {
      bi++;
      current.bEnd = bi;
    }
  }

  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    removed += block.aEnd - block.aStart;
    added += block.bEnd - block.bStart;
  }
  return { ok: true, hunks: buildHunks(a, b, blocks, context), added, removed, format };
}

// ---- LANGKAH 4: menyusun hunk ----------------------------------------------------------

// Menggabungkan blok yang berdekatan (jarak ≤ 2 × konteks) menjadi satu hunk, lalu menambahkan
// baris konteks di depan, di antara, dan di belakang.
function buildHunks(a: string[], b: string[], blocks: Block[], context: number): DiffHunk[] {
  const groups: Block[][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    const previous = last?.at(-1);
    if (last && previous && block.aStart - previous.aEnd <= 2 * context) last.push(block);
    else groups.push([block]);
  }

  return groups.map((group, index): DiffHunk => {
    const first = group[0] as Block;
    const last = group.at(-1) as Block;
    const lead = Math.min(context, first.aStart); // konteks di depan
    const trail = Math.min(context, a.length - last.aEnd); // konteks di belakang

    const lines: DiffLine[] = [];
    // Baris tidak berubah: indeksnya sama panjang di teks lama dan baru, isinya sama.
    const pushContext = (aFrom: number, bFrom: number, count: number) => {
      for (let i = 0; i < count; i++) {
        lines.push({ type: "context", text: a[aFrom + i] as string, oldLine: aFrom + i + 1, newLine: bFrom + i + 1 });
      }
    };

    pushContext(first.aStart - lead, first.bStart - lead, lead);
    group.forEach((block, i) => {
      const previous = group[i - 1];
      if (previous) pushContext(previous.aEnd, previous.bEnd, block.aStart - previous.aEnd);
      for (let x = block.aStart; x < block.aEnd; x++) lines.push({ type: "remove", text: a[x] as string, oldLine: x + 1 });
      for (let y = block.bStart; y < block.bEnd; y++) lines.push({ type: "add", text: b[y] as string, newLine: y + 1 });
    });
    pushContext(last.aEnd, last.bEnd, trail);

    const oldLines = lines.filter((l) => l.type !== "add").length;
    const newLines = lines.filter((l) => l.type !== "remove").length;
    const oldFrom = first.aStart - lead; // indeks dari 0
    const newFrom = first.bStart - lead;
    return {
      id: `h${index + 1}`,
      // Kebiasaan unified diff: bila jumlah barisnya 0, nomornya baris SEBELUM titik itu.
      oldStart: oldLines > 0 ? oldFrom + 1 : oldFrom,
      oldLines,
      newStart: newLines > 0 ? newFrom + 1 : newFrom,
      newLines,
      lines,
    };
  });
}
