// =====================================================================================
// FILE INI: service worker = "PENJAGA" yang hidup di latar belakang HP, walau aplikasi tertutup.
// =====================================================================================
//
// Tiga tugas:
//   1. Menyimpan berkas aplikasi (precache) supaya terbuka tanpa jaringan, dan menjawab navigasi ke alamat mana
//      pun dengan kerangka aplikasi. Perilakunya sama dengan service worker bawaan yang dibuat vite-plugin-pwa
//      sebelumnya; yang berbeda hanya kita yang menulisnya, supaya bisa menambah tugas 2 dan 3.
//   2. Menampilkan notifikasi saat push tiba (SELALU menampilkan sesuatu; lihat push/notification.ts).
//   3. Membuka layar yang tepat saat notifikasi diketuk (push/sw-logic.ts).
//
// Logika yang bisa diuji ada di push/. File ini hanya merangkai, jadi sengaja tipis.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { handlePush, openNotificationTarget, type ClientsLike, type ShownNotification } from "./push/sw-logic";

// Tipe seperlunya, ditulis sendiri: tipe lengkap service worker memakai pustaka "webworker" yang bentrok dengan "DOM"
// yang dipakai seluruh aplikasi.
type Waitable = { waitUntil(promise: Promise<unknown>): void };
type SwScope = {
  __WB_MANIFEST: Array<string | { url: string; revision?: string | null }>;
  location: { origin: string };
  navigator: { language: string };
  clients: ClientsLike & { claim(): Promise<void> };
  registration: { showNotification(title: string, options: object): Promise<void>; getNotifications(): Promise<ShownNotification[]> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(type: "activate", listener: (event: Waitable) => void): void;
  addEventListener(type: "push", listener: (event: Waitable & { data: { text(): string } | null }) => void): void;
  addEventListener(type: "notificationclick", listener: (event: Waitable & { notification: { close(): void; data: unknown } }) => void): void;
};
declare const self: SwScope;

// Versi baru aplikasi langsung menggantikan yang lama (sama dengan registerType "autoUpdate").
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

self.addEventListener("push", (event) => {
  let raw: string | undefined;
  try {
    raw = event.data?.text();
  } catch {
    raw = undefined; // isi tidak bisa dibaca: tetap tampilkan notifikasi umum
  }
  event.waitUntil(handlePush(raw, self.navigator.language, (title, options) => self.registration.showNotification(title, options), () => self.registration.getNotifications()));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(self.clients, event.notification.data, self.location.origin));
});
