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
    *"/commits/"*) cat "$F/fullsha"; exit 0 ;;   # t/754: the short-SHA expansion
    *"/workflows/ci.yml/runs?head_sha="*) s=${url##*head_sha=}; s=${s%%&*}; cat "$F/runs.$s" 2>/dev/null || true; exit 0 ;;
    *"/actions/runs/"*"/jobs"*) id=${url#*/actions/runs/}; id=${id%%/*}; cat "$F/job.$id" 2>/dev/null || true; exit 0 ;;
    *"/compare/"*) cat "$F/compare" 2>/dev/null || echo 0; exit 0 ;;
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
  # Per-case overrides (t/754): RUN_SHA (the SHA passed in), WATCH_CMD (the watch stand-in), WHAT (VERIFY_RERUN_WHAT).
  OUT=$(FIX="$FIX" PATH="$TMP:$PATH" DEPLOY_SHA="${RUN_SHA:-$SHA}" GH_REPO=o/r RL_NOW="$NOW" RL_SLEEP="$TMP/sleeprec" RUN_WATCH="${WATCH_CMD:-$TMP/watch}" VERIFY_RERUN_WHAT="${WHAT:-}" \
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

# 4. t/599 (SO p/273#4, #6): test-container SKIPPED counts only from a push to main. Its paths filter is
#    main's ci.yml; a merge_group, workflow_dispatch or epic/** run judges with its own ref's ci.yml.
CASE=skipped-push-main; setup $CASE
row 930 push completed success main > "$FIX/runs.$SHA"; echo skipped > "$FIX/job.930"
if run 0; then ok 'echo "$OUT" | grep -q "test-container: skipped in CI run 930 (push on main)"' "a main push's skip should count"; fi

for ev in "merge_group gh-readonly-queue/main/pr-1-x" "workflow_dispatch feat/z" "push epic/big"; do
  set -- $ev
  CASE="skipped-$1-not-counted"; setup "$CASE"
  row 931 "$1" completed success "$2" > "$FIX/runs.$SHA"; echo skipped > "$FIX/job.931"
  if run 1; then
    ok 'echo "$OUT" | grep -q "skipped in CI run 931 .*not counted: only a push to main"' "a $1 skip must not count, and must say why"
    ok 'echo "$OUT" | grep -q "No completed green CI run"' "a $1 skip alone must block"
  fi
done

# 4b. A dispatch skip next to a green dispatch success: the success still passes (skip ignored, not fatal).
CASE=skipped-then-success; setup $CASE
{ row 933 workflow_dispatch completed success feat/z; row 932 workflow_dispatch completed success feat/z; } > "$FIX/runs.$SHA"
echo skipped > "$FIX/job.933"; echo success > "$FIX/job.932"
if run 0; then ok 'echo "$OUT" | grep -q "test-container: success in CI run 932"' "the success should pass despite the newer skip"; fi

# 4c. The wait path judges skip the same way: a running dispatch that ends skipped blocks; a main push passes.
CASE=wait-dispatch-skipped; setup $CASE
row 934 workflow_dispatch in_progress "" feat/z > "$FIX/runs.$SHA"; echo skipped > "$FIX/job.934.after"
if run 1; then ok 'echo "$OUT" | grep -q "finished with test-container .skipped., and only a push to main.s skip counts"' "a dispatch skip after the wait must block"; fi
CASE=wait-main-skipped; setup $CASE
row 935 push in_progress "" main > "$FIX/runs.$SHA"; echo skipped > "$FIX/job.935.after"
if run 0; then ok 'grep -q "^935$" "$FIX/.watched"' "should watch run 935 and pass on the main push skip"; fi

# 5. Every trusted run failed test-container -> blocked (fail closed).
CASE=all-red; setup $CASE
row 940 push completed failure main > "$FIX/runs.$SHA"; echo failure > "$FIX/job.940"
if run 1; then ok 'echo "$OUT" | grep -q "No completed green CI run"' "should block"; fi

# 6. Only a trusted run in progress -> wait for it, then judge it (green after the wait -> pass).
CASE=wait-then-green; setup $CASE
row 950 push in_progress "" main > "$FIX/runs.$SHA"; echo success > "$FIX/job.950.after"
if run 0; then ok 'grep -q "^950$" "$FIX/.watched"' "should watch run 950"; fi

# 7. Docs-only commit: no runs on the SHA, and the compare since the ancestor touches only paths-ignore -> the ancestor is judged.
CASE=docs-only; setup $CASE
ANC=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 960 push completed success main > "$FIX/runs.$ANC"; echo success > "$FIX/job.960"
printf '3\nREADME.md\ndocs/guide/a.txt\ndeploy/azure/runbooks/r.ps1\n' > "$FIX/compare"
if run 0; then ok 'echo "$OUT" | grep -q "all ignored by ci.yml (docs-only). Judging ancestor $ANC"' "should judge the ancestor"; fi

# 7b. THE 8726893f CASE (DeployAzure t/591#5): no CI on the SHA, and the commits since the green ancestor change code -> blocked with the fix.
CASE=no-ci-code-change; setup $CASE
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 961 push completed success main > "$FIX/runs.$ANC"; echo success > "$FIX/job.961"
printf '2\ndocs/a.md\nlib/oped/x.ts\n' > "$FIX/compare"
if run 1; then
  ok 'echo "$OUT" | grep -q "no CI on $SHA: the commits since $ANC .*lib/oped/x.ts"' "should block, naming the code file"
  ok 'echo "$OUT" | grep -q "Dispatch ci.yml on a branch whose head is $SHA"' "should say how to fix"
  ok '! echo "$OUT" | grep -q "passed for this commit"' "must not pass on the parent's green"
fi

# 7g. A rename of a code file into docs/ (Lead p/233#126): the shim emits filename then previous_filename,
#     as the script's jq does. One file, two paths; the old path is code -> blocked.
CASE=rename-into-docs; setup $CASE
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 962 push completed success main > "$FIX/runs.$ANC"; echo success > "$FIX/job.962"
printf '1\ndocs/x.ts\nlib/oped/x.ts\n' > "$FIX/compare"
if run 1; then ok 'echo "$OUT" | grep -q "no CI on $SHA: the commits since $ANC .*lib/oped/x.ts"' "should block a rename out of code"; fi
# The shim does not run jq, so pin the script's jq expression itself (not the comment).
if ! grep -qF '.files[] | .filename, (.previous_filename // empty)' "$SCRIPT_DIR/verify-deploy-ci.sh"; then echo "FAIL [$CASE]: the script's compare jq does not read previous_filename"; fail=1; fi

# 7c. A truncated compare (GitHub's 300-file cap) -> cannot verify, never docs-only.
CASE=compare-truncated; setup $CASE
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 962 push completed success main > "$FIX/runs.$ANC"; echo success > "$FIX/job.962"
{ echo 300; for i in $(seq 1 300); do echo "docs/f$i.md"; done; } > "$FIX/compare"
if run 1; then ok 'echo "$OUT" | grep -q "cannot verify CI (the compare .* lists 300 files"' "should refuse a capped compare"; fi

# 7d. A failed compare read -> cannot verify (fails closed), not docs-only.
CASE=compare-fails; setup $CASE
printf '%s\n%s\n' "$SHA" "$ANC" > "$FIX/commits"; row 963 push completed success main > "$FIX/runs.$ANC"
printf 'ok\nok\nok\n403\n' > "$FIX/fail"; echo "4000 $((NOW + 60))" > "$FIX/probe"
if run 1; then ok 'echo "$OUT" | grep -q "cannot verify CI (the API refused a read with quota left"' "should fail closed on the compare read"; fi

# 7e. A push to an epic/** branch is trusted (ci.yml runs on push to epic/**).
CASE=epic-push; setup $CASE
row 964 push completed success epic/t579-hotfix > "$FIX/runs.$SHA"; echo success > "$FIX/job.964"
if run 0; then ok 'echo "$OUT" | grep -q "CI run 964 (push on epic/t579-hotfix)"' "should trust the epic push"; fi

# 7f. Drift pin (Lead p/233#124): the script's paths-ignore list equals ci.yml's on.push.paths-ignore.
CASE=paths-ignore-drift
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CI_LIST=$(awk '/^on:/{on=1} on&&/^  push:/{p=1;next} p&&/^  [a-z_]+:/{exit} p&&/paths-ignore:/{pi=1;next} pi&&/^      - /{gsub(/^      - |['"'"'"]/,""); print; next} pi&&!/^ *#/&&!/^      - /{pi=0}' "$REPO_ROOT/.github/workflows/ci.yml" | sort)
SCRIPT_LIST=$(grep -oE "^CI_PATHS_IGNORE=\(.*\)" "$SCRIPT_DIR/verify-deploy-ci.sh" | grep -oE "'[^']+'" | tr -d "'" | sort)
if [ -z "$CI_LIST" ] || [ "$CI_LIST" != "$SCRIPT_LIST" ]; then
  echo "FAIL [$CASE]: verify-deploy-ci.sh CI_PATHS_IGNORE differs from ci.yml on.push.paths-ignore. ci.yml: [$(printf '%s ' "$CI_LIST" | tr '\n' ' ')] script: [$(printf '%s ' "$SCRIPT_LIST" | tr '\n' ' ')]"; fail=1
fi

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

# ── t/754: container.yml's ci-gate runs this script too ──
# A watch stand-in that fails the way `gh run watch` did in the incident (run 45732963219), after
# the CI run has in fact finished.
cat > "$TMP/watchfail" <<'W'
#!/usr/bin/env bash
echo "$1" >> "$FIX/.watched"
[ -f "$FIX/job.$1.after" ] && cp "$FIX/job.$1.after" "$FIX/job.$1"
echo "failed to get run: HTTP 403: API rate limit exceeded for installation." >&2
exit 1
W
chmod +x "$TMP/watchfail"

# 14. THE t/754 INCIDENT: CI is still running, the watch dies on a rate limit, CI ends green -> pass.
#     The watch's exit code decides nothing; the job read after it does.
CASE=t754-watch-ratelimit-ci-green; setup $CASE
row 700 push in_progress "" main > "$FIX/runs.$SHA"
echo in_progress > "$FIX/job.700"; echo success > "$FIX/job.700.after"
if WATCH_CMD="$TMP/watchfail" WHAT="this job" run 0; then
  ok '[ "$(cat "$FIX/.watched")" = "700" ]' "should have waited for run 700"
  ok 'echo "$OUT" | grep -q "test-container: success in CI run 700"' "should pass on the job read after the failed watch"
  ok '! echo "$OUT" | grep -qi "failed"' "must not say failed anywhere"
fi

# 15. The watch dies on a rate limit AND every read after it is rate-limited -> cannot verify, never "CI failed".
CASE=t754-ratelimit-every-read; setup $CASE
row 701 push in_progress "" main > "$FIX/runs.$SHA"
echo in_progress > "$FIX/job.701"; echo success > "$FIX/job.701.after"
printf 'ok\nok\nratelimit\nratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 60))" > "$FIX/probe"
if WATCH_CMD="$TMP/watchfail" WHAT="this job" run 1; then
  ok 'echo "$OUT" | grep -q "cannot verify CI (rate limit, resets at"' "should say cannot verify with the reset time"
  ok 'echo "$OUT" | grep -q "re-run this job after the reset"' "should tell the reader to re-run this job"
  ok '! echo "$OUT" | grep -qE "CI run [0-9]+ .*finished with|CI failed"' "must not report a CI failure"
  ok '[ "$SLEEPS" = "65 " ]' "should wait for the reset exactly once"
fi

# 16. CI really failed -> blocked, and the message says CI's own result.
CASE=t754-ci-really-failed; setup $CASE
row 702 push in_progress "" main > "$FIX/runs.$SHA"
echo in_progress > "$FIX/job.702"; echo failure > "$FIX/job.702.after"
if WATCH_CMD="$TMP/watchfail" WHAT="this job" run 1; then
  ok "echo \"\$OUT\" | grep -q \"CI run 702 (push on main) finished with test-container 'failure'\"" "should report the real failure"
  ok '! echo "$OUT" | grep -q "cannot verify"' "a real failure is not 'cannot verify'"
fi

# 17. A short SHA is expanded through the retrying reader, then judged as usual.
CASE=t754-short-sha; setup $CASE
echo "$SHA" > "$FIX/fullsha"
row 703 push completed success main > "$FIX/runs.$SHA"; echo success > "$FIX/job.703"
if RUN_SHA=aaaaaaa run 0; then
  ok 'echo "$OUT" | grep -q "Expanded short SHA aaaaaaa to $SHA"' "should expand the short SHA"
  ok 'echo "$OUT" | grep -q "test-container: success in CI run 703"' "should judge the full SHA"
fi

# 18. A rate limit while expanding a short SHA is 'cannot verify', not 'cannot resolve the SHA'.
CASE=t754-short-sha-ratelimit; setup $CASE
echo "$SHA" > "$FIX/fullsha"
printf 'ratelimit\nratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 60))" > "$FIX/probe"
if RUN_SHA=aaaaaaa WHAT="this job" run 1; then
  ok 'echo "$OUT" | grep -q "cannot verify CI (rate limit"' "should say cannot verify"
  ok '! echo "$OUT" | grep -qi "resolve"' "must not blame the SHA"
fi

# 19. Something that is not a SHA is refused before any API read.
CASE=t754-not-a-sha; setup $CASE
if RUN_SHA='main; echo x' run 1; then
  ok 'echo "$OUT" | grep -q "is not a commit SHA"' "should refuse a non-hex value"
  ok '[ ! -f "$FIX/.reads" ]' "no API read for a non-SHA"
fi

# 20. The default wording is unchanged for the deploy preflight.
CASE=t754-default-wording; setup $CASE
row 990 push completed success main > "$FIX/runs.$SHA"
printf 'ratelimit\nratelimit\n' > "$FIX/fail"; echo "0 $((NOW + 60))" > "$FIX/probe"
if run 1; then ok 'echo "$OUT" | grep -q "re-run the deploy after the reset"' "the deploy preflight still says 're-run the deploy'"; fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "PASS: trusted green run wins over a newer queued pull_request run (the incident); PR runs never count; rate limit waits once or says 'cannot verify', never 'CI failed'; skipped, docs-only, wait-for-in-progress and fail-closed arms hold."
