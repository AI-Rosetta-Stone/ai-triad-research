#!/bin/bash
# t/436 (TL p/9#318): run THREE CONCURRENT PUSHES of the real pre-push-checks.sh N times, in a scratch
# repo with a stub pnpm, and fail on the first run whose vitest runs overlap. The Pester test covers one
# run; this repeats the same scenario on the CI runner (50 consecutive runs must pass). Usage:
# t436-three-push-loop.sh [runs]. Exits 1 on an overlap, 0 when every run is clean.
N=${1:-50}
SRC=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d) || exit 1
mkdir -p "$W/stub"
cat > "$W/stub/pnpm" <<'STUB'
#!/bin/sh
# t/436: date +%s%N cut to ms, never %3N (uutils date drops the leading zeros before truncating).
now_ms() { _ns=$(date +%s%N); echo "${_ns%??????}"; }
case " $* " in
  *" vitest "*)
    echo "start $$ $(now_ms) $*" >>"$AITRIAD_TEST_LOG"
    sleep "${AITRIAD_TEST_VITEST_SECS:-2}"
    echo "end $$ $(now_ms)" >>"$AITRIAD_TEST_LOG"
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

export PATH="$W/stub:$PATH"
for i in $(seq 1 "$N"); do
  LOG="$W/vitest-$i.log"; : > "$LOG"
  export AITRIAD_PREPUSH_LOCK_DIR="$W/lock-$i" AITRIAD_TEST_LOG="$LOG" AITRIAD_TEST_VITEST_SECS=2
  for p in 1 2 3; do
    sh operations/devops/pre-push-checks.sh HEAD~1 HEAD > "$W/out-$i-$p.txt" 2>&1 &
  done
  wait
  overlap=$(awk '$1=="start"{s[$2]=$3} $1=="end"{e[$2]=$3; print s[$2], $3}' "$LOG" | sort -n | awk 'NR>1 && $1 < prevEnd {print "OVERLAP"; exit} {prevEnd=$2}')
  runs=$(grep -c '^start' "$LOG")
  if [ "$overlap" = "OVERLAP" ] || [ "$runs" -ne 3 ]; then
    echo "t436 three-push: FAILED on run $i of $N (vitest runs: $runs, overlap: ${overlap:-none})"
    for p in 1 2 3; do echo "--- push $p"; tail -n 20 "$W/out-$i-$p.txt"; done
    cat "$LOG"
    exit 1
  fi
  rm -rf "$W/lock-$i"
done
echo "t436 three-push: $N of $N consecutive runs clean (no overlap, 3 vitest runs each)."
rm -rf "$W"
exit 0
