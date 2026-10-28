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
  # Real gh, called with --jq '.total_count // 0', prints just the filtered NUMBER,
  # never the wrapping object -- this shim must match that, or K5's now-correct
  # numeric validation (SO e/392#6/#7) legitimately rejects the shim's OWN bug as if
  # it were the real script's.
  case "\$2" in
    *nonhead0000000000000000000000000000000*)
      echo "FAIL-SHIM: check-runs lookup called for the non-head entry's headSha -- the head-only gate did not short-circuit it." >&2
      echo '0'
      ;;
    *headcommit00000000000000000000000000000*)
      echo '1'
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

# ---- Scenario 2: SO K2 (e/392#2, HIGH) -- head = max position among AWAITING_CHECKS ----
# entries specifically, NOT max position over every entry. A top entry (position 5) sits
# QUEUED (beyond max_entries_to_build:4, or just-enqueued, not yet tested) while position 4
# is the one actually AWAITING_CHECKS and genuinely stale. Taking the raw max over all
# entries (the original arm-e fix) would silently disable (a) here: position 5 isn't
# AWAITING_CHECKS at all, so nothing would ever be flagged as head, and the real stall at
# position 4 would never alert -- exactly today's production stall shape.
TMPDIR2=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR2"' EXIT

cat > "$TMPDIR2/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "graphql" ]; then
  echo '[
    {"position":4,"state":"AWAITING_CHECKS","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":"stale4000000000000000000000000000000000"},"pullRequest":{"number":904}},
    {"position":5,"state":"QUEUED","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":null},"pullRequest":{"number":905}}
  ]'
  exit 0
fi
if [ "\$1" = "api" ]; then
  # Real gh --jq prints just the number, not the wrapping object -- see scenario 1's shim.
  case "\$2" in
    *stale4000000000000000000000000000000000*)
      echo '0'
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
chmod +x "$TMPDIR2/gh"

OUTPUT2=$(PATH="$TMPDIR2:$PATH" "$SCRIPT_DIR/check-merge-queue-liveness.sh" "owner/repo" "main" 2>&1)

FAIL2=0

if ! echo "$OUTPUT2" | grep -q '"number": 904'; then
  echo "FAIL: position 4 (stale AWAITING_CHECKS, the real head among awaiting entries) was NOT flagged -- a higher QUEUED position at 5 must not suppress it. Output:"
  echo "$OUTPUT2"
  FAIL2=1
fi

if ! echo "$OUTPUT2" | grep -q '"kind": "no-checks-started"'; then
  echo "FAIL: expected a no-checks-started violation for position 4. Output:"
  echo "$OUTPUT2"
  FAIL2=1
fi

if echo "$OUTPUT2" | grep -q '"number": 905'; then
  echo "FAIL: position 5 (QUEUED, not AWAITING_CHECKS) was flagged -- it should never be evaluated by (a)/(b) regardless of position. Output:"
  echo "$OUTPUT2"
  FAIL2=1
fi

if [ "$FAIL2" -ne 0 ]; then
  exit 1
fi

echo "PASS: a stale AWAITING_CHECKS entry below a higher QUEUED position still alerts (head = max position among AWAITING_CHECKS, not max position overall)."

# ---- Scenario 3: SO K5 (e/392#6/#7, HIGH) -- a missing `jq` binary must fail closed ----
# (liveness-check-failed), never silently produce malformed output. PATH is emptied
# entirely -- the script must detect jq's absence and exit before touching gh at all.
TMPDIR3=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR2" "$TMPDIR3"' EXIT

# Invoke via explicit `bash <script>`, NOT the script's own shebang -- `bash` is
# resolved via THIS (outer, unmodified) shell's PATH before the PATH=$TMPDIR3 prefix
# takes effect for the child process. Invoking the script file directly instead
# would rely on the kernel re-execing `/usr/bin/env bash`, and env itself would then
# try to resolve `bash` using the CHILD's (emptied) PATH and fail with exit 127 --
# a real failure hit live-fire, not a hypothetical (this comment exists because it
# broke CI once already).
OUTPUT3=$(PATH="$TMPDIR3" bash "$SCRIPT_DIR/check-merge-queue-liveness.sh" "owner/repo" "main" 2>&1)

if ! echo "$OUTPUT3" | grep -q '"kind": "liveness-check-failed"'; then
  echo "FAIL: a missing jq binary did not report liveness-check-failed. Output:"
  echo "$OUTPUT3"
  exit 1
fi

echo "PASS: a missing jq binary fails closed (liveness-check-failed), not silently."

# ---- Scenario 4: SO K5 (e/392#6/#7, HIGH) -- a non-numeric check-runs count (the real ----
# live-fire reproducer: a shim/response that ignores --jq and returns the raw JSON object
# instead of just the count) must report liveness-check-failed, NOT silently print `[]`
# (fail-open) by corrupting the later arithmetic. One context ("ci-gate") returns a raw
# JSON object; the others return clean integers.
TMPDIR4=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$TMPDIR2" "$TMPDIR3" "$TMPDIR4"' EXIT

cat > "$TMPDIR4/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "graphql" ]; then
  echo '[{"position":1,"state":"AWAITING_CHECKS","enqueuedAt":"${OLD_ENOUGH}","headCommit":{"oid":"badcount0000000000000000000000000000000"},"pullRequest":{"number":906}}]'
  exit 0
fi
if [ "\$1" = "api" ]; then
  case "\$2" in
    *check_name=ci-gate*)
      echo '{"total_count": 1}'   # the bug shape: ignores --jq, prints the raw object
      ;;
    *)
      echo '1'
      ;;
  esac
  exit 0
fi
echo "unexpected gh invocation: \$*" >&2
exit 1
SHIM
chmod +x "$TMPDIR4/gh"

OUTPUT4=$(PATH="$TMPDIR4:$PATH" "$SCRIPT_DIR/check-merge-queue-liveness.sh" "owner/repo" "main" 2>&1)

FAIL4=0

if ! echo "$OUTPUT4" | grep -q '"number": 906'; then
  echo "FAIL: a non-numeric check-runs count was not reported at all (silent fail-open). Output:"
  echo "$OUTPUT4"
  FAIL4=1
fi

if ! echo "$OUTPUT4" | grep -q '"kind": "liveness-check-failed"'; then
  echo "FAIL: a non-numeric check-runs count did not report liveness-check-failed -- it must not be silently absorbed into the CHECK_COUNT arithmetic. Output:"
  echo "$OUTPUT4"
  FAIL4=1
fi

if [ "$FAIL4" -ne 0 ]; then
  exit 1
fi

echo "PASS: a non-numeric check-runs count fails closed (liveness-check-failed), not fail-open (silently healthy)."
