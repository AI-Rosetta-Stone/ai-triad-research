#!/usr/bin/env bash
# t/422#20a (SO t/422#41): get-merge-group-prs.sh must EXIT 3 (ejected, non-success) when this
# batch's own entry is absent and head_sha is given, and must still exit 1 when head_sha is not
# given. Exit 0 would pass required contexts; this asserts it never does.
# A shimmed `gh` returns a queue that does not contain PR #103 (positions 1 and 2 only).
#
# Usage: test-get-merge-group-prs-ejected.sh
# Exits 0 when both arms hold, 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/gh" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '[{"position":1,"pullRequest":{"number":101,"labels":{"nodes":[]},"headRefOid":"aaa1111"}},{"position":2,"pullRequest":{"number":102,"labels":{"nodes":[]},"headRefOid":"bbb2222"}}]'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
SHIM
chmod +x "$TMPDIR/gh"

REF="refs/heads/gh-readonly-queue/main/pr-103-ccc3333deadbeef"
SHA="ccc3333deadbeef"

EXIT_WITH=0
OUT_WITH=$(PATH="$TMPDIR:$PATH" "$SCRIPT_DIR/get-merge-group-prs.sh" "owner/repo" "$REF" "$SHA" 2>&1) || EXIT_WITH=$?
if [ "$EXIT_WITH" -ne 3 ]; then
  echo "FAIL: with head_sha, expected exit 3 (EJECTED), got $EXIT_WITH. Output:"
  echo "$OUT_WITH"
  exit 1
fi
if ! echo "$OUT_WITH" | grep -q "EJECTED"; then
  echo "FAIL: exit 3 without the EJECTED log line. Output:"
  echo "$OUT_WITH"
  exit 1
fi

EXIT_WITHOUT=0
OUT_WITHOUT=$(PATH="$TMPDIR:$PATH" "$SCRIPT_DIR/get-merge-group-prs.sh" "owner/repo" "$REF" 2>&1) || EXIT_WITHOUT=$?
if [ "$EXIT_WITHOUT" -ne 1 ]; then
  echo "FAIL: without head_sha, expected exit 1 (fail closed), got $EXIT_WITHOUT. Output:"
  echo "$OUT_WITHOUT"
  exit 1
fi

echo "PASS: absent entry exits 3 (EJECTED) with head_sha, and 1 without it."
