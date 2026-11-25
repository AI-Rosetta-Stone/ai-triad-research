#!/usr/bin/env bash
# t/562: get-merge-group-prs.sh on a rate-limit error waits for the reset when it is within 15 min
# and retries ONCE; otherwise it fails closed with the reset time. Other errors: a 5xx keeps the
# short backoff, a permission 403 fails at once. A shimmed `gh` plays a scripted sequence of
# answers for the mergeQueue query; `gh api rate_limit` answers from RL_PROBE. RL_SLEEP records
# every sleep instead of sleeping; RL_NOW fixes the clock.
#
# Usage: test-get-merge-group-prs-ratelimit.sh
# Exits 0 when every arm holds, 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

NOW=1795600000
OK_JSON='[{"position":1,"pullRequest":{"number":101,"labels":{"nodes":[]},"headRefOid":"aaa1111"}}]'
REF="refs/heads/gh-readonly-queue/main/pr-101-aaa1111deadbeef"

# The shim: each mergeQueue query consumes the next line of $TMP/seq:
#   ok | ratelimit | 5xx | 403 ; the rate_limit probe prints $RL_PROBE (or fails when it is 'fail').
cat > "$TMP/gh" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then
  echo "probe" >> "$TMP_DIR/calls"
  [ "$RL_PROBE" = "fail" ] && { echo "gh: HTTP 502" >&2; exit 1; }
  echo "$RL_PROBE"; exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  n=$(wc -l < "$TMP_DIR/calls" 2>/dev/null || echo 0)
  echo "query" >> "$TMP_DIR/calls"
  q=$(grep -c '^query$' "$TMP_DIR/calls")
  step=$(sed -n "${q}p" "$TMP_DIR/seq")
  case "$step" in
    ok) echo "$OK_JSON"; exit 0 ;;
    ratelimit) echo "gh: API rate limit already exceeded for site ID installation." >&2; exit 1 ;;
    5xx) echo "gh: HTTP 502: Bad Gateway" >&2; exit 1 ;;
    403) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;
    *) echo "shim: no step $q" >&2; exit 1 ;;
  esac
fi
echo "unexpected gh invocation: $*" >&2
exit 1
SHIM
chmod +x "$TMP/gh"
cat > "$TMP/sleeprec" <<'REC'
#!/usr/bin/env bash
echo "$1" >> "$TMP_DIR/sleeps"
REC
chmod +x "$TMP/sleeprec"

fail=0
# run <name> <expected exit> <seq...> ; sets OUT, SLEEPS, CALLS
run() {
  local name="$1" want="$2"; shift 2
  rm -f "$TMP/calls" "$TMP/sleeps"; : > "$TMP/calls"; : > "$TMP/sleeps"
  printf '%s\n' "$@" > "$TMP/seq"
  local code=0
  OUT=$(TMP_DIR="$TMP" OK_JSON="$OK_JSON" RL_PROBE="$RL_PROBE" RL_NOW="$NOW" RL_SLEEP="$TMP/sleeprec" \
        PATH="$TMP:$PATH" "$SCRIPT_DIR/get-merge-group-prs.sh" "owner/repo" "$REF" 2>&1) || code=$?
  SLEEPS=$(tr '\n' ' ' < "$TMP/sleeps")
  CALLS=$(tr '\n' ' ' < "$TMP/calls")
  if [ "$code" -ne "$want" ]; then
    echo "FAIL [$name]: expected exit $want, got $code. Output: $OUT"; fail=1; return 1
  fi
  return 0
}
expect() { if ! eval "$2"; then echo "FAIL [$1]: $3 (sleeps='$SLEEPS' calls='$CALLS') Output: $OUT"; fail=1; fi; }

# 1. rate limit, reset in 120 s -> waits 125 s, retries once, passes.
RL_PROBE="0 $((NOW + 120))"
if run "ratelimit-then-ok" 0 ratelimit ok; then
  expect "ratelimit-then-ok" '[ "$SLEEPS" = "125 " ]' "should sleep exactly reset+5-now = 125s, once"
  expect "ratelimit-then-ok" 'echo "$OUT" | grep -q "waiting 125s for the rate-limit reset"' "should WARN the wait"
  expect "ratelimit-then-ok" 'echo "$OUT" | grep -qE "\"number\": ?101"' "should print the entries"
fi

# 2. rate limit, then rate limit again -> waits once, then fails closed with the reset time.
RL_PROBE="0 $((NOW + 120))"
if run "ratelimit-twice" 1 ratelimit ratelimit; then
  expect "ratelimit-twice" '[ "$SLEEPS" = "125 " ]' "should wait exactly once"
  expect "ratelimit-twice" 'echo "$OUT" | grep -q "still rate-limited after waiting"' "should say it waited"
  expect "ratelimit-twice" 'echo "$OUT" | grep -qE "resets [0-9]{4}-[0-9]{2}-[0-9]{2}T"' "should name the reset time"
  expect "ratelimit-twice" '[ "$(echo "$CALLS" | grep -o query | wc -l)" -eq 2 ]' "should query exactly twice"
fi

# 3. rate limit, reset 40 min away -> fails closed at once, no sleep.
RL_PROBE="0 $((NOW + 2400))"
if run "reset-too-far" 1 ratelimit ok; then
  expect "reset-too-far" '[ -z "$SLEEPS" ]' "should not sleep"
  expect "reset-too-far" 'echo "$OUT" | grep -q "more than the 900s this guard waits"' "should say why"
  expect "reset-too-far" '[ "$(echo "$CALLS" | grep -o query | wc -l)" -eq 1 ]' "should not retry"
fi

# 4. a 5xx -> short backoff (3 s), then success.
RL_PROBE="4000 $((NOW + 120))"
if run "5xx-then-ok" 0 5xx ok; then
  expect "5xx-then-ok" '[ "$SLEEPS" = "3 " ]' "should back off 3s"
  expect "5xx-then-ok" '! echo "$CALLS" | grep -q probe' "a 5xx needs no rate_limit probe"
fi
# 4b. three 5xx -> fails closed after 3 attempts, with 3 s and 6 s backoff.
if run "5xx-thrice" 1 5xx 5xx 5xx; then
  expect "5xx-thrice" '[ "$SLEEPS" = "3 6 " ]' "should back off 3s then 6s"
  expect "5xx-thrice" 'echo "$OUT" | grep -q "after 3 attempts"' "should fail closed after 3"
fi

# 5. a permission 403 with quota left -> fails fast, no sleep, no retry.
RL_PROBE="4000 $((NOW + 120))"
if run "permission-403" 1 403 ok; then
  expect "permission-403" '[ -z "$SLEEPS" ]' "should not sleep"
  expect "permission-403" 'echo "$OUT" | grep -q "not a rate limit"' "should say it is not a rate limit"
  expect "permission-403" '[ "$(echo "$CALLS" | grep -o query | wc -l)" -eq 1 ]' "should not retry"
fi

# 6. rate limit, and the probe itself fails -> fails closed (the wait cannot be bounded).
RL_PROBE="fail"
if run "probe-fails" 1 ratelimit ok; then
  expect "probe-fails" '[ -z "$SLEEPS" ]' "should not sleep"
  expect "probe-fails" 'echo "$OUT" | grep -q "rate_limit probe could not be read"' "should say why"
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "PASS: rate limit waits <=15 min and retries once; a second limit or a far reset fails closed with the reset time; 5xx backs off; a permission 403 fails fast; an unreadable probe fails closed."
