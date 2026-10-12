#!/usr/bin/env bash
# Pre-deploy runtime smoke: run a container image the way prod runs it and
# prove /healthz becomes ready. Catches "image builds + inits fully but never
# reports ready" — the failure class that took down prod in t/2047 (a base
# node bump broke the github-api data load → /healthz stayed 503 → crash-loop),
# which the build-only CI container gate passed green (t/2047 gap #1, t/1589).
#
# Usage:  IMAGE=<ref> GITHUB_TOKEN=<tok> deploy/azure/smoke-healthz.sh
#   IMAGE         required — the image ref (tag or @sha256 digest) to smoke.
#   GITHUB_TOKEN  required — public read is enough (AI-Rosetta-Stone/ai-triad-data is
#                 public); the readiness gate needs the github-api fetch to
#                 succeed, which is exactly the path the t/2047 regression broke.
#
# Exit 0 = /healthz returned 200 within the window (healthy).
# Exit 1 = never became ready, or the container died (the crash-loop signature).
set -euo pipefail

IMAGE="${IMAGE:?set IMAGE to the image ref to smoke}"

# ── Gate mode (co-located, per t/2048 Gate Co-Location) ─────────────────────
# SMOKE_MODE selects what "healthy" means:
#   liveness  — pass as soon as /healthz RESPONDS with any HTTP status (server
#               is up + serving). Does NOT require data. This is the CI gate
#               (ci.yml test-container): a CI-built image bakes only a STUB
#               snapshot and cannot reach real data-readiness, so CI can only
#               prove the container starts and answers. Catches boot crashes /
#               port-never-listens — strictly better than the old build-only gate.
#   readiness — pass only on /healthz==200 (taxonomy data actually loaded via the
#               github-api fetch). This is the DEPLOY-stage gate (t/2049, real env
#               + creds); it's what catches the t/2047 class (starts but never
#               data-ready). da74e499 RED / efd068fe GREEN is its AC.
SMOKE_MODE="${SMOKE_MODE:-readiness}"
# GITHUB_TOKEN is only required in readiness mode (github-api data-load fetch).
# In liveness mode no external fetch is needed — default to empty so the script
# doesn't abort when called without it (e.g. CI liveness gate, t/2067).
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ "${SMOKE_MODE}" = "readiness" ] && [ -z "${GITHUB_TOKEN}" ]; then
  echo "::error::GITHUB_TOKEN required for SMOKE_MODE=readiness (public read is enough)"
  exit 1
fi

# READY_TIMEOUT covers real cold start: onnx model is baked, so startup is
# app init + (readiness) the github-api taxonomy fetch (public repo, a few MB).
# In the t/2047 incident the replica reached ~full init well before its 80s
# SIGTERM, so a healthy image passes far inside this window; a never-healthy
# replica exhausts it and fails. Bounded + deterministic — no flake.
READY_TIMEOUT="${READY_TIMEOUT:-180}"   # seconds
POLL_INTERVAL="${POLL_INTERVAL:-5}"      # seconds
PORT=7862
NAME="healthz-smoke-$$"
HEALTH_URL="http://localhost:${PORT}/healthz"

cleanup() {
  echo "── container logs (tail 120) ──"
  docker logs --tail 120 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Smoking image: ${IMAGE}"
echo "Ready window: ${READY_TIMEOUT}s (poll every ${POLL_INTERVAL}s) against ${HEALTH_URL}"

# Prod-like runtime env. STORAGE_MODE=github-api forces the real data-load
# path (config.ts); GITHUB_REPO + GITHUB_TOKEN let it read the public data
# repo. AUTH_DISABLED keeps the smoke unauthenticated. This is what makes a
# good image reach 200 and a fetch-broken image stay 503.
docker run -d --name "$NAME" -p "${PORT}:${PORT}" \
  -e NODE_ENV=production \
  -e STORAGE_MODE=github-api \
  -e GITHUB_REPO="${GITHUB_REPO:-AI-Rosetta-Stone/ai-triad-data}" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
  -e AI_TRIAD_DATA_ROOT=/tmp/taxonomy-cache \
  -e AUTH_DISABLED=1 \
  -e PORT="${PORT}" \
  "$IMAGE" >/dev/null

deadline=$(( SECONDS + READY_TIMEOUT ))
last=""
while (( SECONDS < deadline )); do
  # If the container exited, stop early — that's the crash, not a slow start.
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" != "true" ]; then
    echo "::error::Container exited before becoming ready (crash signature)."
    exit 1
  fi
  # curl prints the http_code ("000" on connection failure) and may exit non-zero;
  # `|| true` keeps set -e happy WITHOUT appending a second token (the earlier
  # `|| echo 000` concatenated to "000000", which liveness wrongly read as "responded").
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
  code=${code:-000}
  # liveness: any HTTP status (code != 000) means the server answered → pass.
  # readiness: only 200 (data loaded) counts.
  if { [ "$SMOKE_MODE" = "liveness" ] && [ "$code" != "000" ]; } || [ "$code" = "200" ]; then
    echo "HEALTHY (${SMOKE_MODE}): /healthz responded ${code} after $(( SECONDS ))s."
    echo "── /health detail ──"
    curl -s --max-time 5 "http://localhost:${PORT}/health" || true
    exit 0
  fi
  if [ "$code" != "$last" ]; then
    echo "  t=$(( SECONDS ))s /healthz=${code}"
    last="$code"
  fi
  sleep "$POLL_INTERVAL"
done

if [ "$SMOKE_MODE" = "liveness" ]; then
  echo "::error::/healthz never RESPONDED within ${READY_TIMEOUT}s (last=${last:-000}). Server never came up — refusing to promote."
else
  # Readiness discrimination (container still up here — trap cleanup runs after):
  # is the data-load path reachable FROM this container? Distinguishes
  # "CI can't complete the github fetch" from "a real readiness/code bug".
  echo "── readiness discrimination ──"
  echo "  app /api/data/available: $(curl -s --max-time 5 "http://localhost:${PORT}/api/data/available" || echo '<no response>')"
  docker exec "$NAME" sh -c 'curl -s -o /dev/null -w "  in-container github contents(taxonomy/Origin) HTTP=%{http_code}\n" --max-time 8 -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$GITHUB_REPO/contents/taxonomy/Origin?ref=main"' 2>&1 || echo "  (in-container github probe could not run)"
  echo "  ⇒ github HTTP=200 means CI CAN fetch the data (points at a real readiness/code bug); non-200 means CI-can't-fetch (readiness gate → deploy stage)."
  echo "::error::/healthz never returned 200 within ${READY_TIMEOUT}s (last=${last}). Not data-ready — refusing to promote."
fi
exit 1
