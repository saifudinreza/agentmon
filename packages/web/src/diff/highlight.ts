// =====================================================================================
// FILE INI: pewarna sintaks ringan = "STABILO" untuk baris kode di diff.
// =====================================================================================
//
// Sengaja kecil dan tanpa dependensi: satu baris dipecah menjadi potongan (kata kunci, teks, angka, komentar) yang
// diberi warna. Modul ini dimuat BELAKANGAN (dynamic import) setelah diff tampil sebagai teks biasa, jadi diff tetap
// terbaca sebelum warna siap dan app awal tidak membengkak.
//
// Batas yang disadari: baris diproses sendiri-sendiri tanpa ingatan antar baris, jadi komentar atau teks yang
// membentang beberapa baris tidak diwarnai utuh. Ini alat bantu baca, bukan penguraian bahasa yang lengkap, dan
// warna TIDAK PERNAH dipakai untuk keputusan keamanan (yang menentukan adalah isi diff).
export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number";
import type { Language } from "./language";

export type Token = { text: string; kind: TokenKind };

const KEYWORDS: Record<Exclude<Language, "plain" | "css">, ReadonlySet<string>> = {
  js: new Set(
    "abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield".split(" "),
  ),
  python: new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ")),
  json: new Set(["true", "false", "null"]),
  shell: new Set("if then else elif fi for while do done case esac function in return export local echo cd rm mv cp".split(" ")),
};

// Baris yang sangat panjang (mis. berkas minified) tidak diwarnai: biayanya besar dan manfaatnya kecil.
const MAX_LINE_CHARS = 2000;

// Pola per bahasa, dicoba berurutan pada posisi sekarang (sticky). Yang pertama cocok menang.
const PATTERNS: Record<Exclude<Language, "plain">, Array<{ kind: TokenKind; re: RegExp }>> = {
  js: [
    { kind: "comment", re: /\/\/.*|\/\*.*?(?:\*\/|$)/y },
    { kind: "string", re: /"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|`(?:[^`\\]|\\.)*(?:`|$)/y },
    { kind: "number", re: /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y },
  ],
  python: [
    { kind: "comment", re: /#.*/y },
    { kind: "string", re: /"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)/y },
    { kind: "number", re: /\b\d[\d_]*(?:\.\d+)?\b/y },
  ],
  css: [
    { kind: "comment", re: /\/\*.*?(?:\*\/|$)/y },
    { kind: "string", re: /"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)/y },
    { kind: "number", re: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b/y },
  ],
  json: [
    { kind: "string", re: /"(?:[^"\\]|\\.)*(?:"|$)/y },
    { kind: "number", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
  ],
  shell: [
    { kind: "comment", re: /#.*/y },
    { kind: "string", re: /"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)/y },
    { kind: "number", re: /\b\d+\b/y },
  ],
};

const WORD = /[A-Za-z_$][\w$]*/y;

/** Memecah satu baris menjadi potongan berwarna. Hasil bila digabung SELALU sama persis dengan teks masukan. */
export function tokenizeLine(text: string, language: Language): Token[] {
  if (language === "plain" || text.length === 0 || text.length > MAX_LINE_CHARS) return [{ text, kind: "plain" }];
  const patterns = PATTERNS[language];
  const keywords = language === "css" ? undefined : KEYWORDS[language];
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ text: plain, kind: "plain" });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const { kind, re } of patterns) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0].length > 0) {
        flush();
        tokens.push({ text: m[0], kind });
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    if (word) {
      if (keywords?.has(word[0])) {
        flush();
        tokens.push({ text: word[0], kind: "keyword" });
      } else plain += word[0];
      i += word[0].length;
      continue;
    }
    plain += text[i];
    i++;
  }
  flush();
  return tokens;
}
