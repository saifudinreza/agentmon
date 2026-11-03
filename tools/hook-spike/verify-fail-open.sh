#!/usr/bin/env bash
# Membuktikan dengan Claude Code SUNGGUHAN bahwa kegagalan hook http tidak pernah membuat
# agent macet dan tidak pernah menyetujui aksi. Memakai konfigurasi dari pembuat
# konfigurasi yang sebenarnya (packages/bridge), dan pengaturan khusus satu sesi
# (--settings), jadi pengaturan Claude Code milikmu tidak disentuh.
#
# Pemakaian: tools/hook-spike/verify-fail-open.sh
# Variabel: SPIKE_OUT (folder hasil), SPIKE_MODEL. Butuh Node.js, Claude Code, Git Bash.
# Memakai sedikit kuota langganan (model haiku, belasan sesi pendek).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }

SPIKE_OUT="${SPIKE_OUT:-$here/out/anti-macet}"
mkdir -p "$SPIKE_OUT/_work"
SPIKE_OUT="$(winpath "$SPIKE_OUT")"
export SPIKE_OUT
work="$SPIKE_OUT/_work"

REAL_PORT=47910
FAKE_TOKEN="$(printf 'a%.0s' $(seq 1 64))"
WRONG_TOKEN="$(printf '0%.0s' $(seq 1 64))"
PROMPT="Buat file notes.txt berisi teks 'catatan'. Jika ada yang menghalangi, kutip persis pesan yang kamu terima. Setelah itu berhenti."
LIMIT=90000

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# Port tetap dipakai skrip ini. Bila salah satunya sedang dipakai program lain, berhenti
# dulu daripada menembak program itu atau menghasilkan hasil yang salah.
for port in "$REAL_PORT" 47901 47902 47903 47904 47905 47906 47920; do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$port/"; then
    echo "port $port sedang dipakai program lain; hentikan dulu lalu jalankan ulang"
    exit 2
  fi
done

settings() { # nama port token timeout -> berkas settings dari pembuat konfigurasi sebenarnya
  (cd "$root/packages/bridge" && node --import tsx ../../tools/hook-spike/print-config.ts "$2" "$3" "$4") > "$work/settings-$1.json"
}
fake() { # mode port [delayMs]
  node "$here/fake-daemon.mjs" "$1" "$2" "${3:-}" > "$work/fake-$1-$2.log" 2>&1 &
  pids+=("$!")
}
scenario() { # nama berkasSettings diharapkan
  SPIKE_SETTINGS="$2" "$here/run.sh" "$1" - "$PROMPT" > "$work/$1.out" 2>&1
  node "$here/judge.mjs" "$SPIKE_OUT/$1" "$1" "$3" "$LIMIT" | tee -a "$work/hasil.txt"
}

: > "$work/hasil.txt"
user_settings="$HOME/.claude/settings.json"
before="$([ -f "$user_settings" ] && sha256sum "$user_settings" | cut -d' ' -f1 || echo tidak-ada)"

echo "== menyalakan daemon sungguhan di port $REAL_PORT"
rm -rf "$work/home"; mkdir -p "$work/home"
# "exec" mengganti subshell dengan proses node, supaya $! adalah PID node yang bisa dimatikan.
(cd "$root/packages/bridge" && AGENTMON_HOME="$work/home" AGENTMON_PORT=$REAL_PORT exec node --import tsx src/main.ts > "$work/daemon.out" 2>&1) &
pids+=("$!")
for _ in $(seq 1 40); do
  [ -s "$work/home/token" ] && curl -s -m 1 -o /dev/null -H "Authorization: Bearer $(cat "$work/home/token")" "http://127.0.0.1:$REAL_PORT/health" && break
  sleep 1
done
REAL_TOKEN="$(cat "$work/home/token" 2>/dev/null)"
[ -n "$REAL_TOKEN" ] || { echo "daemon tidak menyala"; exit 2; }

echo "== menyiapkan konfigurasi dan server palsu"
settings daemon-nyata "$REAL_PORT" "$REAL_TOKEN" 600
settings token-salah "$REAL_PORT" "$WRONG_TOKEN" 600
settings daemon-mati 47920 "$FAKE_TOKEN" 600
settings port-salah 1 "$FAKE_TOKEN" 600
settings lambat 47901 "$FAKE_TOKEN" 3
settings text 47902 "$FAKE_TOKEN" 600
settings badjson 47903 "$FAKE_TOKEN" 600
settings badshape 47904 "$FAKE_TOKEN" 600
settings status500 47905 "$FAKE_TOKEN" 600
settings kontrol-allow 47906 "$FAKE_TOKEN" 600
echo '{}' > "$work/settings-tanpa-hook.json"
fake slow 47901 15000
fake text 47902
fake badjson 47903
fake badshape 47904
fake status500 47905
fake allow 47906
sleep 2

echo "== menjalankan skenario dengan Claude Code (paralel per kelompok)"
# Hanya kelompok skenario yang ditunggu. "wait" tanpa argumen juga menunggu server palsu
# dan daemon yang memang tidak pernah selesai.
groups=()
( scenario 00-tanpa-hook "$work/settings-tanpa-hook.json" ditolak
  scenario 01-daemon-nyata "$work/settings-daemon-nyata.json" ditolak ) &
groups+=("$!")
( scenario 02-daemon-mati "$work/settings-daemon-mati.json" ditolak
  scenario 03-port-salah "$work/settings-port-salah.json" ditolak ) &
groups+=("$!")
( scenario 04-token-salah "$work/settings-token-salah.json" ditolak
  scenario 05-jawaban-lambat "$work/settings-lambat.json" ditolak ) &
groups+=("$!")
( scenario 06-jawaban-teks "$work/settings-text.json" ditolak
  scenario 07-json-terpotong "$work/settings-badjson.json" ditolak ) &
groups+=("$!")
( scenario 08-bentuk-salah "$work/settings-badshape.json" ditolak
  scenario 09-status-500 "$work/settings-status500.json" ditolak ) &
groups+=("$!")
( scenario 10-kontrol-allow "$work/settings-kontrol-allow.json" disetujui ) &
groups+=("$!")
wait "${groups[@]}"

after="$([ -f "$user_settings" ] && sha256sum "$user_settings" | cut -d' ' -f1 || echo tidak-ada)"
echo
echo "== ringkasan"
sort "$work/hasil.txt"
echo
echo "pengaturan Claude Code milik pengguna tidak berubah: $([ "$before" = "$after" ] && echo ya || echo TIDAK)"
fail="$(grep -c 'GAGAL' "$work/hasil.txt" || true)"
echo "skenario gagal: $fail"
[ "$fail" = "0" ] && [ "$before" = "$after" ]
