/* global console, process, fetch, AbortSignal, setTimeout */
// Mengukur berapa lama relay "bangun" dari tidur (free tier Render tidur saat idle).
//
// Pemakaian:
//   node tools/measure-wake.mjs https://relay-anda.onrender.com [jeda-menit]
//
// Tanpa jeda: sekali ukur sekarang. Dengan jeda (mis. 20): mengukur, menunggu sejumlah menit (relay tidur),
// lalu mengukur lagi, terus berulang sampai dihentikan (Ctrl+C). Cetak satu baris per ukuran, siap ditempel
// ke docs/deploy.md.
const [url, pauseText] = process.argv.slice(2);
if (!url) {
  console.error("Pemakaian: node tools/measure-wake.mjs <alamat-relay> [jeda-menit]");
  process.exit(2);
}
const pauseMs = pauseText ? Number(pauseText) * 60_000 : 0;
if (pauseText && !(pauseMs > 0)) {
  console.error("jeda-menit harus angka positif");
  process.exit(2);
}
const target = `${url.replace(/\/+$/, "")}/health`;

async function measure() {
  const started = Date.now();
  const deadline = started + 120_000;
  // Selama bangun, host biasanya menjawab 502/503 atau menahan koneksi; ulangi sampai /health menjawab 200.
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) return { ok: true, ms: Date.now() - started };
    } catch {
      // belum siap
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, ms: Date.now() - started };
}

do {
  const result = await measure();
  console.log(`${new Date().toISOString()}  ${result.ok ? "siap dalam" : "TIDAK siap setelah"} ${(result.ms / 1000).toFixed(1)} detik`);
  if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
} while (pauseMs > 0);
