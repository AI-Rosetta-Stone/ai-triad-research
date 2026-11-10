#!/usr/bin/env bash
# DATA-ROOT-TEST-WRITE reporting for test-electron-vitest / test-electron-coverage (t/4454, t/64).
#
# Isolated sink, the #2070 pattern: this only writes to $GITHUB_STEP_SUMMARY and emits ::warning::
# annotations. Every mode exits 0 whatever it finds; the ci.yml steps are also continue-on-error.
#
#   data-root-guard-report.sh shard <tee'd vitest log> <shard>
#     One shard's log. With a DATA-ROOT-GUARD-SUMMARY line (lib t/60 globalSetup teardown), the hits are
#     its aggregated `DATA-ROOT-TEST-WRITE count=` lines. The per-hit console lines also reach the log
#     under --reporter=default, and counting both listed every target twice. Without a SUMMARY, the
#     per-hit lines are used as before. Three states (TL ruling p/331#2364): hits / 0 hits (marker seen)
#     / guard not installed, and "not installed" is loud.
#
#   data-root-guard-report.sh livefire <dir of hits-*.jsonl>
#     All shards' DATA_ROOT_GUARD_HITS_FILE records. The live-fire positive control is ONE test file, so
#     it lands in one shard; a per-shard livefire=0 is normal and only the cross-shard total means
#     anything (t/59, Quality-TechLead). Zero live-fire hits means 0 hits can't be trusted, so it's loud.
#     No hits files at all is loud too (t/65): since t/63 wired the lib globalSetup, every shard writes one, so a
#     missing set means the env var dropped, the artifact upload failed, or globalSetup was removed.
#
#   data-root-guard-report.sh --self-test
#     Both arms of every decision above against fixtures; exits non-zero on a mismatch.
set -uo pipefail

SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/null}"
LIVEFIRE_DIR_NAME="__guard_livefire__"

say() { echo "$*" >> "$SUMMARY_FILE"; }
warn() { echo "::warning::$*"; }

report_shard() {
  local log="$1" shard="$2" summary="" installed=false hits=()
  local title="### DATA-ROOT-TEST-WRITE (vitest, taxonomy-editor, shard $shard/3)"
  if [ -f "$log" ]; then
    summary=$(grep -oE 'DATA-ROOT-GUARD-SUMMARY (hits=|guard not installed).*' "$log" | head -1)
    if [ -n "$summary" ]; then
      mapfile -t hits < <(grep -o 'DATA-ROOT-TEST-WRITE count=.*' "$log" | sort -u)
    else
      mapfile -t hits < <(grep -o 'DATA-ROOT-TEST-WRITE.*' "$log" | sort -u)
    fi
    grep -q 'DATA-ROOT-GUARD-INSTALLED' "$log" && installed=true
    # The teardown's own verdict wins: it read the hits file, which every worker's install writes to.
    case "$summary" in *"guard not installed"*) installed=false ;; esac
  fi
  if [ "${#hits[@]}" -gt 0 ]; then
    say "$title: ${#hits[@]} target(s)"
    [ -n "$summary" ] && say "\`$summary\`"
    local line
    for line in "${hits[@]}"; do
      say "- \`$line\`"
      warn "$line"
    done
  elif [ "$installed" = true ]; then
    say "$title: 0 hits"
    [ -n "$summary" ] && say "\`$summary\`"
  else
    say "$title: guard not installed -- 0 hits is NOT a clean result"
    warn "DATA-ROOT guard not installed in vitest shard $shard/3; its 0 hits is NOT a clean result (t/64)"
  fi
  # Extra teardown lines (unparseable hits-file lines, the over-cap tail) go along verbatim.
  if [ -f "$log" ]; then
    grep -oE 'DATA-ROOT-GUARD-SUMMARY (WARN:|… and ).*' "$log" | while IFS= read -r line; do say "- \`$line\`"; done
  fi
  return 0
}

report_livefire() {
  local dir="$1" files=() installed=0 livefire=0 offenders=0
  local title="### DATA-ROOT guard positive control (vitest, all shards)"
  [ -d "$dir" ] && mapfile -t files < <(find "$dir" -name '*.jsonl' -type f | sort)
  if [ "${#files[@]}" -eq 0 ]; then
    say "$title: no hits files -- the positive control can't be checked, so 0 hits is NOT a clean result"
    warn "DATA-ROOT guard: no hits files reached test-electron-coverage (env var dropped, upload failed, or globalSetup removed); the live-fire positive control is unchecked (t/65)"
    return 0
  fi
  # Unparseable lines are skipped; a file with no install record then reads as "not installed" (fails closed).
  read -r installed livefire offenders < <(cat "${files[@]}" | node -e '
    const lf = process.argv[1]; let i = 0, l = 0, h = 0;
    for (const raw of require("fs").readFileSync(0, "utf8").split("\n")) {
      let r; try { r = JSON.parse(raw); } catch { continue; }
      if (r?.kind === "installed") i++;
      else if (r?.kind === "hit") { h++; if (String(r.target ?? "").split(/[\\/]/).includes(lf)) l++; }
    }
    console.log(i, l, h - l);' "$LIVEFIRE_DIR_NAME" 2>/dev/null)
  installed=${installed:-0} livefire=${livefire:-0} offenders=${offenders:-0}
  if [ "$installed" -eq 0 ]; then
    say "$title: guard not installed in any shard (${#files[@]} hits file(s)) -- 0 hits is NOT a clean result"
    warn "DATA-ROOT guard not installed in any vitest shard; 0 hits is NOT a clean result (t/64)"
  elif [ "$livefire" -eq 0 ]; then
    say "$title: livefire=0 across all shards -- the positive control didn't register, so 0 hits is NOT trustworthy"
    warn "DATA-ROOT guard live-fire positive control registered 0 hits across all vitest shards; the hit count can't be trusted (t/64)"
  else
    say "$title: livefire=$livefire, offender hits=$offenders, installs=$installed across ${#files[@]} shard file(s)"
  fi
  return 0
}

self_test() {
  local t fails=0 out
  t=$(mktemp -d)
  check() { # name, expected annotation count, command...
    local name="$1" want="$2"; shift 2
    out=$(GITHUB_STEP_SUMMARY="$t/sum" "$@"); local rc=$?
    local got; got=$(grep -c '^::warning::' <<<"$out")
    if [ "$rc" -eq 0 ] && [ "$got" -eq "$want" ]; then echo "PASS $name (warnings=$got)"; else echo "FAIL $name (rc=$rc warnings=$got want=$want)"; fails=$((fails+1)); fi
  }
  hdr() { tail -n +1 "$t/sum" | grep '^###' | tail -1; }
  me="$0"

  printf 'x\nDATA-ROOT-GUARD-INSTALLED mode=warn roots=["/d"]\n' > "$t/clean.log"
  check "shard: legacy log, installed, 0 hits -> quiet" 0 "$me" shard "$t/clean.log" 1
  hdr | grep -q ': 0 hits$' || { echo "FAIL header for clean"; fails=$((fails+1)); }

  printf 'nothing here\n' > "$t/none.log"
  check "shard: no marker -> loud" 1 "$me" shard "$t/none.log" 1
  check "shard: missing log -> loud" 1 "$me" shard "$t/absent.log" 1

  printf 'DATA-ROOT-GUARD-INSTALLED mode=warn roots=[]\nDATA-ROOT-TEST-WRITE op=writeFileSync target=/d/a protectedRoot=/d\nDATA-ROOT-TEST-WRITE op=writeFileSync target=/d/a protectedRoot=/d\n' > "$t/legacy-hits.log"
  check "shard: legacy per-hit lines -> 1 target listed" 1 "$me" shard "$t/legacy-hits.log" 1

  # The double count Shared Lib saw: per-hit console lines AND the teardown summary in one log.
  printf 'DATA-ROOT-GUARD-INSTALLED mode=warn roots=[]\nDATA-ROOT-TEST-WRITE op=writeFileSync target=/d/a protectedRoot=/d\nDATA-ROOT-TEST-WRITE op=mkdirSync target=/d/b protectedRoot=/d\n\nDATA-ROOT-GUARD-SUMMARY hits=5 unique=2 testFiles=1 livefire=0 hitsFile=/tmp/h.jsonl\nDATA-ROOT-TEST-WRITE count=3 op=writeFileSync target=/d/a protectedRoot=/d tests=p.test.ts\nDATA-ROOT-TEST-WRITE count=2 op=mkdirSync target=/d/b protectedRoot=/d tests=p.test.ts\nDATA-ROOT-GUARD-INSTALLED mode=warn roots=[]\n' > "$t/summary.log"
  check "shard: summary present -> only count= lines (2, not 4)" 2 "$me" shard "$t/summary.log" 2
  hdr | grep -q ': 2 target(s)$' || { echo "FAIL header count for summary"; fails=$((fails+1)); }
  grep -q 'DATA-ROOT-GUARD-SUMMARY hits=5' "$t/sum" || { echo "FAIL summary line not in step summary"; fails=$((fails+1)); }

  printf 'DATA-ROOT-GUARD-INSTALLED mode=warn roots=[]\nDATA-ROOT-GUARD-SUMMARY hits=0 unique=0 testFiles=0 livefire=0 hitsFile=/tmp/h\n' > "$t/sum-clean.log"
  check "shard: summary, 0 hits, livefire=0 in this shard -> quiet (livefire is cross-shard)" 0 "$me" shard "$t/sum-clean.log" 3

  printf 'DATA-ROOT-GUARD-INSTALLED mode=warn roots=[]\nDATA-ROOT-GUARD-SUMMARY guard not installed: no worker recorded DATA-ROOT-GUARD-INSTALLED in /tmp/h; 0 hits is NOT a clean result\n' > "$t/sum-noinst.log"
  check "shard: summary says not installed (console marker present) -> loud" 1 "$me" shard "$t/sum-noinst.log" 1

  mkdir -p "$t/lf-ok" "$t/lf-zero" "$t/lf-noinst" "$t/lf-empty"
  printf '{"kind":"installed","pid":1,"mode":"warn","roots":["/d"]}\n' > "$t/lf-ok/hits-1.jsonl"
  printf '{"kind":"installed","pid":2,"mode":"warn","roots":["/d"]}\n{"kind":"hit","pid":2,"op":"writeFileSync","target":"/d/__guard_livefire__/x","protectedRoot":"/d","test":"live.test.ts"}\n{"kind":"hit","pid":2,"op":"mkdirSync","target":"/d/real","protectedRoot":"/d","test":"p.test.ts"}\n' > "$t/lf-ok/hits-2.jsonl"
  printf '{"kind":"installed","pid":3,"mode":"warn","roots":["/d"]}\n' > "$t/lf-ok/hits-3.jsonl"
  check "livefire: control in one shard of three -> quiet" 0 "$me" livefire "$t/lf-ok"
  hdr | grep -q 'livefire=1, offender hits=1, installs=3' || { echo "FAIL livefire tally"; fails=$((fails+1)); }

  printf '{"kind":"installed","pid":1,"mode":"warn","roots":["/d"]}\n{"kind":"hit","pid":1,"op":"writeFileSync","target":"/d/not__guard_livefire__x","protectedRoot":"/d","test":"p.test.ts"}\n' > "$t/lf-zero/hits-1.jsonl"
  cp "$t/lf-ok/hits-3.jsonl" "$t/lf-zero/hits-3.jsonl"
  check "livefire: zero across shards (lookalike path not counted) -> loud" 1 "$me" livefire "$t/lf-zero"

  printf '{"kind":"hit","pid":1,"op":"x","target":"/d/__guard_livefire__/x","protectedRoot":"/d","test":"t"}\n' > "$t/lf-noinst/hits-1.jsonl"
  check "livefire: no install record -> loud" 1 "$me" livefire "$t/lf-noinst"

  check "livefire: no hits files -> loud (recording broke, t/65)" 1 "$me" livefire "$t/lf-empty"
  check "livefire: dir missing -> loud (download got nothing, t/65)" 1 "$me" livefire "$t/absent-dir"

  printf 'not json\n' > "$t/lf-empty/hits-1.jsonl"
  check "livefire: unparseable file -> loud (fails closed as not installed)" 1 "$me" livefire "$t/lf-empty"

  rm -rf "$t"
  [ "$fails" -eq 0 ] && echo "data-root-guard-report self-test: all passed" || echo "data-root-guard-report self-test: $fails failure(s)"
  return "$fails"
}

case "${1:-}" in
  shard) report_shard "${2:-}" "${3:-?}" ;;
  livefire) report_livefire "${2:-}" ;;
  --self-test) self_test; exit $? ;;
  *) echo "usage: $0 shard <log> <shard> | livefire <dir> | --self-test" >&2; exit 0 ;;
esac
exit 0
