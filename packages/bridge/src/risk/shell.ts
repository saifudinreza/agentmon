// =====================================================================================
// FILE INI: pemecah perintah shell = "PEMBACA KALIMAT" untuk penilai risiko.
// =====================================================================================
//
// Penilai risiko tidak boleh menebak dari teks mentah: `r""m -rf /`, `\rm -rf /`, `$'\x72\x6d' -rf /`, atau
// `rm${IFS}-rf${IFS}/` semuanya adalah `rm -rf /` bagi shell. Maka perintah dipecah dulu seperti shell memecahnya:
// kutip dan garis miring terbalik dilepas, `;` `&&` `||` `|` memisahkan perintah, dan `$(...)`, tanda kutip balik, serta
// `<(...)` dikeluarkan sebagai perintah tersendiri untuk dinilai juga.
//
// Ini BUKAN shell yang lengkap, dan tidak berpura-pura. Yang tidak bisa dipastikan nilainya ($variabel, substitusi,
// kutip yang tidak ditutup) ditandai `dynamic`/`unbalanced`, supaya penilai memperlakukannya sebagai tidak bisa dinilai
// (tidak pernah "rendah"), bukan menebak.
//
// Fungsi ini murni: tidak membaca berkas, tidak menjalankan apa pun, dan tidak pernah melempar galat.

export type ShellKind = "bash" | "powershell";

/**
 * Satu kata setelah kutip dan escape dilepas, seperti shell melepasnya (`\rm` menjadi `rm`, `.e\nv` menjadi `.env`).
 * `raw` = bentuk sebelum escape dilepas, hanya ada bila berbeda; dipakai untuk jalur gaya Windows di Bash (C:\proyek\.env).
 * `dynamic` = berisi ekspansi ($var, $(..), tanda kutip balik) yang nilainya tidak diketahui.
 */
export type Word = { text: string; dynamic: boolean; raw?: string };
export type Redirect = { op: string; target?: Word };
/** Satu perintah dalam rangkaian pipa. `heredoc` = isi blok <<EOF yang menempel padanya. */
export type Stage = { words: Word[]; redirects: Redirect[]; heredoc?: string };
/** Rangkaian perintah yang dihubungkan `|`. Pemisah `;` `&&` `||` `&` dan baris baru memulai rangkaian baru. */
export type Pipeline = Stage[];
export type Lexed = {
  pipelines: Pipeline[];
  /** Isi `$(...)`, tanda kutip balik, dan `<(...)`: perintah yang ikut berjalan dan harus dinilai juga. */
  substitutions: string[];
  /** Kutip atau kurung tidak ditutup: shell sungguhan akan menunggu masukan atau gagal, jadi tidak bisa dinilai pasti. */
  unbalanced: boolean;
};

const MAX_LENGTH = 400_000;

// ${IFS} dan $IFS dipakai untuk menyelipkan spasi tanpa mengetik spasi: rm${IFS}-rf${IFS}/
const IFS = /\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g;

const BRACE_EXPANSION = /^\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/;
const SMART_SINGLE = new RegExp(`[${[0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c)).join("")}]`, "g");
const SMART_DOUBLE = new RegExp(`[${[0x201c, 0x201d, 0x201e].map((c) => String.fromCharCode(c)).join("")}]`, "g");

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Mengurai isi $'...' (kutip gaya ANSI-C): \xNN, \NNN (oktal), \uNNNN, dan escape umum. */
function decodeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\" || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const n = body[i + 1]!;
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(body.slice(i + 1));
    const uni = /^u([0-9a-fA-F]{1,4})/.exec(body.slice(i + 1));
    const oct = /^([0-7]{1,3})/.exec(body.slice(i + 1));
    if (hex) {
      out += String.fromCharCode(parseInt(hex[1]!, 16));
      i += hex[0].length;
    } else if (uni) {
      out += String.fromCharCode(parseInt(uni[1]!, 16));
      i += uni[0].length;
    } else if (oct) {
      out += String.fromCharCode(parseInt(oct[1]!, 8) & 0xff);
      i += oct[0].length;
    } else if (n in ANSI_ESCAPES) {
      out += ANSI_ESCAPES[n]!;
      i += 1;
    } else {
      out += `\\${n}`;
      i += 1;
    }
  }
  return out;
}

/** Mengeluarkan isi $(...), $((...)) bersarang, dan tanda kutip balik dari teks (isi heredoc, aritmetika). */
function extractSubstitutions(text: string, shell: ShellKind, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i += 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close < 0) {
        out.push(text.slice(i + 2));
        break;
      }
      if (text[i + 2] === "(" && text[close - 1] === ")") out.push(...extractSubstitutions(text.slice(i + 3, close - 1), shell, depth + 1));
      else out.push(text.slice(i + 2, close));
      i = close;
    } else if (c === "`" && shell === "bash") {
      const close = text.indexOf("`", i + 1);
      out.push(text.slice(i + 1, close < 0 ? text.length : close));
      if (close < 0) break;
      i = close;
    }
  }
  return out;
}

/** Mencari tanda kurung penutup yang cocok (mulai dari `from`, tepat setelah kurung buka). -1 bila tidak ada. */
function findClosingParen(input: string, from: number): number {
  let depth = 1;
  for (let i = from; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\") i += 1;
    else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      for (i += 1; i < input.length && input[i] !== '"'; i++) if (input[i] === "\\") i += 1;
    } else if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

export function lexShell(raw: string, shell: ShellKind): Lexed {
  const text = raw.length > MAX_LENGTH ? raw.slice(0, MAX_LENGTH) : raw;
  let input = text.replace(IFS, " ");
  // PowerShell memperlakukan kutip "pintar" (‘ ’ ‚ ‛ dan “ ” „) sama dengan kutip biasa. Tanpa ini, kutip tak dikenal
  // menyembunyikan pemisah perintah di dalam apa yang tampak seperti string.
  if (shell === "powershell") input = input.replace(SMART_SINGLE, "'").replace(SMART_DOUBLE, '"');
  const pipelines: Pipeline[] = [];
  const substitutions: string[] = [];
  let unbalanced = false;

  let stages: Stage[] = [];
  let stage: Stage = { words: [], redirects: [] };
  let word: string | undefined; // undefined = tidak ada kata yang sedang dibaca ('' = kata kosong dari kutip kosong)
  let rawWord = ""; // bentuk kata sebelum escape tanpa kutip dilepas
  let dynamic = false;
  let pendingRedirect: Redirect | undefined;
  let pendingHeredoc: { delimiter: string; stage: Stage; strip: boolean; quoted: boolean } | undefined;

  const append = (s: string) => {
    word = (word ?? "") + s;
    rawWord += s;
  };
  const endWord = () => {
    if (word === undefined) return;
    const finished: Word = { text: word, dynamic, ...(rawWord !== word ? { raw: rawWord } : {}) };
    rawWord = "";
    if (pendingRedirect) {
      stage.redirects.push({ ...pendingRedirect, target: finished });
      pendingRedirect = undefined;
    } else {
      stage.words.push(finished);
    }
    word = undefined;
    dynamic = false;
  };
  const endStage = () => {
    endWord();
    pendingRedirect = undefined;
    if (stage.words.length > 0 || stage.redirects.length > 0) stages.push(stage);
    stage = { words: [], redirects: [] };
  };
  const endPipeline = () => {
    endStage();
    if (stages.length > 0) pipelines.push(stages);
    stages = [];
  };
  const substitute = (inner: string) => {
    substitutions.push(inner);
    dynamic = true;
    word = word ?? "";
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];

    if (c === "\r" && next !== "\n") {
      // \r yang bukan bagian dari \r\n: PowerShell menganggapnya pemisah pernyataan, sedangkan Git Bash (MSYS) membuangnya
      // di tengah kata ("ec\rho" = "echo"). Keduanya tidak bisa dipastikan, jadi perintah ditandai tidak pasti.
      unbalanced = true;
      if (shell === "powershell") endPipeline();
      else endWord();
      i += 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
    } else if (c === "\n") {
      endPipeline();
      i += 1;
      if (pendingHeredoc) {
        const { delimiter, stage: owner, strip, quoted } = pendingHeredoc;
        pendingHeredoc = undefined;
        const lines: string[] = [];
        let closed = false;
        while (i < input.length) {
          let end = input.indexOf("\n", i);
          if (end < 0) end = input.length;
          const line = input.slice(i, end);
          i = Math.min(end + 1, input.length);
          if ((strip ? line.trim() : line.replace(/\r$/, "")) === delimiter) {
            closed = true;
            break;
          }
          lines.push(line);
        }
        if (!closed) unbalanced = true;
        owner.heredoc = lines.join("\n");
        // Isi heredoc tanpa kutip pada delimiternya DIEKSPANSI shell: $(...) dan `...` di dalamnya ikut berjalan.
        if (!quoted) substitutions.push(...extractSubstitutions(owner.heredoc, shell));
      }
    } else if (c === "#" && word === undefined) {
      // Komentar: sampai akhir baris. Tanda kutip di dalamnya tidak boleh dibaca sebagai pembuka string.
      // PowerShell mengakhiri komentar juga di \r yang berdiri sendiri (itu pemisah pernyataan di sana).
      const end = shell === "powershell" ? input.slice(i).search(/[\r\n]/) : input.indexOf("\n", i) - i;
      i = end < 0 ? input.length : i + end;
    } else if (shell === "powershell" && c === "<" && next === "#") {
      const end = input.indexOf("#>", i + 2);
      if (end < 0) unbalanced = true;
      i = end < 0 ? input.length : end + 2;
      endWord();
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) {
        unbalanced = true;
        append(input.slice(i + 1));
        i = input.length;
      } else {
        append(input.slice(i + 1, end));
        i = end + 1;
      }
      word = word ?? "";
    } else if (c === '"' || (c === "$" && next === '"')) {
      let j = i + (c === "$" ? 2 : 1);
      word = word ?? "";
      let closed = false;
      while (j < input.length) {
        const ch = input[j]!;
        if (ch === '"') {
          closed = true;
          break;
        }
        if (shell === "powershell" && ch === "`" && j + 1 < input.length) {
          append(input[j + 1]!);
          j += 2;
        } else if (shell === "bash" && ch === "\\" && j + 1 < input.length) {
          const escaped = input[j + 1]!;
          if (escaped === "\n") j += 2;
          else {
            append('"\\$`'.includes(escaped) ? (escaped === "\\" ? "\\\\" : escaped) : `\\${escaped}`);
            j += 2;
          }
        } else if (ch === "$" && input[j + 1] === "(") {
          const close = findClosingParen(input, j + 2);
          if (close < 0) {
            unbalanced = true;
            substitute(input.slice(j + 2));
            j = input.length;
          } else {
            substitute(input.slice(j + 2, close));
            j = close + 1;
          }
        } else if (ch === "`" && shell === "bash") {
          const close = input.indexOf("`", j + 1);
          if (close < 0) {
            unbalanced = true;
            substitute(input.slice(j + 1));
            j = input.length;
          } else {
            substitute(input.slice(j + 1, close));
            j = close + 1;
          }
        } else {
          if (ch === "$") dynamic = true;
          append(ch);
          j += 1;
        }
      }
      if (!closed) unbalanced = true;
      i = Math.min(j + 1, input.length);
    } else if (c === "$" && next === "'" && shell === "bash") {
      const end = (() => {
        for (let j = i + 2; j < input.length; j++) {
          if (input[j] === "\\") j += 1;
          else if (input[j] === "'") return j;
        }
        return -1;
      })();
      if (end < 0) {
        unbalanced = true;
        append(decodeAnsiC(input.slice(i + 2)));
        i = input.length;
      } else {
        append(decodeAnsiC(input.slice(i + 2, end)));
        i = end + 1;
      }
      word = word ?? "";
    } else if (c === "$" && next === "(") {
      if (input[i + 2] === "(") {
        // $(( aritmetika )): bukan perintah, tetapi $(...) dan `...` DI DALAMNYA tetap dijalankan shell.
        const close = findClosingParen(input, i + 2);
        dynamic = true;
        word = word ?? "";
        if (close < 0) {
          unbalanced = true;
          substitutions.push(...extractSubstitutions(input.slice(i + 3), shell));
          i = input.length;
        } else {
          substitutions.push(...extractSubstitutions(input.slice(i + 3, close - 1), shell));
          i = close + 1;
        }
      } else {
        const close = findClosingParen(input, i + 2);
        if (close < 0) {
          unbalanced = true;
          substitute(input.slice(i + 2));
          i = input.length;
        } else {
          substitute(input.slice(i + 2, close));
          i = close + 1;
        }
      }
    } else if (c === "`") {
      if (shell === "powershell") {
        // Di PowerShell tanda kutip balik adalah escape: lepaskan, huruf berikutnya apa adanya.
        if (next === "\n") i += 2;
        else if (next !== undefined) {
          append(next);
          i += 2;
        } else i += 1;
        word = word ?? "";
      } else {
        const close = input.indexOf("`", i + 1);
        if (close < 0) {
          unbalanced = true;
          substitute(input.slice(i + 1));
          i = input.length;
        } else {
          substitute(input.slice(i + 1, close));
          i = close + 1;
        }
      }
    } else if (c === "\\" && shell === "bash") {
      // Garis miring terbalik: karakter berikutnya literal (jadi `\;` BUKAN pemisah). Garis miringnya dipertahankan di
      // teks supaya jalur gaya Windows (C:\proyek\.env) tetap terbaca; nama perintah dibersihkan terpisah.
      if (next === "\n") i += 2;
      else if (next === undefined) i += 1;
      else {
        // Teks kata memakai nilai SESUNGGUHNYA (garis miring dilepas seperti shell: \rm = rm, .e\nv = .env, '\'' = '),
        // sedangkan `raw` mempertahankan garis miringnya untuk jalur gaya Windows (C:\proyek\.env) di Bash.
        word = (word ?? "") + next;
        rawWord += /[A-Za-z0-9._\-/]/.test(next) ? `\\${next}` : next;
        i += 2;
      }
      word = word ?? "";
    } else if ((c === "<" || c === ">") && next === "(") {
      const close = findClosingParen(input, i + 2);
      if (close < 0) {
        unbalanced = true;
        substitute(input.slice(i + 2));
        i = input.length;
      } else {
        substitute(input.slice(i + 2, close));
        i = close + 1;
      }
    } else if (c === ";") {
      endPipeline();
      i += 1;
    } else if (c === "&") {
      if (next === "&") {
        endPipeline();
        i += 2;
      } else if (next === ">") {
        // &> berkas (alihkan stdout dan stderr)
        endWord();
        const op = input[i + 2] === ">" ? "&>>" : "&>";
        pendingRedirect = { op };
        i += op.length;
      } else {
        endPipeline(); // & = jalankan di latar, perintah berikutnya mandiri
        i += 1;
      }
    } else if (c === "|") {
      if (next === "|") {
        endPipeline();
        i += 2;
      } else {
        endStage();
        i += next === "&" ? 2 : 1;
      }
    } else if (c === "(" || c === ")" || (shell === "powershell" && (c === "{" || c === "}"))) {
      // Di PowerShell { } adalah scriptblock: isinya BERJALAN (mis. -Path { ... } dievaluasi per objek). Isinya dinilai
      // sebagai perintah tersendiri, dan keseluruhannya ditandai tidak pasti.
      if (c === "{" || c === "}") unbalanced = true;
      endPipeline();
      i += 1;
    } else if (c === ">" || c === "<") {
      // Angka tepat sebelum > atau < adalah nomor deskriptor (2>), bukan argumen.
      if (word !== undefined && /^\d+$/.test(word)) {
        word = undefined;
        rawWord = "";
      }
      endWord();
      if (c === "<" && next === "<" && input[i + 2] === "<") {
        pendingRedirect = { op: "<<<" };
        i += 3;
      } else if (c === "<" && next === "<") {
        // <<DELIM atau <<-DELIM: bacaan isi blok menyusul di baris baru.
        let j = i + 2;
        const strip = input[j] === "-";
        if (strip) j += 1;
        while (input[j] === " " || input[j] === "\t") j += 1;
        let delimiter = "";
        let quoted = false;
        while (j < input.length && !/[\s;&|()<>]/.test(input[j]!)) {
          if (input[j] !== "'" && input[j] !== '"' && input[j] !== "\\") delimiter += input[j];
          else quoted = true;
          j += 1;
        }
        pendingHeredoc = { delimiter, stage, strip, quoted };
        i = j;
      } else {
        let op = c;
        let j = i + 1;
        if (c === ">" && next === ">") {
          op = ">>";
          j += 1;
        } else if (c === ">" && next === "|") {
          op = ">|";
          j += 1;
        }
        if (input[j] === "&" && (c === ">" || c === "<") && /[0-9-]/.test(input[j + 1] ?? "")) {
          // 2>&1 dan sejenisnya: menyalin deskriptor, bukan menulis berkas.
          j += 2;
          i = j;
          continue;
        }
        if (input[j] === "&" && c === ">") {
          // >&berkas: sama dengan > berkas (menulis stdout dan stderr ke berkas).
          op = ">&";
          j += 1;
        }
        pendingRedirect = { op };
        i = j;
      }
    } else {
      if (c === "$") dynamic = true;
      // Ekspansi kurung kurawal bash ({a,b} atau {1..3}) membentuk kata saat dijalankan: nilainya tidak bisa dilihat dulu.
      if (c === "{" && shell === "bash" && BRACE_EXPANSION.test(input.slice(i, i + 400))) dynamic = true;
      append(c);
      i += 1;
    }
  }
  endPipeline();
  return { pipelines, substitutions, unbalanced };
}
