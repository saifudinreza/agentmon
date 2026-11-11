import { buildPairingUrl } from "@agentmon/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { stubMatchMedia, stubPlatform, USER_AGENTS } from "../testing";
import { clearPendingLink, peekPendingLink } from "./pending";
import { PairScreen } from "./PairScreen";
import { loadPairings, PAIRINGS_STORAGE_KEY, savePairing } from "./storage";

const CODE = "abcDEF0123456789_-abcDEF0123456789";
const RELAY = "https://relay.contoh.com";
const TOKEN = "d".repeat(64);
const FRAGMENT = `c=${CODE}&r=${encodeURIComponent(RELAY)}`;
const PAIR_URL = `/pair#${FRAGMENT}`;

const okReply = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ deviceId: "d1", machineId: "m1", machineName: "Laptop Kantor", deviceToken: TOKEN, ...extra }), { status: 200 });
const reply = (status: number) => new Response(JSON.stringify({ error: "x" }), { status });

let restorePlatform: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function open(url: string) {
  window.history.replaceState(null, "", url);
}
function renderPair(locale?: "id" | "en") {
  return render(
    <I18nProvider {...(locale ? { initialLocale: locale } : {})}>
      <PairScreen />
    </I18nProvider>,
  );
}
function mockFetch(...responses: Array<Response | Error>) {
  const queue = [...responses];
  fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("tidak ada jawaban yang disiapkan");
    if (!(next instanceof Response)) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
}
const platform = (userAgent: string, extra: Parameters<typeof stubPlatform>[0] extends infer T ? Partial<T> : never = {}) => {
  restorePlatform?.();
  restorePlatform = stubPlatform({ userAgent, ...extra });
};
const pairButton = () => screen.getByRole("button", { name: "Pasangkan" });

beforeEach(() => {
  window.localStorage.clear();
  clearPendingLink();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  platform(USER_AGENTS.androidChrome);
  stubMatchMedia(true);
  open(PAIR_URL);
  mockFetch(okReply());
});
afterEach(() => {
  cleanup();
  restorePlatform?.();
  restorePlatform = undefined;
  vi.unstubAllGlobals();
  open("/");
});

describe("kode tidak tertinggal di alamat", () => {
  test("fragmen dihapus dari alamat begitu layar terbuka, SEBELUM pengguna melakukan apa pun", () => {
    renderPair();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(CODE);
    expect(window.location.pathname).toBe("/pair");
  });

  test("kode juga tidak tampil di layar konfirmasi", () => {
    const { container } = renderPair();
    expect(container.textContent).not.toContain(CODE);
  });

  test("setelah berhasil, kode tidak ada di alamat, di layar, maupun di penyimpanan", async () => {
    const { container } = renderPair();
    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Kantor");
    expect(window.location.href).not.toContain(CODE);
    expect(container.textContent).not.toContain(CODE);
    expect(window.localStorage.getItem(PAIRINGS_STORAGE_KEY)).not.toContain(CODE);
  });

  test("memuat ulang halaman setelah kode dihapus: kode memang hilang, pengguna dipandu menempelkan atau memindai ulang", () => {
    renderPair();
    cleanup();
    renderPair(); // simulasi muat ulang: alamat sekarang tanpa fragmen
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tautan pairing tidak ditemukan");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("memindai QR lain saat layar pairing sudah terbuka (hanya fragmen alamat yang berubah)", () => {
  const NEXT_CODE = "ZZZzzz9999999999_-ZZZzzz9999999999";
  const scanAnother = (relay = RELAY) => {
    // Seperti browser: fragmen berganti tanpa memuat ulang, lalu event hashchange.
    window.location.hash = `c=${NEXT_CODE}&r=${encodeURIComponent(relay)}`;
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")));
  };

  test("setelah pairing pertama berhasil, QR laptop kedua memulai alur baru dan kodenya tidak tertinggal di alamat", async () => {
    mockFetch(okReply(), okReply({ machineId: "m2", machineName: "Laptop Rumah" }));
    renderPair();
    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Kantor");

    scanAnother();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasangkan dengan laptop");
    expect(window.location.href).not.toContain(NEXT_CODE);
    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Rumah");
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string).code).toBe(NEXT_CODE);
  });

  test("dari layar galat (kode terpakai), QR baru mengganti layar dan memakai kode yang baru", async () => {
    mockFetch(reply(400), okReply());
    renderPair();
    fireEvent.click(pairButton());
    await screen.findByRole("alert");

    scanAnother();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.location.href).not.toContain(NEXT_CODE);
    fireEvent.click(pairButton());
    await screen.findByText(/Terhubung dengan/);
  });

  test("dari layar 'tautan tidak ditemukan', QR baru langsung membuka konfirmasi", () => {
    open("/pair");
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tautan pairing tidak ditemukan");
    scanAnother();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasangkan dengan laptop");
  });

  test("perubahan fragmen yang BUKAN tautan pairing diabaikan, tetapi tetap dibersihkan dari alamat", () => {
    renderPair();
    window.location.hash = "bagian-lain";
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasangkan dengan laptop");
    expect(window.location.hash).toBe("");
  });

  test("pendengar dilepas saat layar ditutup (tidak bocor)", () => {
    const { unmount } = renderPair();
    unmount();
    expect(() => scanAnother()).not.toThrow();
  });
});

describe("konfirmasi", () => {
  test("menampilkan relay yang akan dipakai, peringatan, dan nama bawaan perangkat", () => {
    renderPair();
    expect(screen.getByText("Laptop akan dihubungkan lewat relay.contoh.com.")).toBeTruthy();
    expect(screen.getByText(/Lanjutkan hanya bila Anda sendiri/)).toBeTruthy();
    expect((screen.getByLabelText("Nama perangkat ini") as HTMLInputElement).value).toBe("Android");
  });

  test.each([
    [USER_AGENTS.iphoneSafari, "iPhone", { standalone: true }],
    [USER_AGENTS.androidChrome, "Android", {}],
    [USER_AGENTS.windowsChrome, "Perangkat ini", {}],
  ])("nama bawaan mengikuti perangkat: %#", (userAgent, expected, extra) => {
    platform(userAgent, extra);
    renderPair();
    expect((screen.getByLabelText("Nama perangkat ini") as HTMLInputElement).value).toBe(expected);
  });

  test("pairing TIDAK berjalan otomatis: tautan buatan orang lain tidak boleh memasangkan HP diam-diam", () => {
    renderPair();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("bahasa Inggris", () => {
    renderPair("en");
    expect(screen.getByText("The laptop will be connected through relay.contoh.com.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair" })).toBeTruthy();
  });

  test("relay dengan port dan jalur ditampilkan lengkap, supaya pengguna bisa mengenali alamatnya", () => {
    open(`/pair#c=${CODE}&r=${encodeURIComponent("https://relay.contoh.com:8443/awalan")}`);
    renderPair();
    expect(screen.getByText("Laptop akan dihubungkan lewat relay.contoh.com:8443.")).toBeTruthy();
  });
});

describe("nama perangkat", () => {
  test("nama dari pengguna dikirim apa adanya (setelah dipangkas)", async () => {
    renderPair();
    fireEvent.change(screen.getByLabelText("Nama perangkat ini"), { target: { value: "  Pixel Budi  " } });
    fireEvent.click(pairButton());
    await screen.findByText(/Terhubung dengan/);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ code: CODE, name: "Pixel Budi" });
  });

  test.each([
    ["kosong", ""],
    ["hanya spasi", "   "],
    ["terlalu panjang", "x".repeat(65)],
    ["berisi escape ANSI", "HP\u001b[2J"],
    // (Baris baru tidak diuji di sini: elemen <input> membuangnya sendiri; skema menolaknya, lihat test shared.)
    ["berisi pemisah baris Unicode", "HP lain"],
  ])("nama %s: tombol mati, pesan tampil setelah diisi, dan tidak ada permintaan", (_label, value) => {
    renderPair();
    const input = screen.getByLabelText("Nama perangkat ini");
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect((pairButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Nama tidak boleh/)).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.submit(input.closest("form") as HTMLFormElement); // bahkan dengan Enter, tidak lolos
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hasil penukaran", () => {
  test("berhasil: menyimpan di perangkat, menampilkan nama laptop, dan 'Selesai' kembali ke beranda", async () => {
    renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("heading", { level: 2 })).textContent).toBe("Terhubung dengan Laptop Kantor");

    expect(loadPairings(window.localStorage)).toEqual([
      { relayUrl: RELAY, deviceId: "d1", deviceToken: TOKEN, machines: [expect.objectContaining({ id: "m1", name: "Laptop Kantor" })] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));
    expect(window.location.pathname).toBe("/");
  });

  test("mengirim permintaan ke relay yang tertulis di tautan", async () => {
    renderPair();
    fireEvent.click(pairButton());
    await screen.findByText(/Terhubung dengan/);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${RELAY}/pair/redeem`);
  });

  test("kode kedaluwarsa atau terpakai (400): pesan jelas, tanpa tombol coba lagi (kode itu sudah tidak berguna)", async () => {
    mockFetch(reply(400));
    renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("alert")).textContent).toContain("kedaluwarsa atau sudah dipakai");
    expect(screen.queryByRole("button", { name: "Coba lagi" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kembali" })).toBeTruthy();
    expect(window.localStorage.getItem(PAIRINGS_STORAGE_KEY)).toBeNull();
  });

  test("terlalu banyak percobaan (429): bisa dicoba lagi, dan percobaan kedua bisa berhasil", async () => {
    mockFetch(reply(429), okReply());
    renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Terlalu banyak percobaan");
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Kantor");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("relay tidak terjangkau: bisa dicoba lagi", async () => {
    mockFetch(new TypeError("Failed to fetch"), okReply());
    renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Tidak bisa menghubungi relay");
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    fireEvent.click(pairButton());
    await screen.findByText(/Terhubung dengan/);
  });

  test("galat server (500): pesan umum, tanpa membocorkan rincian", async () => {
    mockFetch(reply(500));
    const { container } = renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("alert")).textContent).toContain("kesalahan tak terduga");
    expect(container.textContent).not.toContain("500");
  });

  test("relay tanpa enkripsi: dibatalkan demi keamanan, tidak menghubungi siapa pun", async () => {
    open(`/pair#c=${CODE}&r=${encodeURIComponent("http://relay.contoh.com")}`);
    renderPair();
    fireEvent.click(pairButton());
    expect((await screen.findByRole("alert")).textContent).toContain("tidak terenkripsi");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("berhasil di relay tetapi perangkat tidak bisa menyimpan (mode privat): dikatakan terus terang beserta langkah berikutnya", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    renderPair();
    fireEvent.click(pairButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Pairing dengan Laptop Kantor berhasil");
    expect(alert.textContent).toContain("tidak bisa disimpan");
    expect(screen.queryByText(/^Terhubung dengan/)).toBeNull(); // tidak pura-pura berhasil
  });

  test("menekan Pasangkan dua kali dengan cepat hanya mengirim SATU permintaan (kode sekali pakai tidak terbuang)", async () => {
    let release!: (response: Response) => void;
    fetchMock = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderPair();
    const form = pairButton().closest("form") as HTMLFormElement; // tombolnya berganti nama saat bekerja
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Memasangkan…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => release(okReply()));
    await screen.findByText(/Terhubung dengan/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("HP yang sudah punya kredensial memakainya untuk laptop kedua (satu perangkat, dua laptop)", async () => {
    savePairing(window.localStorage, { relayUrl: RELAY, deviceId: "d1", deviceToken: "o".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
    mockFetch(new Response(JSON.stringify({ deviceId: "d1", machineId: "m2", machineName: "Laptop Rumah" }), { status: 200 }));
    renderPair();
    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Rumah");
    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>).authorization).toBe(`Bearer ${"o".repeat(64)}`);
    expect(loadPairings(window.localStorage)[0]?.machines.map((m) => m.name)).toEqual(["Laptop Kantor", "Laptop Rumah"]);
  });
});

describe("tidak ada tautan: tempel manual", () => {
  beforeEach(() => open("/pair"));

  test("menjelaskan apa yang harus dilakukan, dan tidak menghubungi siapa pun", () => {
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tautan pairing tidak ditemukan");
    expect(screen.getByLabelText("Tempel tautan pairing")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("tautan yang ditempel dikenali dan membuka konfirmasi; kolom dikosongkan", () => {
    renderPair();
    fireEvent.change(screen.getByLabelText("Tempel tautan pairing"), { target: { value: `https://app.contoh.com/pair#${FRAGMENT}` } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(screen.getByText("Laptop akan dihubungkan lewat relay.contoh.com.")).toBeTruthy();
  });

  test.each([
    ["teks biasa", "halo dunia"],
    ["alamat lain", "https://contoh.com/halaman"],
    ["tanpa kode", `https://app.contoh.com/pair#r=${encodeURIComponent(RELAY)}`],
    ["skema berbahaya", `javascript:alert(1)//pair#${FRAGMENT}`],
  ])("tautan tidak sah ditolak dengan pesan: %s", (_label, value) => {
    renderPair();
    fireEvent.change(screen.getByLabelText("Tempel tautan pairing"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(screen.getByRole("alert").textContent).toContain("bukan tautan pairing AgentMon");
    expect(screen.getByLabelText("Tempel tautan pairing").getAttribute("aria-invalid")).toBe("true");
  });

  test("pesan galat hilang begitu pengguna mengetik lagi", () => {
    renderPair();
    const input = screen.getByLabelText("Tempel tautan pairing");
    fireEvent.change(input, { target: { value: "salah" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(screen.queryByRole("alert")).not.toBeNull();
    fireEvent.change(input, { target: { value: "salah lagi" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("iOS: penyimpanan Safari dan aplikasi layar utama terpisah", () => {
  test("di tab Safari, pairing DITUNDA: pengguna dipandu memasang ke layar utama dulu, tanpa menghubungi relay", () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasang ke layar utama dulu");
    expect(screen.getByText(/menyimpan data terpisah dari Safari/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Pasangkan" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // kode belum dihabiskan
    expect(window.localStorage.getItem(PAIRINGS_STORAGE_KEY)).toBeNull();
  });

  test("iPad dalam mode desktop (menyamar sebagai Mac) juga dikenali dan dipandu", () => {
    platform(USER_AGENTS.ipadDesktopMode, { platform: "MacIntel", maxTouchPoints: 5, standalone: false });
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasang ke layar utama dulu");
  });

  test("'Salin tautan' menyalin tautan LENGKAP (dengan kode) untuk ditempel di aplikasi layar utama", async () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPair();
    fireEvent.click(screen.getByRole("button", { name: "Salin tautan pairing" }));
    await screen.findByText(/Tautan disalin/);

    const copied = (writeText.mock.calls as unknown as string[][])[0]?.[0] ?? "";
    expect(copied).toBe(buildPairingUrl(window.location.origin, { code: CODE, relayUrl: RELAY }));
    expect(copied).toContain(CODE);
    expect(copied).toContain("/pair#");
  });

  test("tautan yang disalin bisa ditempel kembali di aplikasi layar utama dan lanjut ke konfirmasi (lingkaran penuh)", async () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPair();
    fireEvent.click(screen.getByRole("button", { name: "Salin tautan pairing" }));
    await screen.findByText(/Tautan disalin/);
    const copied = (writeText.mock.calls as unknown as string[][])[0]?.[0] ?? "";
    cleanup();

    // Aplikasi layar utama: penyimpanan baru yang kosong, dan platform standalone.
    window.localStorage.clear();
    platform(USER_AGENTS.iphoneSafari, { standalone: true });
    open("/pair");
    renderPair();
    fireEvent.change(screen.getByLabelText("Tempel tautan pairing"), { target: { value: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    await screen.findByText("Terhubung dengan Laptop Kantor");
    expect(loadPairings(window.localStorage)).toHaveLength(1); // tersimpan DI APLIKASI layar utama
  });

  test("penyalinan gagal: tautan ditampilkan untuk disalin manual", async () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    renderPair();
    fireEvent.click(screen.getByRole("button", { name: "Salin tautan pairing" }));
    await screen.findByText(/Tidak bisa menyalin otomatis/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(CODE);
  });

  test("tanpa API clipboard sama sekali: tetap jatuh ke penyalinan manual", async () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderPair();
    fireEvent.click(screen.getByRole("button", { name: "Salin tautan pairing" }));
    await screen.findByText(/Tidak bisa menyalin otomatis/);
  });

  test("'Pasangkan di browser ini saja' memberi peringatan jelas lalu mengizinkan pairing", async () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    renderPair();
    expect(screen.getByText(/Pairing akan hilang bila AgentMon ditambahkan ke layar utama/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan di browser ini saja" }));
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    await screen.findByText(/Terhubung dengan/);
    expect(loadPairings(window.localStorage)).toHaveLength(1);
  });

  test("di aplikasi layar utama (standalone), pairing langsung ke konfirmasi tanpa panduan", () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: true });
    open(PAIR_URL);
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasangkan dengan laptop");
    expect(screen.queryByText("Pasang ke layar utama dulu")).toBeNull();
  });

  test("Android (Chrome berbagi penyimpanan dengan aplikasi terpasang): langsung ke konfirmasi, tanpa panduan", () => {
    platform(USER_AGENTS.androidChrome);
    renderPair();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Pasangkan dengan laptop");
  });

  test("panduan juga muncul di bahasa Inggris", () => {
    platform(USER_AGENTS.iphoneSafari, { standalone: false });
    renderPair("en");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Add to the home screen first");
  });
});

describe("alur lengkap lewat aplikasi (router)", () => {
  const renderApp = () =>
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    );

  test("buka alamat QR -> konfirmasi -> berhasil -> Selesai -> beranda menampilkan laptop; alamat bersih sepanjang jalan", async () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 2, name: "Pasangkan dengan laptop" })).toBeTruthy();
    expect(window.location.href).not.toContain(CODE);

    fireEvent.click(pairButton());
    await screen.findByText("Terhubung dengan Laptop Kantor");
    fireEvent.click(screen.getByRole("button", { name: "Selesai" }));

    await screen.findByRole("heading", { level: 2, name: "Laptop terpasang" });
    expect(screen.getByText("Laptop Kantor")).toBeTruthy();
    expect(screen.getByText("melalui relay.contoh.com")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(window.location.href).not.toContain(CODE);
  });

  test("dari beranda: tempel tautan -> layar pairing; tautan tidak lagi ada di kolom, alamat, maupun titipan memori", async () => {
    open("/");
    renderApp();
    expect(screen.getByRole("heading", { level: 2, name: "Belum ada laptop terpasang" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Tempel tautan pairing"), { target: { value: `https://app.contoh.com/pair#${FRAGMENT}` } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    expect(screen.getByRole("heading", { level: 2, name: "Pasangkan dengan laptop" })).toBeTruthy();
    expect(window.location.pathname).toBe("/pair");
    expect(window.location.href).not.toContain(CODE);
    await waitFor(() => expect(peekPendingLink()).toBeUndefined()); // titipan memori dibersihkan setelah dibaca
  });

  test("tombol Kembali di layar pairing membawa ke beranda", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { level: 2, name: "Belum ada laptop terpasang" })).toBeTruthy();
  });
});
