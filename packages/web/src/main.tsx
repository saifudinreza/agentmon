// Pintu masuk aplikasi: memasang React ke <div id="root"> dan mendaftarkan service worker.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { initE2eIfPresent } from "./e2e/runtime";
import { VaultBroken } from "./e2e/VaultBroken";
import { I18nProvider } from "./i18n/react";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Elemen #root tidak ditemukan di index.html");

// Brankas kunci E2E dibuka DULU (dan libsodium dimuat bila ada isinya), supaya event pertama pun lewat gerbang. Brankas yang rusak tidak
// disembunyikan atau dikosongkan: layar menjelaskannya.
async function boot(container: HTMLElement) {
  let broken = false;
  try {
    await initE2eIfPresent();
  } catch {
    broken = true;
  }
  createRoot(container).render(
    <StrictMode>
      <I18nProvider>{broken ? <VaultBroken /> : <App />}</I18nProvider>
    </StrictMode>,
  );
}
void boot(root);

// Service worker = penjaga yang menyimpan berkas aplikasi di HP supaya terbuka saat offline.
// Hanya di build produksi: di mode pengembangan ia menyimpan berkas lama dan membingungkan.
if (import.meta.env.PROD) registerSW({ immediate: true });
