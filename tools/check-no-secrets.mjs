/* global console, process */
// Pemeriksa sederhana: memastikan tidak ada rahasia yang masuk repo. Memindai berkas yang DILACAK git.
// Bukan pengganti pemindai penuh, tetapi menangkap kesalahan yang paling umum: alamat database berkata sandi,
// kunci pribadi, token layanan yang terkenal, dan berkas .env yang terlanjur dilacak. Riwayat commit TIDAK dipindai.
// Dijalankan di CI (pnpm check:secrets).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const SKIP = /(^|\/)(pnpm-lock\.yaml|.*\.(png|ico|jpg|jpeg|gif|woff2?|webp))$|^tools\/check-no-secrets\.mjs$/;

// Alamat database yang aman: tempat contoh atau komputer lokal. Dicocokkan sampai batas kata (titik dua, garis
// miring, tanda tanya, atau akhir), supaya host asli seperti "example-db.neon.tech" tidak lolos hanya karena
// diawali kata contoh.
const SAFE_HOST = /@(127\.0\.0\.1|localhost|h\d?|host|contoh|example|[\w-]+\.example)(?=[:/?]|$)/i;
const RULES = [
  { name: "kunci pribadi", test: (t) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) },
  { name: "token GitHub", test: (t) => /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(t) },
  { name: "kunci AWS", test: (t) => /\bAKIA[0-9A-Z]{16}\b/.test(t) },
  {
    name: "alamat database dengan kata sandi",
    test: (t) => [...t.matchAll(/postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@[^\s'"`]+/gi)].some((m) => !SAFE_HOST.test(m[0])),
  },
];

let problems = 0;

// Berkas lingkungan asli tidak boleh dilacak git (hanya .env.example).
for (const file of files) {
  const base = file.split("/").pop() ?? "";
  if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") {
    console.error(`Berkas lingkungan dilacak git: ${file}`);
    problems++;
  }
}

for (const file of files) {
  if (SKIP.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of RULES) {
    if (rule.test(text)) {
      console.error(`Kemungkinan rahasia (${rule.name}) di ${file}`);
      problems++;
    }
  }
}
if (problems > 0) {
  console.error(`\n${problems} temuan. Pindahkan rahasia ke variabel lingkungan/dashboard hosting, bukan repo.`);
  process.exit(1);
}
console.log(`OK: tidak ada rahasia yang dikenali di ${files.length} berkas yang dilacak.`);
