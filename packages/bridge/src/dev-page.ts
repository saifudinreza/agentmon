// =====================================================================================
// FILE INI: isi halaman web lokal (alat pengembangan) dalam satu berkas HTML.
// =====================================================================================
//
// Halaman ini menampilkan izin yang sedang menunggu (lengkap dengan diff), tombol setujui dan
// tolak dengan komentar, serta timeline kejadian. Ini ALAT PENGEMBANGAN untuk membuktikan alur
// inti sebelum ada server dan aplikasi HP, jadi tampilannya sengaja polos.
//
// KEAMANAN (yang tidak boleh dilonggarkan):
//   1. Isi yang ditampilkan datang dari AGENT dan TIDAK DIPERCAYA: isi berkas, perintah shell,
//      nama berkas, komentar. Bisa saja berisi "<script>..." (prompt injection lewat kode).
//      Karena itu SEMUA data dirender sebagai TEKS (textContent / createTextNode), tidak pernah
//      lewat innerHTML. Ada test yang memeriksa kode halaman ini tidak memakai API berbahaya.
//   2. Content-Security-Policy yang ketat (dipasang saat halaman dikirim, lihat dev-ui.ts):
//      skrip dan gaya hanya yang membawa kode acak sekali pakai (nonce), tidak boleh memanggil
//      alamat lain, tidak boleh dibingkai situs lain.
//   3. Kredensial (token) dibaca dari FRAGMEN alamat (#...). Fragmen tidak pernah dikirim ke
//      server dan tidak masuk log; halaman langsung menghapusnya dari alamat dan menyimpannya
//      hanya untuk tab ini (sessionStorage).
//
// Catatan penulisan: skrip di bawah ada di dalam template literal TypeScript, jadi TIDAK BOLEH
// memakai tanda backtick atau urutan dolar-kurung-kurawal di dalamnya.

const STYLE = String.raw`
  :root { color-scheme: light dark; --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; --line: #8888; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  .muted { opacity: 0.7; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
  .card h3 { font-size: 15px; margin: 0 0 6px; }
  .badge { display: inline-block; border: 1px solid var(--warn); color: var(--warn); border-radius: 4px; padding: 0 6px; margin-right: 6px; font-size: 12px; }
  pre, .diff { font: 12px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; margin: 6px 0; }
  .hunk { border: 1px solid var(--line); border-radius: 4px; margin: 6px 0; overflow: hidden; }
  .hunk-head { background: #8882; padding: 2px 6px; }
  .line { padding: 0 6px; white-space: pre-wrap; word-break: break-all; }
  .add { background: #2da44e33; }
  .remove { background: #cf222e33; }
  .actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  textarea { flex: 1 1 280px; min-height: 36px; font: inherit; }
  button { font: inherit; padding: 4px 14px; cursor: pointer; }
  button.ok { border-color: var(--ok); color: var(--ok); }
  button.bad { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: 0.5; cursor: default; }
  .error { color: var(--bad); }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 2px 0; border-bottom: 1px solid #8882; }
  .time { opacity: 0.6; margin-right: 8px; font-family: ui-monospace, Consolas, monospace; }
`;

const SCRIPT = String.raw`
(function () {
  "use strict";

  // ---- Kredensial: dari fragmen alamat, lalu dihapus dari alamat ----
  var KEY = "agentmon.dev.token";
  var token = null;
  try {
    var fromHash = location.hash.replace(/^#/, "");
    if (fromHash) {
      token = fromHash;
      try { sessionStorage.setItem(KEY, fromHash); } catch (e) {}
      history.replaceState(null, "", location.pathname);
    } else {
      try { token = sessionStorage.getItem(KEY); } catch (e) {}
    }
  } catch (e) {}

  // ---- Membangun elemen. SEMUA isi disisipkan sebagai TEKS, tidak pernah sebagai HTML. ----
  function el(tag, cls, children) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function short(id) { return String(id).slice(0, 8); }
  function clock(iso) { return String(iso).slice(11, 19); }

  var statusBox = document.getElementById("status");
  var pendingBox = document.getElementById("pending");
  var timelineBox = document.getElementById("timeline");

  function api(method, path, body) {
    var headers = { Authorization: "Bearer " + token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    });
  }

  function showFatal(message) {
    clear(statusBox);
    statusBox.appendChild(el("p", "error", [message]));
  }

  // ---- Diff ----
  function describeChange(change) {
    switch (change.type) {
      case "text": return (change.isNew ? "Berkas baru. " : "") + "+" + change.added + " -" + change.removed + " (" + change.hunks.length + " hunk)";
      case "unchanged": return change.formatChanged ? "Isi sama, hanya format (akhir baris) yang berubah." : "Tidak ada perubahan.";
      case "binary": return "Berkas biner; isinya tidak ditampilkan.";
      case "too_large": return "Terlalu besar untuk ditampilkan rinci. " + change.message;
      case "mismatch": return "Usulan tidak cocok dengan isi berkas: " + change.message;
      default: return "";
    }
  }

  function renderDiff(diff) {
    var box = el("div", "diff", []);
    box.appendChild(el("div", "muted", [diff.path + " : " + describeChange(diff.change)]));
    if (diff.change.type === "text") {
      diff.change.hunks.forEach(function (hunk) {
        var head = "@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@  " + hunk.id;
        var node = el("div", "hunk", [el("div", "hunk-head", [head])]);
        hunk.lines.forEach(function (line) {
          var mark = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
          node.appendChild(el("div", "line " + line.type, [mark + line.text]));
        });
        box.appendChild(node);
      });
    }
    return box;
  }

  // ---- Kartu izin yang menunggu. Dibuat sekali per izin supaya komentar yang sedang diketik tidak hilang. ----
  var cards = {}; // approvalId -> { node, countdown }

  function buildCard(item) {
    var title = el("h3", null, [item.toolName]);
    var countdown = el("span", "muted", [""]);
    var head = el("div", "bar", [title, el("span", "muted", ["sesi " + short(item.sessionId)]), countdown]);
    var card = el("div", "card", [head]);

    if (item.diff && item.diff.sensitive.length > 0) {
      var badges = el("div", null, []);
      item.diff.sensitive.forEach(function (reason) {
        badges.appendChild(el("span", "badge", [reason.code]));
        badges.appendChild(el("span", "muted", [reason.message + " "]));
      });
      card.appendChild(badges);
    }
    if (item.diff) card.appendChild(renderDiff(item.diff));
    else card.appendChild(el("pre", null, [JSON.stringify(item.toolInput, null, 2)]));

    var comment = el("textarea", null, []);
    comment.setAttribute("placeholder", "Komentar untuk agent (dibaca agent bila ditolak)");
    var approve = el("button", "ok", ["Setujui"]);
    var deny = el("button", "bad", ["Tolak"]);
    var message = el("span", "error", [""]);

    function send(decision) {
      approve.disabled = true;
      deny.disabled = true;
      var body = { approvalId: item.approvalId, decision: decision };
      if (comment.value.trim() !== "") body.comment = comment.value;
      api("POST", "/dev/api/decision", body).then(function (res) {
        if (res.status !== 200) {
          message.textContent = "Gagal (" + res.status + "): " + (res.data.error || "tidak diketahui");
          approve.disabled = false;
          deny.disabled = false;
        }
        refresh();
      }).catch(function () {
        message.textContent = "Daemon tidak terjangkau.";
        approve.disabled = false;
        deny.disabled = false;
      });
    }
    approve.addEventListener("click", function () { send("approve"); });
    deny.addEventListener("click", function () { send("deny"); });

    card.appendChild(el("div", "actions", [comment, approve, deny, message]));
    return { node: card, countdown: countdown };
  }

  function tickCountdowns(pending) {
    var now = Date.now();
    pending.forEach(function (item) {
      var entry = cards[item.approvalId];
      if (!entry) return;
      var left = Math.max(0, Math.round((Date.parse(item.expiresAt) - now) / 1000));
      entry.countdown.textContent = "sisa " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    });
  }

  // ---- Render keseluruhan ----
  var lastPending = [];
  function render(state) {
    clear(statusBox);
    statusBox.appendChild(el("p", null, [state.status.message]));
    var toggle = el("button", null, [state.status.paused ? "Lanjutkan penahanan" : "Jeda penahanan"]);
    toggle.addEventListener("click", function () {
      api("POST", state.status.paused ? "/dev/api/resume" : "/dev/api/pause").then(refresh);
    });
    statusBox.appendChild(el("div", "bar", [toggle]));

    var ids = {};
    state.pending.forEach(function (item) {
      ids[item.approvalId] = true;
      if (!cards[item.approvalId]) {
        cards[item.approvalId] = buildCard(item);
        pendingBox.appendChild(cards[item.approvalId].node);
      }
    });
    Object.keys(cards).forEach(function (id) {
      if (!ids[id]) { pendingBox.removeChild(cards[id].node); delete cards[id]; }
    });
    document.getElementById("pending-empty").hidden = state.pending.length > 0;
    lastPending = state.pending;
    tickCountdowns(lastPending);

    clear(timelineBox);
    state.timeline.slice().reverse().forEach(function (entry) {
      timelineBox.appendChild(el("li", null, [
        el("span", "time", [clock(entry.ts)]),
        entry.summary,
        el("span", "muted", ["  sesi " + short(entry.sessionId)])
      ]));
    });
  }

  var busy = false;
  function refresh() {
    if (busy) return;
    if (!token) { showFatal("Tidak ada kredensial. Buka halaman ini lewat alamat dari perintah: pnpm --filter @agentmon/bridge cli ui"); return; }
    busy = true;
    api("GET", "/dev/api/state").then(function (res) {
      if (res.status === 200) render(res.data);
      else showFatal(res.status === 401 ? "Kredensial ditolak. Ambil alamat baru dengan perintah cli ui." : "Gagal (" + res.status + "): " + (res.data.error || ""));
    }).catch(function () {
      showFatal("Daemon tidak terjangkau.");
    }).then(function () { busy = false; });
  }

  refresh();
  setInterval(refresh, 1000);
  setInterval(function () { tickCountdowns(lastPending); }, 1000);
})();
`;

/** Isi halaman. `nonce` adalah kode acak sekali pakai yang juga ada di header CSP. */
export function renderDevPage(nonce: string): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AgentMon (alat pengembangan)</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1>AgentMon <span class="muted">alat pengembangan</span></h1>
<div id="status"><p class="muted">Memuat...</p></div>
<h2>Menunggu keputusan</h2>
<p id="pending-empty" class="muted">Tidak ada permintaan yang menunggu.</p>
<div id="pending"></div>
<h2>Timeline</h2>
<ul id="timeline"></ul>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
