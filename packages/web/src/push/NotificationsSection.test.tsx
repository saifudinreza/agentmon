import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { I18nProvider } from "../i18n/react";
import type { RelayEntry } from "../relay/RelayProvider";
import { NotificationsSection } from "./NotificationsSection";
import { IOS_APP, IOS_TAB, setupPush, type PushSetupOptions } from "./testing";

afterEach(() => cleanup());

const entry = { pairing: { relayUrl: "https://relay.contoh.com" }, store: {} } as unknown as RelayEntry;

function renderSection(options: PushSetupOptions = {}) {
  const setup = setupPush(options);
  render(
    <I18nProvider>
      <NotificationsSection entry={entry} env={setup.env} />
    </I18nProvider>,
  );
  return setup;
}

const enableButton = () => screen.findByRole("button", { name: "Aktifkan notifikasi" });

describe("NotificationsSection", () => {
  test("memeriksa dulu, lalu menawarkan tombol Aktifkan bila belum aktif", async () => {
    renderSection({ permission: "default" });
    expect(screen.getByText("Memeriksa status notifikasi…")).toBeTruthy();
    expect(await enableButton()).toBeTruthy();
    expect(screen.getByText("Belum aktif di perangkat ini.")).toBeTruthy();
  });

  test("izin TIDAK diminta saat halaman dibuka, hanya setelah tombol diketuk", async () => {
    const s = renderSection({ permission: "default" });
    await enableButton();
    expect(s.requestPermission).not.toHaveBeenCalled();
  });

  test("mengetuk Aktifkan meminta izin LANGSUNG di ketukan itu (bukan setelah menunggu apa pun), lalu menjadi aktif", async () => {
    const s = renderSection({ permission: "default", asks: "granted" });
    fireEvent.click(await enableButton());
    // Sinkron: tepat setelah ketukan, sebelum ada yang ditunggu. Itulah yang menjaga gestur di iOS.
    expect(s.requestPermission).toHaveBeenCalledTimes(1);
    expect(s.log.at(-1)).toBe("permission:ask");
    expect(await screen.findByText("Aktif di perangkat ini.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Matikan notifikasi" })).toBeTruthy();
    expect(s.relay.data.push.saved).toBeDefined();
  });

  test("selama proses, tombol berganti 'Mengaktifkan…' dan tidak bisa diketuk lagi", async () => {
    const s = renderSection({ permission: "default", asks: "granted" });
    const button = await enableButton(); // pemeriksaan awal selesai dulu; gerbang dipasang sesudahnya
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.relay.api.pushConfig = async () => (await gate, { enabled: true, publicKey: s.relay.data.push.config.publicKey! });
    fireEvent.click(button);
    const busy = await screen.findByRole("button", { name: "Mengaktifkan…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    await act(async () => release());
    expect(await screen.findByText("Aktif di perangkat ini.")).toBeTruthy();
  });

  test("pengguna menolak izin: pesan cara membukanya lagi, tanpa tombol Aktifkan", async () => {
    renderSection({ permission: "default", asks: "denied" });
    fireEvent.click(await enableButton());
    expect(await screen.findByText(/Notifikasi diblokir untuk AgentMon/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("izin yang sudah diblokir dari awal: pesan yang sama, izin tidak diminta", async () => {
    const s = renderSection({ permission: "denied" });
    expect(await screen.findByText(/Notifikasi diblokir untuk AgentMon/)).toBeTruthy();
    expect(s.requestPermission).not.toHaveBeenCalled();
  });

  test("pengguna menutup dialog tanpa memilih: tombol Aktifkan tetap ada untuk dicoba lagi", async () => {
    renderSection({ permission: "default", asks: "default" });
    fireEvent.click(await enableButton());
    expect(await enableButton()).toBeTruthy();
  });

  test("iOS di tab Safari: panduan memasang ke layar utama, tanpa tombol, izin tidak diminta", async () => {
    const s = renderSection({ platform: IOS_TAB, noNotification: true, noPushManager: true });
    expect(await screen.findByText("Pasang ke layar utama dulu")).toBeTruthy();
    expect(screen.getByText(/Tambahkan ke Layar Utama/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
    expect(s.requestPermission).not.toHaveBeenCalled();
    expect(s.api.pushConfig).not.toHaveBeenCalled();
  });

  test("iOS di aplikasi layar utama: tombol Aktifkan tersedia", async () => {
    renderSection({ platform: IOS_APP, permission: "default" });
    expect(await enableButton()).toBeTruthy();
    expect(screen.queryByText("Pasang ke layar utama dulu")).toBeNull();
  });

  test("browser tidak mendukung: penjelasan, tanpa tombol", async () => {
    renderSection({ noNotification: true });
    expect(await screen.findByText(/tidak mendukung notifikasi push/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("relay belum menyalakan push: penjelasan, tanpa tombol", async () => {
    const setup = setupPush({ permission: "default" });
    setup.relay.data.push.config = { enabled: false };
    render(
      <I18nProvider>
        <NotificationsSection entry={entry} env={setup.env} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/belum menyalakan notifikasi push/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("service worker belum aktif: penjelasan dan tombol Coba lagi", async () => {
    renderSection({ noRegistration: true });
    expect(await screen.findByText(/service worker belum aktif/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Coba lagi" })).toBeTruthy();
  });

  test("relay tidak terjangkau: pesan galat dan Coba lagi yang memeriksa ulang", async () => {
    const setup = setupPush({ permission: "default" });
    setup.relay.fail.pushConfig = new Error("jaringan");
    render(
      <I18nProvider>
        <NotificationsSection entry={entry} env={setup.env} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/Status notifikasi tidak bisa diperiksa/)).toBeTruthy();
    delete setup.relay.fail.pushConfig;
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await enableButton()).toBeTruthy();
  });

  test("gagal saat mengaktifkan: pesan galat dan tombol Coba lagi, tidak dianggap aktif", async () => {
    const setup = setupPush({ permission: "default", asks: "granted" });
    setup.relay.fail.pushSave = new Error("503");
    render(
      <I18nProvider>
        <NotificationsSection entry={entry} env={setup.env} />
      </I18nProvider>,
    );
    fireEvent.click(await enableButton());
    expect(await screen.findByText("Notifikasi gagal diaktifkan. Coba lagi.")).toBeTruthy();
    expect(screen.queryByText("Aktif di perangkat ini.")).toBeNull();
    expect(screen.getByRole("button", { name: "Coba lagi" })).toBeTruthy();
  });

  test("sudah aktif: menampilkan Aktif dan tombol Matikan; mematikan berhasil kembali ke belum aktif", async () => {
    const s = renderSection({ permission: "granted", existing: true, intent: true });
    expect(await screen.findByText("Aktif di perangkat ini.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Matikan notifikasi" }));
    expect(await screen.findByText("Belum aktif di perangkat ini.")).toBeTruthy();
    expect(s.relay.data.push.removed).toBe(1);
    expect(await enableButton()).toBeTruthy();
  });

  test("mematikan saat relay tidak terjangkau: tetap mati di HP, dengan catatan relay belum menerima", async () => {
    const setup = setupPush({ permission: "granted", existing: true, intent: true });
    render(
      <I18nProvider>
        <NotificationsSection entry={entry} env={setup.env} />
      </I18nProvider>,
    );
    await screen.findByText("Aktif di perangkat ini.");
    setup.relay.fail.pushRemove = new Error("jaringan");
    fireEvent.click(screen.getByRole("button", { name: "Matikan notifikasi" }));
    await waitFor(() => expect(screen.getByText("Belum aktif di perangkat ini.")).toBeTruthy());
    expect(screen.getByText(/relay belum menerima pembatalannya/)).toBeTruthy();
  });

  test("aksesibilitas: tombol yang sama tetap terpasang dan berfokus selama dan sesudah proses (hasil review PR #58)", async () => {
    renderSection({ permission: "default", asks: "granted" });
    const button = await enableButton();
    button.focus();
    fireEvent.click(button);
    await screen.findByText("Aktif di perangkat ini.");
    const after = screen.getByRole("button", { name: "Matikan notifikasi" });
    expect(after).toBe(button); // elemen yang sama, hanya label yang berganti
    expect(document.activeElement).toBe(button);
  });

  test("aksesibilitas: wilayah status yang sama selalu ada, dan ketukan saat sibuk diabaikan", async () => {
    const s = renderSection({ permission: "default", asks: "granted" });
    const region = screen.getByRole("status");
    const button = await enableButton();
    expect(screen.getByRole("status")).toBe(region);
    fireEvent.click(button);
    fireEvent.click(button); // ketukan kedua saat proses berjalan tidak menjalankan apa-apa lagi
    await screen.findByText("Aktif di perangkat ini.");
    expect(s.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toBe(region);
  });

  test("service worker belum aktif memakai status biasa (bukan alert)", async () => {
    renderSection({ noRegistration: true });
    const message = await screen.findByText(/service worker belum aktif/);
    expect(message.closest('[role="alert"]')).toBeNull();
    expect(message.closest('[role="status"]')).not.toBeNull();
  });

  test("teks tidak menyuruh 'muat ulang' saja (app layar utama iOS tidak punya tombol muat ulang)", async () => {
    renderSection({ noRegistration: true });
    expect(await screen.findByText(/Tutup dan buka lagi aplikasinya/)).toBeTruthy();
  });

  test("teks tampil dalam bahasa Inggris bila bahasa app Inggris", async () => {
    window.localStorage.setItem("agentmon.locale", "en");
    try {
      renderSection({ permission: "default" });
      expect(await screen.findByRole("button", { name: "Turn on notifications" })).toBeTruthy();
    } finally {
      window.localStorage.removeItem("agentmon.locale");
    }
  });
});
