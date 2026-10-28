#!/usr/bin/env bash
# t/4567 HEADGREEN arm (e) (SO's point, TL p/331#2495): under HEADGREEN + merge_group
# concurrency-cancel, a non-head entry's merge_group run is EXPECTED to be
# cancelled/never-started once a newer, larger group supersedes it. Conditions (a)
# "no-checks-started" and (b) "awaiting-checks-stale" must NOT fire on a non-head entry
# for that reason alone, or every healthy multi-entry batch would false-alarm. They must
# still fire on the HEAD entry (the one whose group gates the whole batch) when it is
# genuinely stale -- the restriction must not silently disable the check altogether.
#
# Two queue entries, both old enough to trip both thresholds by age alone:
#   - position 1 (non-head): 0 check-runs recorded -- old logic would report
#     "no-checks-started"; the fix must report NOTHING for this PR.
#   - position 2 (head, max position): check-runs exist but haven't finished -- the fix
#     must still report "awaiting-checks-stale" for this PR, proving the head entry is
#     still checked.
#
# Usage: test-check-merge-queue-liveness-headgreen.sh
# Exits 0 if both expectations hold, 1 otherwise (with a diagnostic message).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

OLD_ENOUGH=$(date -u -d '90 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-90M +%Y-%m-%dT%H:%M:%SZ)

cat > "$TMPDIR/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "graphql" ]; then
  echo '[
    {"position":1,"state":"AWAITING_CHECKS","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":"nonhead0000000000000000000000000000000"},"pullRequest":{"number":901}},
    {"position":2,"state":"AWAITING_CHECKS","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":"headcommit00000000000000000000000000000"},"pullRequest":{"number":902}}
  ]'
  exit 0
fi
if [ "\$1" = "api" ]; then
  case "\$2" in
    *nonhead0000000000000000000000000000000*)
      echo "FAIL-SHIM: check-runs lookup called for the non-head entry's headSha -- the head-only gate did not short-circuit it." >&2
      echo '{"total_count": 0}'
      ;;
    *headcommit00000000000000000000000000000*)
      echo '{"total_count": 1}'
      ;;
    *)
      echo "unexpected check-runs lookup: \$2" >&2
      exit 1
      ;;
  esac
  exit 0
fi
echo "unexpected gh invocation: \$*" >&2
exit 1
SHIM
chmod +x "$TMPDIR/gh"

OUTPUT=$(PATH="$TMPDIR:$PATH" "$SCRIPT_DIR/check-merge-queue-liveness.sh" "owner/repo" "main" 2>&1)

FAIL=0

if echo "$OUTPUT" | grep -q '"number": 901'; then
  echo "FAIL: non-head entry (PR #901) was flagged -- expected it to be silently skipped under HEADGREEN. Output:"
  echo "$OUTPUT"
  FAIL=1
fi

if ! echo "$OUTPUT" | grep -q '"number": 902'; then
  echo "FAIL: head entry (PR #902) was NOT flagged despite being genuinely stale -- the head-only restriction must not disable the check entirely. Output:"
  echo "$OUTPUT"
  FAIL=1
fi

if ! echo "$OUTPUT" | grep -q '"kind": "awaiting-checks-stale"'; then
  echo "FAIL: expected an awaiting-checks-stale violation for the head entry. Output:"
  echo "$OUTPUT"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS: a non-head entry is silently skipped under HEADGREEN; a genuinely stale HEAD entry still alerts."
