#!/usr/bin/env bash
# Menjalankan satu eksperimen hook dengan Claude Code sungguhan di folder sementara.
# Pemakaian: run.sh <nama> <skenario.json|-> "<prompt>" [argumen tambahan untuk claude...]
# Variabel: SPIKE_OUT (folder hasil), SPIKE_TIMEOUT (detik, bawaan 600), SPIKE_MODEL, SPIKE_TURNS
# Butuh Git Bash di Windows (untuk `pwd -W`).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }

name="$1"; scenario="$2"; prompt="$3"; shift 3
out="${SPIKE_OUT:-$here/out}/$name"
rm -rf "$out"; mkdir -p "$out/project"
cp -r "$here/seed/." "$out/project/"
out="$(winpath "$out")"
hook="$(winpath "$here")/log-hook.mjs"

export SPIKE_LOG="$out/events.jsonl"
if [ "$scenario" != "-" ]; then
  export SPIKE_SCENARIO="$(winpath "$(dirname "$scenario")")/$(basename "$scenario")"
fi
node "$here/make-settings.mjs" "$hook" "${SPIKE_TIMEOUT:-600}" "${SPIKE_EVENTS:-}" > "$out/settings.json"

# Bersihkan variabel CLAUDE* milik sesi induk supaya sesi percobaan berdiri sendiri.
# "|| true" karena grep keluar dengan kode 1 bila tidak ada variabel CLAUDE*
# (misalnya dijalankan dari terminal biasa), dan set -e akan menghentikan skrip.
unset_args=$(env | (grep -o '^CLAUDE[A-Z_]*' || true) | sed 's/^/-u /' | tr '\n' ' ')
cd "$out/project"
# shellcheck disable=SC2086
env $unset_args claude -p "$prompt" \
  --model "${SPIKE_MODEL:-haiku}" --max-turns "${SPIKE_TURNS:-6}" \
  --settings "$out/settings.json" --setting-sources project --strict-mcp-config \
  --output-format stream-json --verbose "$@" \
  > "$out/stream.jsonl" 2> "$out/stderr.txt" || echo "claude exit code: $?" >> "$out/stderr.txt"

node "$here/summarize.mjs" "$out"
[ -s "$out/stderr.txt" ] && { echo "== STDERR =="; head -c 600 "$out/stderr.txt"; }
exit 0
