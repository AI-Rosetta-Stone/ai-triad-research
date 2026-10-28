#!/usr/bin/env bash
# t/4567 SO F4 shim test (e/377#2): the live-fire arms can't force a count/position
# mismatch (it needs an actual GraphQL paging gap or duplicate-position data, which the
# real API won't produce on demand). This shims `gh` with a fake mergeQueue.entries
# response that OMITS position 2 -- simulating exactly that dropped-middle-entry shape --
# and asserts get-merge-group-prs.sh fails closed rather than silently reporting a
# "safe" 2-entry result for a 3-entry group.
#
# Usage: test-get-merge-group-prs-f4.sh
# Exits 0 if the fail-closed behavior is confirmed, 1 otherwise (with a diagnostic message).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ---- the shim: a fake `gh` that answers the one GraphQL query the script makes, with
# position 2 OMITTED (positions 1 and 3 only) -- a 3-entry group reporting as 2 entries. ----
cat > "$TMPDIR/gh" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '[{"position":1,"pullRequest":{"number":101,"labels":{"nodes":[]},"headRefOid":"aaa1111"}},{"position":3,"pullRequest":{"number":103,"labels":{"nodes":[]},"headRefOid":"ccc3333"}}]'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
SHIM
chmod +x "$TMPDIR/gh"

OUTPUT=""
EXIT_CODE=0
OUTPUT=$(PATH="$TMPDIR:$PATH" "$SCRIPT_DIR/get-merge-group-prs.sh" "owner/repo" "refs/heads/gh-readonly-queue/main/pr-103-ccc3333deadbeef" 2>&1) || EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 1 ]; then
  echo "FAIL: expected exit 1 (fail closed), got $EXIT_CODE. Output:"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "expected them equal"; then
  echo "FAIL: exited 1, but not for the F4 count==position reason. Output:"
  echo "$OUTPUT"
  exit 1
fi

echo "PASS: F4 fail-closed on a 2-of-3 count/position mismatch, via shimmed gh."
