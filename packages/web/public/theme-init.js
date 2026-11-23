// Dijalankan SEBELUM halaman digambar supaya tema yang tersimpan langsung terpasang dan layar
// tidak berkedip terang lalu gelap. Logika yang sama ada di src/theme/theme.ts (diuji di sana).
(function () {
  var mode = "system";
  try {
    var saved = localStorage.getItem("agentmon.theme");
    if (saved === "light" || saved === "dark" || saved === "system") mode = saved;
  } catch (e) {}
  var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0b0f14" : "#f6f7f9");
})();
