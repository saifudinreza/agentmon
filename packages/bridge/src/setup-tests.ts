// Dijalankan sebelum setiap berkas test di paket bridge.
//
// MASALAHNYA: daemon dan CLI menyimpan datanya (token, machine-id, relay.json) di folder data pengguna (~/.agentmon,
// atau AGENTMON_HOME). Test yang tidak menyebut folder datanya sendiri akan MEMBACA milik pengguna sungguhan di laptop
// pengembang. Itu terjadi sungguhan: begitu laptop didaftarkan ke relay (relay.json ada), sebuah test "tanpa pengaturan
// relay" gagal di laptop itu padahal lulus di CI. Test yang bergantung pada isi laptop siapa pun tidak bisa dipercaya.
//
// SOLUSINYA: setiap proses test mendapat folder data sementara yang KOSONG, lewat AGENTMON_HOME. Test yang butuh folder
// tertentu tetap menyebutnya sendiri (itu yang menang). Variabel relay dari lingkungan pengembang juga dibuang.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agentmon-test-home-"));
process.env.AGENTMON_HOME = home;
for (const name of ["AGENTMON_RELAY_URL", "AGENTMON_RELAY_TOKEN", "AGENTMON_ADMIN_SECRET", "AGENTMON_RELAY_INSECURE", "AGENTMON_APP_URL"]) {
  delete process.env[name];
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
