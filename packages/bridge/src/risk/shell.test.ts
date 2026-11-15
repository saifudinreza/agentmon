// FILE INI: TEST pemecah perintah shell. Pemecah harus melihat perintah seperti shell melihatnya.
import { describe, expect, test } from "vitest";
import { lexShell } from "./shell";

const words = (command: string, shell: "bash" | "powershell" = "bash") => lexShell(command, shell).pipelines.map((p) => p.map((s) => s.words.map((w) => w.text)));

describe("lexShell: pemisah", () => {
  test("; && || & dan baris baru memulai perintah baru; | menyambung dalam satu rangkaian", () => {
    expect(words("a; b && c || d & e\nf")).toEqual([[["a"]], [["b"]], [["c"]], [["d"]], [["e"]], [["f"]]]);
    expect(words("a | b |& c")).toEqual([[["a"], ["b"], ["c"]]]);
  });
  test("kurung dan kurung kurawal membuka perintah baru", () => {
    expect(words("(a; b)")).toEqual([[["a"]], [["b"]]]);
  });
  test("pemisah di dalam kutip tidak memisahkan", () => {
    expect(words("echo 'a; b' \"c && d\"")).toEqual([[["echo", "a; b", "c && d"]]]);
  });
  test("garis miring terbalik sebelum ; menjadikannya biasa (find -exec ... \\;)", () => {
    expect(words("find . -exec rm {} \\;")).toEqual([[["find", ".", "-exec", "rm", "{}", ";"]]]);
  });
});

describe("lexShell: penyamaran kata", () => {
  test.each([
    ['r""m', "rm"],
    ["r''m", "rm"],
    ['"r"m', "rm"],
    ["'r'\"m\"", "rm"],
    ["$'\\x72\\x6d'", "rm"],
    ["$'\\162\\155'", "rm"],
    ["$'\\u0072m'", "rm"],
    ["rm${IFS}x", "rm"],
  ])("%s dibaca sebagai %s", (input, first) => {
    expect(words(input)[0]![0]![0]).toBe(first);
  });
  test("${IFS} menjadi spasi pemisah kata", () => {
    expect(words("rm${IFS}-rf${IFS}/")).toEqual([[["rm", "-rf", "/"]]]);
    expect(words("rm$IFS-rf$IFS/")).toEqual([[["rm", "-rf", "/"]]]);
  });
  test("garis miring terbalik dilepas seperti shell (teks = nilai sesungguhnya), bentuk mentahnya disimpan di raw untuk jalur Windows", () => {
    const [cat, path] = lexShell("cat C:\\proyek\\.env", "bash").pipelines[0]![0]!.words;
    expect(cat!.text).toBe("cat");
    expect(path!.text).toBe("C:proyek.env");
    expect(path!.raw).toBe("C:\\proyek\\.env");
    expect(words("\\rm")[0]![0]![0]).toBe("rm");
    expect(words(".e\\nv")[0]![0]![0]).toBe(".env");
    expect(words("'a'\\''b'")[0]![0]![0]).toBe("a'b");
  });
  test("komentar (#) sampai akhir baris tidak membuka string dan tidak dibaca sebagai perintah", () => {
    expect(words("ls #'\nrm -rf x\n#'")).toEqual([[["ls"]], [["rm", "-rf", "x"]]]);
    expect(words("echo a#b")).toEqual([[["echo", "a#b"]]]);
    expect(words("echo $#")).toEqual([[["echo", "$#"]]]);
    expect(words("ls <# blok ' #> -la", "powershell")).toEqual([[["ls", "-la"]]]);
  });
  test("$(( ... )) tetap mengeluarkan substitusi di dalamnya", () => {
    expect(lexShell("echo $(( $(rm -rf ~) + 1 ))", "bash").substitutions).toEqual(["rm -rf ~"]);
    expect(lexShell("echo $((1+2))", "bash").substitutions).toEqual([]);
  });
  test("heredoc tanpa kutip pada delimiter mengeluarkan substitusi di isinya; yang berkutip tidak", () => {
    expect(lexShell("cat <<EOF\n$(a)\nEOF", "bash").substitutions).toEqual(["a"]);
    expect(lexShell("cat <<'EOF'\n$(a)\nEOF", "bash").substitutions).toEqual([]);
  });
  test(">&berkas menulis berkas, 2>&1 tidak", () => {
    expect(lexShell("ls >&out", "bash").pipelines[0]![0]!.redirects[0]?.target?.text).toBe("out");
    expect(lexShell("ls 2>&1", "bash").pipelines[0]![0]!.redirects).toEqual([]);
  });
  test("PowerShell: tanda kutip balik adalah escape, garis miring terbalik adalah jalur", () => {
    expect(words("r`m C:\\x\\.env", "powershell")).toEqual([[["rm", "C:\\x\\.env"]]]);
  });
  test("variabel menandai kata sebagai dinamis; kutip tunggal tidak", () => {
    const lexed = lexShell("echo $HOME '$HOME' \"$HOME\"", "bash").pipelines[0]![0]!.words;
    expect(lexed.map((w) => w.dynamic)).toEqual([false, true, false, true]);
  });
});

describe("lexShell: substitusi", () => {
  test("$(...), tanda kutip balik, dan <(...) dikeluarkan sebagai perintah tersendiri", () => {
    expect(lexShell("echo $(rm -rf x)", "bash").substitutions).toEqual(["rm -rf x"]);
    expect(lexShell("echo `rm -rf x`", "bash").substitutions).toEqual(["rm -rf x"]);
    expect(lexShell("bash <(curl x)", "bash").substitutions).toEqual(["curl x"]);
    expect(lexShell('echo "a $(b $(c)) d"', "bash").substitutions).toEqual(["b $(c)"]);
  });
  test("$(( aritmetika )) bukan perintah", () => {
    expect(lexShell("echo $((1+2))", "bash").substitutions).toEqual([]);
  });
  test("kutip atau substitusi yang tidak ditutup ditandai tidak seimbang", () => {
    for (const bad of ["echo 'a", 'echo "a', "echo $(a", "echo `a", "echo <(a"]) expect(lexShell(bad, "bash").unbalanced, bad).toBe(true);
    expect(lexShell("echo 'a' \"b\" $(c)", "bash").unbalanced).toBe(false);
  });
});

describe("lexShell: pengalihan dan heredoc", () => {
  test("pengalihan menyimpan target dan nomor deskriptor tidak menjadi argumen", () => {
    const stage = lexShell("echo x 2> err.txt > out.txt >> log.txt < in.txt", "bash").pipelines[0]![0]!;
    expect(stage.words.map((w) => w.text)).toEqual(["echo", "x"]);
    expect(stage.redirects.map((r) => [r.op, r.target?.text])).toEqual([["2>".slice(1), "err.txt"], [">", "out.txt"], [">>", "log.txt"], ["<", "in.txt"]]);
  });
  test("2>&1 menyalin deskriptor, bukan menulis berkas", () => {
    const stage = lexShell("ls 2>&1", "bash").pipelines[0]![0]!;
    expect(stage.redirects).toEqual([]);
    expect(stage.words.map((w) => w.text)).toEqual(["ls"]);
  });
  test("&> menulis berkas", () => {
    expect(lexShell("ls &> out", "bash").pipelines[0]![0]!.redirects[0]?.target?.text).toBe("out");
  });
  test("heredoc: isi blok menempel pada perintahnya dan tidak dibaca sebagai perintah", () => {
    const lexed = lexShell("cat <<EOF\nrm -rf /\nEOF\nls", "bash");
    expect(lexed.pipelines[0]![0]!.heredoc).toBe("rm -rf /");
    expect(lexed.pipelines[0]![0]!.words.map((w) => w.text)).toEqual(["cat"]);
    expect(lexed.pipelines[1]![0]!.words.map((w) => w.text)).toEqual(["ls"]);
    expect(lexed.unbalanced).toBe(false);
  });
  test("heredoc tanpa penutup ditandai tidak seimbang", () => {
    expect(lexShell("cat <<EOF\nabc", "bash").unbalanced).toBe(true);
  });
});

describe("lexShell: ketahanan", () => {
  test("tidak melempar untuk masukan apa pun dan memotong masukan yang terlalu panjang", () => {
    for (const input of ["", " ", "\u0000", "'", '"', "$", "$(", "`", "\\", "<<", "<<<", ">", "&", "|", ";", "$'", "$'\\", "$\"", "<(", "((", "))"]) {
      expect(() => lexShell(input, "bash"), JSON.stringify(input)).not.toThrow();
      expect(() => lexShell(input, "powershell"), JSON.stringify(input)).not.toThrow();
    }
    const started = performance.now();
    lexShell("a ".repeat(500_000), "bash");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
