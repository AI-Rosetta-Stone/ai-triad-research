# Azure Deployment Retrospective — 2026-05-05

## Executive Summary

A user-reported performance issue ("the app is slow") triggered a cascade of 8+ deployment cycles over ~6 hours. The root causes were straightforward (Azure Files SMB latency, a broken env var, startup probe timeouts), but the **cycle time to detect and fix each issue was 15-30 minutes**, turning simple fixes into a full-day incident. Most problems could have been caught before reaching production.

---

## Timeline of Events

| Time | Event | Root Cause | Cycles to Fix |
|------|-------|------------|---------------|
| T+0 | User reports app is slow | — | — |
| T+10m | Bumped CPU to 2 vCPU / 4 GiB | Misdiagnosis — CPU was at 2.5%, memory at 9% | 1 (reverted later) |
| T+20m | Pulled metrics, discovered CPU/memory weren't the bottleneck | Cold starts (minReplicas: 0) + Azure Files latency | 1 |
| T+30m | Set minReplicas: 1, reverted to 0.5 vCPU | Fixed cold starts, but SMB latency remained | 1 |
| T+45m | Discovered `ALLOWED_ORIGINS=undefined` crash | Ad-hoc CLI update wiped env vars | 1 |
| T+60m | Created entrypoint.sh (blocking copy) | Azure Files ~5-25ms per I/O × hundreds of files = 50s+ startup | 1 |
| T+90m | Container build #1 failed — Hadolint DL3008 | `failure-threshold: info` treated warnings as errors | 1 |
| T+100m | Container build #2 failed — base image missing | `FROM ai-triad-base:2026-05-01` tag never pushed | 1 |
| T+110m | Container build #3 failed — Trivy crash | Trivy v0.63.0 crashes on install | 1 |
| T+120m | Image deployed but startup probe kills container | 50s probe < data copy time over SMB | 2 |
| T+150m | Switched to background copy entrypoint | Blocking copy prevented health endpoint from responding | 1 |
| T+170m | New revision deployed but no traffic shift | Multi-revision mode requires explicit traffic routing | 1 |
| T+180m | Deploy workflow failed — OIDC token expired | Health check ran >1 hour, token expired before rollback | 1 |
| T+190m | Deploy workflow failed — traffic shift race | Provisioning still in progress when traffic shift attempted | 1 |

**Total: ~14 distinct issues, ~15 deployment cycles, ~6 hours elapsed.**

---

## Root Cause Analysis

### Category 1: Configuration Drift (caused 3 issues)

Ad-hoc `az containerapp update` commands throughout the session created drift between Bicep (source of truth) and live state. Specific damage:
- `ALLOWED_ORIGINS` set to empty string → app crashed on every request
- `minReplicas` / `maxReplicas` diverged from Bicep
- Readiness probe dropped from active revision

**Why it happened:** No guardrail preventing CLI changes to production config. The convenience of `az containerapp update` for quick fixes made it the default tool, but each CLI change introduced drift that the next Bicep deploy would fight.

### Category 2: Untested Infrastructure Changes (caused 4 issues)

The entrypoint.sh, Dockerfile changes, and Bicep modifications were deployed directly to production without any local or staging validation of the integrated behavior:
- Blocking copy exceeded startup probe timeout
- Background copy race with git sync init
- Volume mount path change (`/data` → `/data-persistent`) not tested with actual data
- Base image tag reference (`2026-05-01`) never verified to exist

**Why it happened:** No staging environment (staging deployed to the same container app as production) and no local smoke test that replicated the Azure Files mount + probe behavior.

### Category 3: CI Pipeline Fragility (caused 3 issues)

Three unrelated CI failures blocked image builds:
- Hadolint `failure-threshold: info` failed on standard apt-get warnings
- Trivy v0.63.0 binary crashes on install
- SARIF upload failed because Trivy never produced output

**Why it happened:** No `continue-on-error` on advisory scanning steps. Lint and security scan failures blocked the entire build-push-sign pipeline even though the image was buildable and pushable.

### Category 4: Workflow Design Gaps (caused 2 issues)

- OIDC token expired during long health check → rollback failed
- Traffic shift hit `ContainerAppOperationInProgress` race condition

**Why it happened:** Workflow assumed operations complete quickly. No token refresh, no retry-with-backoff on Azure API calls.

---

## Process Recommendations

### 1. Ban Ad-Hoc CLI Changes to Production Config

**Status:** Partially done — rule added to AGENTS.md in t/312.

**Additional steps needed:**
- Create an Orca feedback rule (hook) that blocks `az containerapp update` commands that modify scaling, probes, env vars, or resource limits. Allow only: `az containerapp logs`, `az containerapp revision list`, image-only updates with `--revision-suffix`.
- All persistent config changes go through Bicep → deploy workflow.

### 2. Require Local Smoke Test Before Deploying Infra Changes

**Current state:** CI runs a container smoke test (`test-container` job in ci.yml) but it doesn't mount a volume or test the entrypoint with real data.

**Recommendation:** Extend the CI smoke test to:
- Mount a small test dataset at `/data-persistent`
- Verify the entrypoint copies data to `/data`
- Verify the app starts and `/health` returns 200 within the startup probe window
- Verify taxonomy data is accessible via an API endpoint

### 3. Separate Advisory Scans from Build Pipeline

**Status:** Done — `continue-on-error: true` added to Trivy in both workflows.

**Longer-term:** Move Trivy and SBOM generation to a separate post-build workflow that runs asynchronously. The build-push-sign pipeline should never be blocked by advisory tooling.

### 4. Pin CI Tool Versions Explicitly

Trivy `v0.31.0` action resolved to Trivy binary `v0.63.0` which had a regression. The base image tag `2026-05-01` was referenced but never built.

**Recommendation:**
- Pin Trivy binary version in the action config (not just the action version)
- Base image Dockerfile should use `FROM ai-triad-base:latest` (already fixed) or dynamically resolve the latest date tag
- Add a CI check that validates the base image tag exists before the app image build starts

---

## Shift-Left Opportunities

The core problem: **each fix required a 15-30 minute round trip** (edit → commit → push → build image ~3 min → deploy ~2 min → wait for startup ~2 min → check logs). With 14 issues, this compounded to 6 hours.

### Opportunity A: Local Entrypoint Testing (saves ~20 min per iteration)

**Current:** Entrypoint changes require a full image build + deploy to Azure to test.

**Shift-left:** Create a `docker-compose.test.yml` that replicates the Azure environment locally:
```yaml
services:
  app:
    build: { context: ., dockerfile: taxonomy-editor/Dockerfile }
    volumes:
      - ./test-data:/data-persistent  # Simulates Azure Files mount
    environment:
      - AI_TRIAD_DATA_ROOT=/data
    ports: ["7862:7862"]
    healthcheck:
      test: curl -f http://localhost:7862/health
      interval: 5s
      timeout: 5s
      start_period: 60s
      retries: 10
```
Run `docker compose up` locally before pushing. Would have caught: blocking copy timeout, missing data dirs, volume mount path issues.

### Opportunity B: Bicep What-If in CI (saves ~15 min per failed deploy)

**Current:** Bicep errors (like `softDeleteRetentionInDays` immutability) are discovered at deploy time.

**Shift-left:** Add `az deployment group what-if` to the CI pipeline or as a pre-push check:
```yaml
- name: Bicep what-if
  run: az deployment group what-if -g ai-triad -f deploy/azure/main.bicep --no-pretty-print
```
This previews changes without applying them. Would have caught: Key Vault property immutability, registry deletion conflicts, resource tag changes.

### Opportunity C: Pre-Build Image Validation (saves ~5 min per build failure)

**Current:** Dockerfile issues found during the build step in CI.

**Shift-left:** Add a pre-build validation script that checks:
- Base image tag exists in GHCR (`gh api` check)
- Hadolint passes locally (run as pre-commit hook or in CI before Docker build)
- All `COPY` source paths exist in the build context

### Opportunity D: Staging Environment with Auto-Deploy (saves ~30 min per issue)

**Status:** Partially done — `taxonomy-editor-staging` now exists in Bicep.

**Complete the loop:**
- Auto-deploy every container build to staging (deploy-staging.yml already does this)
- Run integration tests against staging (health check, load taxonomy data, verify API responses)
- Only promote to production after staging passes
- This catches entrypoint issues, data copy problems, and probe timeouts before they reach production

### Opportunity E: Structured Logging (saves diagnosis time across all issues)

**Current:** The entrypoint and app produce ad-hoc `echo` output. During the incident we repeatedly waited 30-60 seconds, tailed logs, and guessed what was happening. Key blind spots:

- **No timestamps on entrypoint operations** — couldn't tell if the copy was still running or had been killed by the probe. We saw "Copying data..." but never "Copy completed in Xs" or "Copy killed after Xs".
- **No duration tracking** — didn't know if the copy was taking 10s or 200s until we did the math from log timestamps across restarts.
- **No progress indication** — the blocking copy was a black box. Was it stuck on the first directory or finishing the last?
- **No environment diagnostics on startup** — we had to add diagnostic `echo` lines mid-incident to discover mount paths and permissions. This should be standard.
- **Server startup gives no timing** — "Taxonomy Editor running" doesn't tell us how long module load, config parse, and data init took. The 27-second gap between "running" and "Loaded config" was only discoverable by eyeballing timestamps.

**Recommendations:**

**1. Entrypoint logging standard — every operation gets a duration:**
```sh
log() { echo "[entrypoint] $(date -u +%H:%M:%S) $*"; }
t_start=$(date +%s)
log "Copying taxonomy..."
cp -a "$DATA_REMOTE/taxonomy" "$DATA_LOCAL/taxonomy"
t_end=$(date +%s)
log "Copied taxonomy ($((t_end - t_start))s)"
```
This would have immediately shown us that the copy was taking >50s and being killed.

**2. Environment snapshot on every container start:**
```
[entrypoint] 00:00:00 === Container Start ===
[entrypoint] 00:00:00 Image: ghcr.io/ai-rosetta-stone/taxonomy-editor:latest
[entrypoint] 00:00:00 Revision: taxonomy-editor--deploy-abc1234
[entrypoint] 00:00:00 /data-persistent: mounted=yes, files=14, dirs=14
[entrypoint] 00:00:00 /data: exists=yes, writable=yes
[entrypoint] 00:00:00 GIT_SYNC_ENABLED=1, NODE_ENV=production
[entrypoint] 00:00:00 Startup probe window: 50s (5s × 10)
```
We added some of this mid-incident but had to rebuild and redeploy to get it. This should be baked in permanently.

**3. Server-side startup timing in the app:**
The Node.js server should log durations for each initialization phase:
```
[server] Config loaded (420ms)
[server] Policy registry loaded: 1080 policies (1,200ms)
[server] Git sync initialized (350ms)
[server] Ready to serve (total: 1,970ms)
```
The 27-second config load and 21-second policy load over SMB were invisible until we correlated timestamps manually. Explicit durations would have pointed to Azure Files latency immediately.

**4. Background copy progress reporting:**
Since the copy now runs in the background, the app should expose copy status:
- Log each directory as it completes with size and duration
- Expose a `/status` or `/ready` endpoint: `{"data_copy": "in_progress", "dirs_copied": 5, "dirs_total": 9, "elapsed_s": 23}`
- The deploy workflow can poll this instead of just `/health`, giving real-time visibility

**5. Azure Monitor alerts for container lifecycle events:**
- Startup probe failure count > 5 in 10 minutes
- Container restart count > 3 in 10 minutes
- Revision provisioning failures
- These alert before anyone has to manually check logs

### Opportunity F: Observability During Deployment (saves workflow diagnosis time)

**Current:** Deploy workflow polls `/health` in a loop and prints "Waiting... (attempt N, status: 000)". On failure, we have to manually find the workflow run, expand the failed step, and read Azure CLI error messages.

**Shift-left:**
- Stream container logs during health check wait (not just poll HTTP status)
- Print revision name and FQDN at each step for easier Azure portal correlation
- On rollback, include the failed revision's last 20 log lines in the workflow output
- Add a workflow summary annotation with deploy outcome, timings, and revision names

### Opportunity G: Proactive Monitoring and Auto-Remediation

**Current:** Every issue yesterday was discovered by a human ("the app is slow", "what am I supposed to do here?"). The system never told us something was wrong — we had to go looking. Even when the container was crash-looping on startup probes for minutes, there was no alert. We were reactive to every failure.

**The problem isn't just detection — it's the gap between detection and action.** Yesterday's pattern repeated multiple times: human notices something wrong → agent investigates → agent diagnoses → agent fixes → agent deploys → wait for result. Several of these issues had well-known signatures that could be detected and corrected automatically.

**1. Health endpoint monitoring with automatic escalation**

Set up an external health check (Azure Monitor availability test, or a simple cron-based ping) that runs every 60 seconds against production:

```
GET https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/health
```

Escalation ladder:
- **3 consecutive failures** → ping the Azure agent with error details
- **5 consecutive failures** → ping the human via Orca + Slack
- **10 consecutive failures** → auto-rollback to previous known-good revision

Yesterday's `ALLOWED_ORIGINS` crash (app returning 500 on every request) would have been caught within 3 minutes and auto-rolled back within 10 — instead of waiting for the user to report "it's slow."

**2. Drift detection — scheduled Bicep what-if**

Run `az deployment group what-if` on a schedule (daily or after every manual `az` command) to compare live state against Bicep. If drift is detected:
- Auto-create a ticket with the specific differences
- Ping the Azure agent with the diff
- For critical drift (missing probes, broken env vars), auto-deploy Bicep to correct it

Yesterday's `ALLOWED_ORIGINS` wipe and missing readiness probe would have been caught and auto-corrected within hours, not discovered when a user hit a crash.

**3. Container restart loop detection and auto-rollback**

Azure Container Apps exposes restart counts via metrics. A KQL alert rule:

```kusto
ContainerAppSystemLogs_CL
| where Reason_s == "ContainerBackOff" or Reason_s == "StoppingContainer"
| where TimeGenerated > ago(10m)
| summarize RestartCount = count() by RevisionName_s
| where RestartCount > 5
```

When triggered:
- Automatically deactivate the failing revision
- Shift traffic to the previous healthy revision
- Create a ticket with the restart logs attached
- Ping the Azure agent and human

Yesterday's startup probe crash loop (the entrypoint copy exceeding the probe timeout) ran for over an hour before we noticed. Auto-rollback would have restored service in minutes and preserved the previous working revision while we debugged.

**4. Performance baseline monitoring**

Establish baselines for key metrics and alert on regressions:

| Metric | Baseline | Alert Threshold | Auto-action |
|--------|----------|----------------|-------------|
| Health endpoint TTFB | <100ms | >500ms for 5 min | Ping Azure agent |
| Startup time (container ready) | <30s | >120s | Ping Azure agent + human |
| Error rate (5xx) | <1% | >5% for 3 min | Auto-rollback |
| Memory usage | <400MB | >900MB (90% of 1Gi) | Ping Azure agent |
| Azure Files latency (E2E) | <10ms | >50ms avg for 10 min | Ping Azure agent |

The initial "app is slow" report would have been preceded by an automated alert: "TTFB exceeded 500ms baseline for 5 minutes — investigating" — or better yet, already auto-diagnosed with the relevant metrics attached.

**5. Deploy canary validation**

Instead of shifting 100% traffic immediately after a health check, implement automated canary validation:

- Shift 10% traffic to new revision
- Monitor error rate and latency for 2 minutes
- If metrics are healthy, shift to 100%
- If error rate spikes or latency degrades, auto-rollback to 0% and alert

This is a natural extension of the blue-green deployment we set up in t/317. The difference: the system makes the promotion/rollback decision automatically based on metrics, not a binary health check.

**6. Orca scheduled agent for daily health audit**

Create a scheduled Orca trigger that runs daily:
- Check container app health and metrics
- Run Bicep what-if for drift detection
- Verify all probes are present on the active revision
- Check certificate expiry, secret rotation dates
- Verify cost is within budget
- Post a summary to the human (or stay silent if everything is healthy)

This converts the "Azure review" we did manually yesterday into a recurring automated check.

**Implementation priority:**

| Auto-remediation | Prevents | Effort | Yesterday's Issues Caught |
|-----------------|----------|--------|--------------------------|
| Health monitoring + auto-rollback | Serving broken responses | Low | ALLOWED_ORIGINS crash, startup crash loop |
| Restart loop detection | Extended outages from crash loops | Low | Entrypoint probe timeout loop |
| Drift detection | Config drift accumulation | Medium | ALLOWED_ORIGINS wipe, missing probe, scaling drift |
| Performance baseline alerts | Silent performance degradation | Medium | "App is slow" reported by user |
| Deploy canary validation | Bad deploys reaching 100% traffic | Medium | Would have gated every failed deploy |
| Daily health audit | Accumulated operational debt | Low | All issues (detected earlier) |

**Key insight:** The costliest part of yesterday wasn't the bugs themselves — it was the **human in the loop for detection**. Every issue waited for someone to notice, report, and investigate. Auto-monitoring with auto-remediation removes the human from the detection loop entirely. The human's role shifts from "notice something is broken" to "review what the system already fixed."

### Impact Matrix

| Opportunity | Issues Prevented | Implementation Effort | Cycle Time Saved |
|-------------|-----------------|----------------------|-----------------|
| A. Local entrypoint testing | Probe timeout, copy failures, mount issues | Low (compose file) | ~20 min/iteration |
| B. Bicep what-if | Immutable property errors, drift conflicts | Low (CI step) | ~15 min/failed deploy |
| C. Pre-build validation | Missing base image, lint failures | Low (script) | ~5 min/build failure |
| D. Staging auto-test | All runtime issues | Medium (test suite) | ~30 min/issue |
| **E. Structured logging** | **Misdiagnosis, blind debugging, guessing at root cause** | **Low (entrypoint + server)** | **~10-15 min/issue** |
| F. Deployment observability | Workflow diagnosis, rollback debugging | Medium (workflow + alerts) | ~10 min/diagnosis |
| **G. Auto-monitoring + remediation** | **Human removed from detection loop entirely** | **Medium** | **~1-4 hours (issues fixed before anyone notices)** |

Note on E: Structured logging has outsized value because it reduces diagnosis time on **every** issue. Yesterday's biggest time sinks weren't fixing problems — they were **figuring out what the problem was**.

Note on G: Auto-monitoring is the highest-impact change overall. Yesterday, **every single issue waited for a human to notice it**. The ALLOWED_ORIGINS crash served broken responses for an unknown duration before the user reported slowness. The startup crash loop ran for over an hour. With health monitoring + auto-rollback, the system would have detected and corrected these within minutes — and the human would have received a notification that something was fixed, rather than a report that something was broken.

---

## Artifacts Changed During Incident

| File | Changes Made | Should Have Been Tested First |
|------|-------------|------------------------------|
| `deploy/azure/entrypoint.sh` | Created, rewritten 3 times | Yes — local docker compose |
| `deploy/azure/main.bicep` | Volume mount, probes, tags, scaling, multi-revision, staging app, budget | Yes — what-if |
| `taxonomy-editor/Dockerfile` | Base image tag, entrypoint CMD | Yes — local build + run |
| `.github/workflows/container.yml` | Hadolint threshold, Trivy continue-on-error, arm64 removal | No — CI-only changes |
| `.github/workflows/deploy-azure.yml` | Health check timing, OIDC re-auth, traffic shift retries, blue-green | No — workflow changes (but could dry-run) |
| `.github/workflows/base-image.yml` | Hadolint threshold, Trivy continue-on-error, cron schedule | No — CI-only changes |

---

## Immediate Action Items

**Detection & auto-remediation (stop relying on humans to find problems):**
1. **Set up external health monitoring with auto-rollback** — 60s ping, auto-rollback after 10 consecutive failures. This single change would have caught the ALLOWED_ORIGINS crash and the startup loop before any user noticed. (Opportunity G.1)
2. **Add container restart loop alert + auto-rollback** — KQL alert on ContainerBackOff events. (Opportunity G.3)
3. **Create Orca scheduled daily health audit** — automated drift detection, probe verification, cost check. (Opportunity G.6)

**Observability (make problems self-diagnosing):**
4. **Add structured logging to entrypoint.sh and server startup** — every operation gets a timestamp and duration. Environment snapshot on every container start. (Opportunity E)
5. **Add background copy progress logging and `/status` endpoint** (Opportunity E, items 3-4)

**Prevention (stop problems from reaching production):**
6. **Create `docker-compose.test.yml`** for local entrypoint/startup testing (Opportunity A)
7. **Add Bicep what-if step** to CI or deploy workflow (Opportunity B)
8. **Add base image existence check** to container build workflow (Opportunity C)
9. **Fix Trivy properly** — pin binary version or switch to a working version (current fix is a band-aid)
10. **Create Orca feedback rule** to block ad-hoc CLI config changes (Process Rec #1)
11. **Extend CI smoke test** to mount test data and validate entrypoint (Process Rec #2)
