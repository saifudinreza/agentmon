// Menebak bahasa dari nama berkas. Dipisah dari highlight.ts supaya penampil diff cukup memuat ini (kecil) dan
// pewarna sintaks yang lebih besar baru dimuat belakangan, setelah diff tampil sebagai teks biasa.
export type Language = "js" | "python" | "css" | "json" | "shell" | "plain";

/** Menebak bahasa dari akhiran nama berkas. */
export function languageOf(path: string): Language {
  const name = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "java", "go", "rs", "c", "h", "cpp", "cs", "swift", "kt"].includes(ext)) return "js";
  if (ext === "py") return "python";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (ext === "json" || ext === "jsonc") return "json";
  if (["sh", "bash", "zsh"].includes(ext) || name === "dockerfile") return "shell";
  return "plain";
}
