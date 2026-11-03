// Mencetak konfigurasi hook dari pembuat konfigurasi yang SEBENARNYA (packages/bridge),
// supaya eksperimen memakai persis yang nanti dipasang untuk pengguna.
// Pemakaian (dari folder packages/bridge):
//   pnpm exec tsx ../../tools/hook-spike/print-config.ts <port> <token> [timeoutDetik]
import { buildClaudeHookSettings } from "../../packages/bridge/src/hook-config";

const [port, token, timeout] = process.argv.slice(2);
const settings = buildClaudeHookSettings({
  port: Number(port),
  token: token ?? "",
  // Batas yang diberikan dipakai untuk SEMUA event, supaya skenario "jawaban lambat"
  // tidak menunggu 10 detik per event pengamatan.
  ...(timeout ? { timeoutSeconds: Number(timeout), observeTimeoutSeconds: Number(timeout) } : {}),
});
process.stdout.write(JSON.stringify(settings, null, 2));
