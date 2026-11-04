#!/bin/sh
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# check-vitest-shard-blobs.sh <blob-dir> <expected-count>
#
# Used by ci.yml's test-electron-coverage job before `vitest --merge-reports`. Exits 1 with
# an ::error:: annotation unless EXACTLY <expected-count> blob-*.json files are in <blob-dir>:
# a missing shard would quietly lower merged coverage and drop that shard's tests from the
# result, and an extra one means stale or duplicated reports. A missing directory counts as 0.
# Tested by test-check-vitest-shard-blobs.sh (all arms, including fewer than expected).

DIR=$1
EXPECTED=$2
case "$EXPECTED" in
  ''|*[!0-9]*) echo "::error::check-vitest-shard-blobs: usage: $0 <blob-dir> <expected-count> (got expected='$EXPECTED')"; exit 2 ;;
esac

if [ -d "$DIR" ]; then
  COUNT=$(find "$DIR" -maxdepth 1 -name 'blob-*.json' | wc -l | tr -d ' ')
else
  COUNT=0
fi

if [ "$COUNT" -ne "$EXPECTED" ]; then
  echo "::error::test-electron-coverage: expected $EXPECTED vitest shard blobs, found $COUNT -- a shard failed to produce its report, so merged coverage would be incomplete. See test-electron-vitest."
  exit 1
fi
echo "test-electron-coverage: all $EXPECTED vitest shard blobs present."
exit 0
