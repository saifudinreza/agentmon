// Pintu masuk aplikasi: memasang React ke <div id="root"> dan mendaftarkan service worker.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { I18nProvider } from "./i18n/react";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Elemen #root tidak ditemukan di index.html");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

// Service worker = penjaga yang menyimpan berkas aplikasi di HP supaya terbuka saat offline.
// Hanya di build produksi: di mode pengembangan ia menyimpan berkas lama dan membingungkan.
if (import.meta.env.PROD) registerSW({ immediate: true });
