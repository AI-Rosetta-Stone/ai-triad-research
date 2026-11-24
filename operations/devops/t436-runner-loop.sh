#!/bin/bash
# t/436 (TL t/436#18, p/9#439): ONE-OFF runner measurement. Removed before review; not for merge.
# Runs three concurrent pushes of the real pre-push-checks.sh N times in a scratch repo with a stub
# pnpm. The stub reads the clock ONCE per stamp and logs it in both formats:
#   col 3 (old)   = date +%s%3N          what the Pester test used before f9c06ef00
#   col 4 (fixed) = date +%s%N cut to ms what it uses now
# Overlap is judged separately with each column, per run and in total.
# Exit 1 when any run overlaps by the FIXED stamps or does not have 3 vitest runs (a real lock
# failure). An overlap by the old stamps alone is the date defect, and is counted and printed, not
# failed. Usage: t436-runner-loop.sh [runs]
N=${1:-50}
SRC=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d) || exit 1
echo "t436 runner loop: date --version: $(date --version 2>&1 | head -n 1)"
echo "t436 runner loop: date binary: $(readlink -f "$(command -v date)")"
echo "t436 runner loop: one clock read, both formats (%s%3N %s%N): $(date '+%s%3N %s%N')"

# Direct probe of the date defect, independent of the lock: one clock read, both formats, 2000 times.
probe_bad=0; probe_eg=""
for k in $(seq 1 2000); do
  set -- $(date '+%s%3N %s%N')
  if [ "$1" != "${2%??????}" ]; then probe_bad=$((probe_bad + 1)); [ -n "$probe_eg" ] || probe_eg="%s%3N=$1 %s%N=$2"; fi
done
echo "t436 runner loop: date probe: samples=2000 mismatches=$probe_bad ${probe_eg:+first: $probe_eg}"

mkdir -p "$W/stub"
cat > "$W/stub/pnpm" <<'STUB'
#!/bin/sh
stamp() { set -- $(date '+%s%3N %s%N'); echo "$1 ${2%??????}"; }
case " $* " in
  *" vitest "*)
    echo "start $$ $(stamp)" >>"$AITRIAD_TEST_LOG"
    sleep "${AITRIAD_TEST_VITEST_SECS:-2}"
    echo "end $$ $(stamp)" >>"$AITRIAD_TEST_LOG"
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$W/stub/pnpm"

R="$W/repo"
mkdir -p "$R/operations/devops" && cd "$R" || exit 1
git init -q -b main
cp "$SRC/pre-push-checks.sh" operations/devops/pre-push-checks.sh
cp "$SRC/Test-PowerShellSyntax.ps1" operations/devops/Test-PowerShellSyntax.ps1 2>/dev/null || echo "" > operations/devops/Test-PowerShellSyntax.ps1
echo scratch > README.md
git add -A && git -c user.email=t@x -c user.name=t commit -q -m base
mkdir -p taxonomy-editor/src taxonomy-editor/node_modules
echo 'export const a = 1;' > taxonomy-editor/src/a.ts
git add -A && git -c user.email=t@x -c user.name=t commit -q -m change

# Prints the number of adjacent run pairs that overlap, judged by stamp column $1.
overlaps() {
  awk -v c="$1" '$1=="start"{s[$2]=$c} $1=="end"{print s[$2], $c}' "$LOG" | sort -n |
    awk 'NR>1 && $1 < prevEnd {n++} {prevEnd=$2} END{print n+0}'
}

export PATH="$W/stub:$PATH"
old_runs=0; fixed_runs=0; short=0; mism=0; stamps=0
for i in $(seq 1 "$N"); do
  LOG="$W/vitest-$i.log"; : > "$LOG"
  export AITRIAD_PREPUSH_LOCK_DIR="$W/lock-$i" AITRIAD_TEST_LOG="$LOG" AITRIAD_TEST_VITEST_SECS=2
  for p in 1 2 3; do
    sh operations/devops/pre-push-checks.sh HEAD~1 HEAD > "$W/out-$i-$p.txt" 2>&1 &
  done
  wait
  runs=$(grep -c '^start' "$LOG")
  m=$(awk '$3 != $4' "$LOG" | wc -l); m=$((m + 0))
  o=$(overlaps 3); f=$(overlaps 4)
  stamps=$((stamps + $(wc -l < "$LOG"))); mism=$((mism + m))
  [ "$runs" -eq 3 ] || short=$((short + 1))
  [ "$o" -gt 0 ] && old_runs=$((old_runs + 1))
  [ "$f" -gt 0 ] && fixed_runs=$((fixed_runs + 1))
  echo "run $i of $N: vitest_runs=$runs overlap_old=$o overlap_fixed=$f stamp_mismatches=$m"
  if [ "$o" -gt 0 ] || [ "$f" -gt 0 ] || [ "$runs" -ne 3 ] || [ "$m" -gt 0 ]; then
    echo "  stamps (kind pid old fixed):"; sed 's/^/    /' "$LOG"
  fi
  if [ "$f" -gt 0 ] || [ "$runs" -ne 3 ]; then
    for p in 1 2 3; do echo "  --- push $p"; tail -n 12 "$W/out-$i-$p.txt" | sed 's/^/    /'; done
  fi
  rm -rf "$W/lock-$i"
done
echo "t436 runner loop TOTAL: runs=$N stamps=$stamps stamp_mismatches=$mism runs_without_3_vitest=$short"
echo "t436 runner loop TOTAL: runs_overlapping_by_old_stamps(%s%3N)=$old_runs runs_overlapping_by_fixed_stamps(%s%N)=$fixed_runs"
rm -rf "$W"
if [ "$fixed_runs" -gt 0 ] || [ "$short" -gt 0 ]; then
  echo "t436 runner loop: FAILED (a real overlap by the fixed stamps, or a run without 3 vitest runs)."
  exit 1
fi
echo "t436 runner loop: PASSED ($N of $N runs serialized by the fixed stamps)."
exit 0
