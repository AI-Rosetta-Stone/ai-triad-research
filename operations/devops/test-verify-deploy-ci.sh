#!/usr/bin/env bash
# t/591: verify-deploy-ci.sh with a shimmed `gh`. Each case writes a small fixture directory:
#   commits    the SHAs `commits?sha=` returns (newest first)
#   runs.<sha> lines id|event|status|conclusion|branch (newest first), as the script's --jq emits them
#   job.<id>   test-container's conclusion for that run
#   fail       optional: a scripted sequence of failures for API reads (one token per read:
#              ok | ratelimit | 5xx | 403)
#   probe      what `gh api rate_limit` prints ("<remaining> <reset>"), or "fail"
# RL_SLEEP records sleeps; RL_NOW fixes the clock; RUN_WATCH is a no-op that marks the run done.
# Usage: test-verify-deploy-ci.sh ; exit 0 when every arm holds.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
NOW=1795600000
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cat > "$TMP/gh" <<'SHIM'
#!/usr/bin/env bash
F="$FIX"
if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then
  p=$(cat "$F/probe" 2>/dev/null || echo "4000 0"); [ "$p" = "fail" ] && exit 1; echo "$p"; exit 0
fi
if [ "$1" = "api" ]; then
  n=$( (cat "$F/.reads" 2>/dev/null || echo 0) ); n=$((n + 1)); echo "$n" > "$F/.reads"
  tok=$(sed -n "${n}p" "$F/fail" 2>/dev/null || true)
  case "$tok" in
    ratelimit) echo "gh: API rate limit exceeded for installation. (HTTP 403)" >&2; exit 1 ;;
    5xx) echo "gh: HTTP 502: Bad Gateway" >&2; exit 1 ;;
    403) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;
  esac
  url=""; for a in "$@"; do case "$a" in repos/*) url="$a" ;; esac; done
  case "$url" in
    *"/commits?sha="*) cat "$F/commits"; exit 0 ;;
    *"/workflows/ci.yml/runs?head_sha="*) s=${url##*head_sha=}; s=${s%%&*}; cat "$F/runs.$s" 2>/dev/null || true; exit 0 ;;
    *"/actions/runs/"*"/jobs"*) id=${url#*/actions/runs/}; id=${id%%/*}; cat "$F/job.$id" 2>/dev/null || true; exit 0 ;;
  esac
fi
echo "shim: unexpected gh $*" >&2; exit 1
SHIM
chmod +x "$TMP/gh"
cat > "$TMP/sleeprec" <<'REC'
#!/usr/bin/env bash
echo "$1" >> "$FIX/.sleeps"
REC
chmod +x "$TMP/sleeprec"
cat > "$TMP/watch" <<'W'
#!/usr/bin/env bash
echo "$1" >> "$FIX/.watched"
[ -f "$FIX/job.$1.after" ] && cp "$FIX/job.$1.after" "$FIX/job.$1"
exit 0
W
chmod +x "$TMP/watch"

fail=0
# setup <name> : fresh fixture dir in $FIX
setup() { FIX="$TMP/$1"; mkdir -p "$FIX"; echo "$SHA" > "$FIX/commits"; : > "$FIX/.sleeps"; }
run() { # <expected exit>
  local code=0
  OUT=$(FIX="$FIX" PATH="$TMP:$PATH" DEPLOY_SHA="$SHA" GH_REPO=o/r RL_NOW="$NOW" RL_SLEEP="$TMP/sleeprec" RUN_WATCH="$TMP/watch" \
        bash "$SCRIPT_DIR/verify-deploy-ci.sh" 2>&1) || code=$?
  SLEEPS=$(tr '\n' ' ' < "$FIX/.sleeps" 2>/dev/null || true)
  if [ "$code" -ne "$1" ]; then echo "FAIL [$CASE]: expected exit $1, got $code. Output: $OUT"; fail=1; return 1; fi
}
ok() { if ! eval "$1"; then echo "FAIL [$CASE]: $2 (sleeps='$SLEEPS') Output: $OUT"; fail=1; fi; }
row() { printf '%s|%s|%s|%s|%s\n' "$@"; }

# 1. THE INCIDENT: the newest run is a queued pull_request run; an older workflow_dispatch run is green -> pass.
CASE=incident; setup $CASE
{ row 902 pull_request queued "" hotfix/t579; row 901 pull_request queued "" hotfix/t579; row 900 workflow_dispatch completed success hotfix/t579; } > "$FIX/runs.$SHA"
echo success > "$FIX/job.900"
if run 0; then
  ok 'echo "$OUT" | grep -q "test-container: success in CI run 900 (workflow_dispatch"' "should pass on the green dispatch run"
  ok '[ ! -f "$FIX/.watched" ]' "should not wait for the queued pull_request runs"
fi

# 2. A green pull_request run alone never counts -> blocked, listing the runs.
CASE=pr-only; setup $CASE
row 910 pull_request completed success feat/x > "$FIX/runs.$SHA"; echo success > "$FIX/job.910"
if run 1; then ok 'echo "$OUT" | grep -q "from a trusted event" && echo "$OUT" | grep -q "910:pull_request:completed:success"' "should refuse, naming the runs"; fi

# 3. Push to main green -> pass; a push on another branch does not count.
CASE=push-main; setup $CASE
{ row 921 push completed success feat/y; row 920 push completed success main; } > "$FIX/runs.$SHA"
echo success > "$FIX/job.921"; echo success > "$FIX/job.920"
if run 0; then ok 'echo "$OUT" | grep -q "CI run 920 (push on main)"' "should use the main push, not the feature-branch push"; fi

# 4. test-container skipped (no container-relevant change) counts as passed, as before.
CASE=skipped; setup $CASE
row 930 merge_group completed success gh-readonly-queue/main/pr-1-x > "$FIX/runs.$SHA"; echo skipped > "$FIX/job.930"
run 0 || true

# 5. Every trusted run failed test-container -> blocked (fail closed).
CASE=all-red; setup $CASE
row 940 push completed failure main > "$FIX/runs.$SHA"; echo failure > "$FIX/job.940"
if run 1; then ok 'echo "$OUT" | grep -q "No completed green CI run"' "should block"; fi

# 6. Only a trusted run in progress -> wait for it, then judge it (green after the wait -> pass).
CASE=wait-then-green; setup $CASE
row 950 push in_progress "" main > "$FIX/runs.$SHA"; echo success > "$FIX/job.950.after"
if run 0; then ok 'grep -q "^950$" "$FIX/.watched"' "should watch run 950"; fi

# 7. Docs-only commit: no runs on the SHA -> the nearest ancestor with runs is judged.
CASE=docs-only; setup $CASE
ANC=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 960 push completed success main > "$FIX/runs.$ANC"; echo success > "$FIX/job.960"
if run 0; then ok 'echo "$OUT" | grep -q "Judging ancestor $ANC"' "should judge the ancestor"; fi

# 8. A rate-limit 403 with the reset 2 min away -> waits 125 s once, retries, passes; never "CI failed".
CASE=ratelimit-wait; setup $CASE
row 970 push completed success main > "$FIX/runs.$SHA"; echo success > "$FIX/job.970"
printf 'ratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 120))" > "$FIX/probe"
if run 0; then ok '[ "$SLEEPS" = "125 " ]' "should sleep 125s once"; ok 'echo "$OUT" | grep -q "waiting 125s for the rate-limit reset"' "should WARN the wait"; fi

# 9. THE INCIDENT'S OTHER HALF: a rate-limit 403 whose reset is far -> "cannot verify CI (rate limit, resets at ...)", not "CI failed".
CASE=ratelimit-far; setup $CASE
row 980 push completed success main > "$FIX/runs.$SHA"; echo success > "$FIX/job.980"
printf 'ratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 3000))" > "$FIX/probe"
if run 1; then
  ok 'echo "$OUT" | grep -q "cannot verify CI (rate limit, resets at 20"' "should say cannot verify, naming the reset"
  ok '! echo "$OUT" | grep -qi "failed. Deploy blocked until CI passes\|CI run .* failed"' "must not call it a CI failure"
  ok '[ -z "$SLEEPS" ]' "should not sleep"
fi

# 10. A rate limit, then a second one after the wait -> cannot verify (waits once only).
CASE=ratelimit-twice; setup $CASE
row 990 push completed success main > "$FIX/runs.$SHA"
printf 'ratelimit\nratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 60))" > "$FIX/probe"
if run 1; then ok '[ "$SLEEPS" = "65 " ]' "should wait exactly once"; ok 'echo "$OUT" | grep -q "cannot verify CI (rate limit"' "should say cannot verify"; fi

# 11. A permission 403 with quota left -> cannot verify at once (no wait, no retry).
CASE=perm-403; setup $CASE
printf '403\n' > "$FIX/fail"; echo "4000 $((NOW + 60))" > "$FIX/probe"
if run 1; then ok 'echo "$OUT" | grep -q "refused a read with quota left"' "should name the refusal"; ok '[ -z "$SLEEPS" ]' "no sleep"; fi

# 12. Three 5xx -> cannot verify after 3 attempts (3 s, 6 s backoff), never "CI failed".
CASE=5xx; setup $CASE
printf '5xx\n5xx\n5xx\n' > "$FIX/fail"
if run 1; then ok '[ "$SLEEPS" = "3 6 " ]' "should back off 3 then 6"; ok 'echo "$OUT" | grep -q "cannot verify CI (API error after 3 attempts"' "should say cannot verify"; fi

# 13. No CI run on the SHA or any ancestor -> blocked (unchanged message).
CASE=no-runs; setup $CASE
if run 1; then ok 'echo "$OUT" | grep -q "No CI run found for commit"' "unchanged no-run message"; fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "PASS: trusted green run wins over a newer queued pull_request run (the incident); PR runs never count; rate limit waits once or says 'cannot verify', never 'CI failed'; skipped, docs-only, wait-for-in-progress and fail-closed arms hold."
