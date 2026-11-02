// Mencetak konfigurasi hook dari pembuat konfigurasi yang SEBENARNYA (packages/bridge),
// supaya eksperimen memakai persis yang nanti dipasang untuk pengguna.
// Pemakaian (dari folder packages/bridge):
//   pnpm exec tsx ../../tools/hook-spike/print-config.ts <port> <token> [timeoutDetik]
import { buildClaudeHookSettings } from "../../packages/bridge/src/hook-config";

const [port, token, timeout] = process.argv.slice(2);
const settings = buildClaudeHookSettings({
  port: Number(port),
  token: token ?? "",
  ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
});
process.stdout.write(JSON.stringify(settings, null, 2));
