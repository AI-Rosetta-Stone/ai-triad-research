# Staging load-test harness (t/4180)

Measures taxonomy-editor's per-container session capacity on **staging only**. Never point
this at prod — the PS wrapper (`Invoke-TaxEditorLoadTest`) is the only supported entry point
and refuses any `-BaseUrl` that doesn't look like the staging host.

## What it measures

A ramp of concurrent virtual users (default `5, 10, 25, 50, 100`) against three workload
profiles, for a fixed duration per step (default 60s):

- **Reader** — browses the taxonomy (`GET /api/taxonomy-dirs`, `GET /api/taxonomy/:pov`).
- **Editor** — reader traffic plus an idempotent save roughly every 2 minutes of VU
  lifetime, against staging's own data (never prod — this harness only ever runs against
  staging, enforced by the PS wrapper).
- **Debater** — a real AI-generation call (`POST /api/ai/generate`) against a **free-tier,
  non-Gemini** backend. See "Debater profile backend choice" below.

Each VU bootstraps one anonymous session (`GET /.auth/anonymous`, Azure Easy Auth's contract)
before its loop and sends that cookie on every request. **Without it, every `/api/*` call
gets served the HTML sign-in interstitial** — a 200 OK that looks like success but exercises
nothing real (found by inspecting the first live run's suspiciously flat latency; confirmed
via direct curl). Do not remove the bootstrap call to "simplify" this driver.

**Known blocker as of this writing (filed on t/4180):** `GET /api/taxonomy/:pov` 500s for
*every* anonymous request on staging — `ActionableError: Taxonomy file not found:
/mnt/shared/taxonomy/Origin/acc.json`, even though `GET /api/taxonomy-dirs` reports `Origin`
as the only available directory. This is a staging data/path defect, not a load-induced
failure (reproduces at concurrency=1) — reader and editor profile results are not meaningful
until it's fixed. Debater is unaffected (doesn't call this route).

At each step it records: p50/p95 latency, error rate, requests/sec, and the GitHub
`x-ratelimit-remaining` core-quota value (one cheap `gh api rate_limit` call per step).
Container CPU/memory and the GitHub budget's Azure-side view come from the PS wrapper via
`az monitor metrics`, not from this script.

## Debater profile backend choice

The ticket asks for a debate "against a stub AI backend so it spends no Gemini quota."
As of t/4180, the server has **no stub/mock debate-backend mode** (`featureFlags.ts` has no
such flag, and `ai-models.json` defines no test-only backend id) — adding one would be a
server-side change outside this ticket's scope. Instead, the harness defaults
`--debater-backend` to `groq-openai-gpt-oss-20b`: a real, free-tier, **non-Gemini** backend,
which satisfies the ticket's literal requirement (no Gemini quota spent) without inventing
new server surface. Override with `-DebaterBackend` on the PS wrapper if a different
free-tier id is preferred.

## Running it

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1
Invoke-TaxEditorLoadTest -BaseUrl https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io
```

Optional parameters: `-Levels 5,10,25,50,100`, `-DurationSec 60`, `-Profiles reader,editor,debater`,
`-DebaterBackend <id>`, `-OutDir <path>`, `-TargetCpu 2.0`, `-TargetMemory 4Gi`,
`-SkipResourceMatch`, `-SkipAzureMetrics` (for a dry run without `az` access).

**Staging's own size is 0.25 vCPU / 0.5Gi (`deploy/azure/main.bicep`) — different from
prod's 2.0 vCPU / 4Gi.** The cmdlet checks this and **warns, but does not resize staging
itself** (a cpu/memory change to a shared Azure resource is a manual, human-confirmed
step). To measure prod-equivalent per-container capacity, resize staging first:

```sh
az containerapp update --name taxonomy-editor-staging --resource-group ai-triad --cpu 2.0 --memory 4Gi
# ... run Invoke-TaxEditorLoadTest ...
az containerapp update --name taxonomy-editor-staging --resource-group ai-triad --cpu 0.25 --memory 0.5Gi
```

The cmdlet:
1. Refuses to run if `-BaseUrl` doesn't contain `staging` (prod guard).
2. Records the container app's current replica scale and size (`az containerapp show`),
   and warns (see above) if the size doesn't match `-TargetCpu`/`-TargetMemory`.
3. Issues one untimed warm-up GET (staging scales to zero when idle — the first real
   request of any run is dominated by cold-start, not steady-state capacity).
4. Runs the ramp via `run-load-test.mjs` for each requested profile/level.
5. Samples `az monitor metrics` (CPU %, memory working set) for the container app over
   each step's time window.
6. Restores the container app's **replica** scale to what it was in step 2 — **always**,
   even on failure (`finally`). It never touches cpu/memory, so if you resized staging
   manually per the snippet above, restoring the size afterward is on you too.
7. Prints a one-page result: the lowest concurrent-session count at which p95 > 2s or
   error rate > 1%, which resource gave out first (from the CPU/memory/GitHub-budget
   numbers alongside that step), and a per-profile breakdown (editors are expected to hit
   the GitHub API budget before CPU/memory, per t/4180#1 — more replicas won't help them).

## Running the driver directly (not recommended)

`run-load-test.mjs` has no prod guard of its own — that lives in the PS wrapper. Only run it
directly against a URL you have already verified is staging:

```sh
node operations/devops/load-test/run-load-test.mjs \
  --base-url https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io \
  --levels 5,10,25,50,100 --duration-sec 60 --profiles reader,editor,debater \
  --out results.json
```

## Tests

```sh
node --test operations/devops/load-test/load-test-core.test.mjs
```

Pure percentile/verdict logic only — `run-load-test.mjs` and the PS wrapper are integration
code, exercised by actually running against staging, not unit-tested.
