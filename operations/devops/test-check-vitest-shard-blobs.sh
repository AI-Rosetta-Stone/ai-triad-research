#!/bin/sh
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# Arms for check-vitest-shard-blobs.sh. The "fewer than 3 blobs" path is the one that
# protects merged coverage, and it had never been exercised (it only runs when a shard
# fails to upload). Run: sh operations/devops/test-check-vitest-shard-blobs.sh

HERE=$(cd "$(dirname "$0")" && pwd)
CHECK="$HERE/check-vitest-shard-blobs.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0

# arm <name> <expected-exit> <blob-count|missing> [extra-file...]
arm() {
  name=$1; want=$2; n=$3; shift 3
  d="$WORK/$name"
  if [ "$n" != missing ]; then
    mkdir -p "$d"
    i=1; while [ "$i" -le "$n" ]; do : > "$d/blob-$i.json"; i=$((i + 1)); done
    for extra in "$@"; do : > "$d/$extra"; done
  fi
  out=$(sh "$CHECK" "$d" 3 2>&1); rc=$?
  if [ "$rc" -eq "$want" ]; then pass=$((pass + 1)); echo "ok   $name (exit $rc)"
  else fail=$((fail + 1)); echo "FAIL $name: want exit $want, got $rc: $out"; fi
  if [ "$want" -eq 1 ]; then
    case "$out" in *"::error::"*"found"*) ;; *) fail=$((fail + 1)); echo "FAIL $name: no ::error:: annotation: $out" ;; esac
  fi
}

arm all-three           0 3
arm two-of-three        1 2
arm one-of-three        1 1
arm none                1 0
arm dir-missing         1 missing
arm four-blobs          1 4
arm non-blob-files-ignored 1 2 coverage.json blob-notes.txt

out=$(sh "$CHECK" "$WORK/x" abc 2>&1); rc=$?
if [ "$rc" -eq 2 ]; then pass=$((pass + 1)); echo "ok   bad-expected (exit 2)"
else fail=$((fail + 1)); echo "FAIL bad-expected: want exit 2, got $rc"; fi

echo "# pass $pass fail $fail"
# Floor: a broken harness that runs no arms must not pass.
[ "$pass" -ge 8 ] && [ "$fail" -eq 0 ]
