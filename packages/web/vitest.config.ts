// Konfigurasi test terpisah dari vite.config.ts: test tidak perlu plugin PWA (service worker, manifest).
// `jsdom` menyediakan DOM tiruan di Node supaya komponen React bisa dirender dan diuji.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // WebSocket diganti soket mati supaya test tidak menghubungi jaringan (lihat src/setup-tests.ts).
    setupFiles: ["./src/setup-tests.ts"],
    // Setiap test mendapat localStorage dan DOM yang bersih.
    restoreMocks: true,
  },
});
