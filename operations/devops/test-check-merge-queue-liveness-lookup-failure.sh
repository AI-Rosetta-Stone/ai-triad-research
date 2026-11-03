#!/usr/bin/env bash
# t/4567 SO arm 3 (e/380#3): a real, forced check-runs lookup failure (auth error, rate
# limit, truly-unresolvable commit) must report liveness-check-failed, never silently
# fold into "count=0, healthy." Shims `gh` so the GraphQL entries call succeeds (one
# AWAITING_CHECKS entry, aged past 15 minutes) but every check-runs lookup genuinely
# fails (simulating a 500/auth error, not the 404-on-nonexistent-commit case that a
# real GET correctly resolves to count=0 -- confirmed separately via a live lookup).
#
# Usage: test-check-merge-queue-liveness-lookup-failure.sh
# Exits 0 if liveness-check-failed is reported, 1 otherwise (with a diagnostic message).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

OLD_ENOUGH=$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)

cat > "$TMPDIR/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "graphql" ]; then
  echo '[{"position":1,"state":"AWAITING_CHECKS","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":"deadbeef00000000000000000000000000000000"},"pullRequest":{"number":999}}]'
  exit 0
fi
if [ "\$1" = "api" ]; then
  # Simulate a genuine lookup failure (auth/rate-limit/500), not a clean 404.
  echo "error: unexpected server error" >&2
  exit 1
fi
echo "unexpected gh invocation: \$*" >&2
exit 1
SHIM
chmod +x "$TMPDIR/gh"

OUTPUT=$(PATH="$TMPDIR:$PATH" "$SCRIPT_DIR/check-merge-queue-liveness.sh" "owner/repo" "main" 2>&1)

if ! echo "$OUTPUT" | grep -q '"kind": "liveness-check-failed"'; then
  echo "FAIL: expected a liveness-check-failed violation. Output:"
  echo "$OUTPUT"
  exit 1
fi

echo "PASS: a genuine check-runs lookup failure reports liveness-check-failed, not count=0."
