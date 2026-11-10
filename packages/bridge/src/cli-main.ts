// Pintu masuk perintah dari terminal: `pnpm --filter @agentmon/bridge cli status`.
// Perintah `agentmon` yang rapi (setup, uninstall, dan seterusnya) dibuat di issue berikutnya.
// Logikanya ada di cli.ts supaya bisa dites.
import { runCli } from "./cli";

void runCli(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}).then((code) => {
  process.exitCode = code;
});
