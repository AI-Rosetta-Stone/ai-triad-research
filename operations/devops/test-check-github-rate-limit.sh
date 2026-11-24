#!/usr/bin/env bash
# t/4586: shim tests for check-github-rate-limit.sh's three arms -- healthy, low-quota,
# and health-check-failed -- using a local Python HTTP server to stand in for /health
# rather than mocking curl, so the real HTTP+jq path is exercised.
set -euo pipefail
cd "$(dirname "$0")"
chmod +x check-github-rate-limit.sh

FAIL=0

serve() {
  local body="$1"
  local port="$2"
  python3 -c "
import http.server, socketserver, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'''$body''')
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
s = socketserver.TCPServer(('127.0.0.1', $port), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
import time; time.sleep(5)
" &
  SERVER_PID=$!
  sleep 0.5
}

# Arm 1: healthy (remaining well above 10%)
serve '{"githubRateLimitRemaining": 3701, "githubRateLimitResetsAt": "2026-10-27T23:40:49.000Z"}' 8901
RESULT=$(./check-github-rate-limit.sh "http://127.0.0.1:8901/health" 5000)
kill "$SERVER_PID" 2>/dev/null || true
if ! echo "$RESULT" | jq -e '.shouldAlert == false and .kind == "healthy" and .remaining == 3701' >/dev/null; then
  echo "FAIL: arm 1 (healthy) -- got: $RESULT"
  FAIL=1
else
  echo "PASS: arm 1 (healthy)"
fi

# Arm 2: low quota (under 10% = under 500 of 5000)
serve '{"githubRateLimitRemaining": 412, "githubRateLimitResetsAt": "2026-10-27T23:40:49.000Z"}' 8902
RESULT=$(./check-github-rate-limit.sh "http://127.0.0.1:8902/health" 5000)
kill "$SERVER_PID" 2>/dev/null || true
if ! echo "$RESULT" | jq -e '.shouldAlert == true and .kind == "quota-low" and .remaining == 412' >/dev/null; then
  echo "FAIL: arm 2 (quota-low) -- got: $RESULT"
  FAIL=1
else
  echo "PASS: arm 2 (quota-low)"
fi

# Arm 3: health check itself unreachable on EVERY attempt -- must alert, never read as
# healthy. Now takes ~10s (3 attempts, 2 backoffs) instead of instant -- t/4970's retry fix.
RESULT=$(./check-github-rate-limit.sh "http://127.0.0.1:1/health" 5000 2>/dev/null)
if ! echo "$RESULT" | jq -e '.shouldAlert == true and .kind == "health-check-failed"' >/dev/null; then
  echo "FAIL: arm 3 (health-check-failed) -- got: $RESULT"
  FAIL=1
else
  echo "PASS: arm 3 (health-check-failed)"
fi

# t/4970: cold first attempt (nothing listening yet) then success once the server comes up --
# must NOT alert, and must log at least one WARN for the retry taken. Reproduces the live
# incident (alert #5279): a cold scale-to-zero start that resolves within the retry window.
STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
./check-github-rate-limit.sh "http://127.0.0.1:8905/health" 5000 >"$STDOUT_FILE" 2>"$STDERR_FILE" &
RETRY_PID=$!
sleep 1  # let the first attempt fail against nothing listening, before the server comes up
serve '{"githubRateLimitRemaining": 3701, "githubRateLimitResetsAt": "2026-10-27T23:40:49.000Z"}' 8905
wait "$RETRY_PID"
kill "$SERVER_PID" 2>/dev/null || true
RESULT=$(cat "$STDOUT_FILE")
WARN_COUNT=$(grep -c "WARN: health check attempt" "$STDERR_FILE" || true)
rm -f "$STDOUT_FILE" "$STDERR_FILE"
if ! echo "$RESULT" | jq -e '.shouldAlert == false and .kind == "healthy"' >/dev/null; then
  echo "FAIL: arm 5 (cold-start-then-success) -- got: $RESULT"
  FAIL=1
elif [ "$WARN_COUNT" -lt 1 ]; then
  echo "FAIL: arm 5 (cold-start-then-success) -- expected at least one retry WARN, got $WARN_COUNT"
  FAIL=1
else
  echo "PASS: arm 5 (cold-start-then-success, no alert, $WARN_COUNT WARN(s) logged)"
fi

# Arm 4: field genuinely missing from the response -- must alert, not read as healthy
serve '{"status": "ok"}' 8903
RESULT=$(./check-github-rate-limit.sh "http://127.0.0.1:8903/health" 5000)
kill "$SERVER_PID" 2>/dev/null || true
if ! echo "$RESULT" | jq -e '.shouldAlert == true and .kind == "field-missing"' >/dev/null; then
  echo "FAIL: arm 4 (field-missing) -- got: $RESULT"
  FAIL=1
else
  echo "PASS: arm 4 (field-missing)"
fi

exit $FAIL
