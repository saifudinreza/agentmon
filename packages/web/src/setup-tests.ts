// Dijalankan sebelum setiap file test (lihat vitest.config.ts).
//
// WebSocket di jsdom benar-benar mencoba menyambung ke jaringan. Test tidak boleh menghubungi siapa pun, dan
// komponen yang membuka sambungan ke relay (RelayProvider) tidak boleh meninggalkan percobaan sambung ulang di
// latar belakang. Maka WebSocket diganti soket mati yang tidak pernah terbuka. Test yang butuh perilaku
// WebSocket menyuntikkan soket tiruannya sendiri.
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
  }
}
Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: InertWebSocket });
