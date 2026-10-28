#!/usr/bin/env bash
# t/4586 (DevOps follow-up AC): alert when prod's GitHub App installation quota drops
# under 10% remaining -- the exact quota t/4584 showed can be silently exhausted by
# concurrent cold boots, now visible via the server's public /health endpoint
# (githubRateLimitRemaining / githubRateLimitResetsAt, landed in t/4586#2/#3/#4).
#
# GitHub App installation tokens get a 5000/hour budget, so 10% = 500 remaining
# (overridable via the 2nd arg for testing against a different assumed ceiling).
#
# Usage: check-github-rate-limit.sh <health_url> [limit_ceiling]
# Prints a JSON object: {"shouldAlert": bool, "remaining": n, "resetsAt": "...", "percent": n}
# Exits 0 always (alerts, never fails closed/open).
set -uo pipefail

HEALTH_URL="$1"
LIMIT_CEILING="${2:-5000}"

if ! BODY=$(curl -fsS --max-time 15 "$HEALTH_URL" 2>&1); then
  echo '{"shouldAlert": true, "kind": "health-check-failed", "remaining": null, "resetsAt": null, "percent": null}'
  exit 0
fi

REMAINING=$(echo "$BODY" | jq -r '.githubRateLimitRemaining // empty')
RESETS_AT=$(echo "$BODY" | jq -r '.githubRateLimitResetsAt // empty')

# A field genuinely absent from /health (not yet deployed, or server-side regression)
# is its own distinct alert -- never silently read as "healthy", same discipline as
# t/4567's liveness-check-failed class.
if [ -z "$REMAINING" ]; then
  echo '{"shouldAlert": true, "kind": "field-missing", "remaining": null, "resetsAt": null, "percent": null}'
  exit 0
fi

PERCENT=$(( REMAINING * 100 / LIMIT_CEILING ))

if [ "$PERCENT" -lt 10 ]; then
  jq -n --argjson remaining "$REMAINING" --arg resetsAt "$RESETS_AT" --argjson percent "$PERCENT" \
    '{shouldAlert: true, kind: "quota-low", remaining: $remaining, resetsAt: $resetsAt, percent: $percent}'
else
  jq -n --argjson remaining "$REMAINING" --arg resetsAt "$RESETS_AT" --argjson percent "$PERCENT" \
    '{shouldAlert: false, kind: "healthy", remaining: $remaining, resetsAt: $resetsAt, percent: $percent}'
fi
