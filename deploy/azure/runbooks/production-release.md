# Runbook: Production Release

**Trigger:** New code ready to deploy to production (feature merge, bug fix, or scheduled release)

**Owner:** DevOps/Azure owns the deploy pipeline. App roles own pre-build verification.

## Prerequisites

- Azure OIDC credentials configured in GitHub Actions secrets (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`)
- OAuth secrets configured (`GH_OAUTH_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `AAD_CLIENT_ID`, etc.)
- `ADMIN_USERS` GitHub Actions variable set
- Access to trigger `workflow_dispatch` on the repo

## Conditional Gate: Serialize-Phase Canary (staging, pre-promotion)

If this release touches the **serialize path specifically** — the synthetic-embeddings endpoint (`routes/taxonomy.ts`, `getSyntheticEmbeddingsBuffer`), the chunk-yield JSON serializer (`httpKit.ts` `jsonStringifyChunked`), or the corpus loader (`fileIO.loadSyntheticEmbeddings`) — run the **[serialize-canary](./serialize-canary.md)** probe on a fresh staging revision **before** promoting to production. It exercises *and* asserts the response serialize phase under the loop-sampler — the phase the t/3165 storm-canary silently omitted (phase-blind false-green; t/3236). **Compute-path-only deltas** (worker-pool internals, queue-depth gauges, shed-token observability) leave the serialize tail byte-identical and are **N/A** (t/3236#11) — do not confuse "embeddings load/serve" broadly with the serialize phase this gate guards.

## Step 1: Pre-Build Verification (App Side)

1. Run the full verify gate:
   ```bash
   cd taxonomy-editor && npm run verify
   ```
   This runs tsc (main + server) + eslint + depcruise + vitest + vite build.

2. Ensure working tree is clean of stray files. Commit by **explicit pathspec** — never `git add -A` (it stages overlay files like `AGENTS.md`/`.orca*`).

3. Push to `main`. Wait for CI to complete — all 6 jobs must pass before the deploy workflow will proceed.

## Step 2: Build Container Image

1. Trigger the Container Image workflow using the validated dispatch script (t/2487):
   ```powershell
   ./operations/devops/Invoke-ContainerBuild.ps1 -Sha <full-or-short-sha>
   ```
   The script resolves short SHAs, waits for the full ci.yml run to reach `success`,
   then dispatches. Bare `gh workflow run container.yml` bypasses these guards — do not
   use it directly.

2. Wait for the build to complete (the script prints the run URL; watch it):
   ```bash
   gh run watch <run-id> --exit-status
   ```

3. Verify the image exists in GHCR:
   ```bash
   gh api orgs/ai-rosetta-stone/packages/container/taxonomy-editor/versions --jq '.[0].metadata.container.tags'
   ```

## Step 3: Deploy to Azure

1. Trigger the deploy workflow (**once only** — duplicate dispatches are cancelled). Pass the **commit SHA** you built in Step 2 — the deploy resolves its permanent `sha-<commit>` tag to an immutable `@sha256` digest and pins the revision to it (deploy-by-digest, t/3679). There is **no `image_tag`/`:latest` path** — an empty/missing `sha` aborts with an actionable message:
   ```bash
   gh workflow run deploy-azure.yml --ref main \
     -f environment=production \
     -f auth_mode=optional \
     -f sha=<full-or-short-commit-sha>   # the SAME sha passed to Invoke-ContainerBuild.ps1 in Step 2
   ```

2. Monitor the deploy:
   ```bash
   gh run list --workflow=deploy-azure.yml --limit=1
   gh run watch <run-id>
   ```

3. The workflow automatically:
   - Verifies CI passed for the **deployed commit** (`sha`), not the dispatch HEAD (test-electron + test-container)
   - Resolves the commit's per-SHA tag to an immutable `@sha256` digest and pins to it — aborts fail-closed if the tag is absent (this replaces the old tag-existence check)
   - Runs Bicep what-if (checks for unexpected deletions)
   - Deploys Bicep template (infra + app config) with the digest-pinned image
   - Creates new revision at 0% traffic (pinned to the digest; `IMAGE_DIGEST`/`IMAGE_DEPLOYED_AT` stamped as env)
   - Asserts the revision's resolved image ref equals the intended digest before any traffic shift
   - Health checks the new revision (Phase 1: server up, Phase 2: data loaded)
   - Runs acceptance tests (18 endpoint checks across 8 categories)
   - Shifts 100% traffic to new revision on success
   - Auto-rollback on failure (deactivates failed revision, restores previous)

## Step 4: Post-Deploy Verification

1. Confirm the live revision matches the expected commit:
   ```bash
   gh run view <deploy-run-id> --json headSha --jq '.headSha'
   ```

2. Check production health:
   ```bash
   curl -s https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/health | python -m json.tool
   curl -s https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io/healthz
   ```

3. Or use the PowerShell diagnostics:
   ```powershell
   Import-Module ./scripts/AITriad/AITriad.psm1
   Invoke-TaxEditorSmokeTest -Detailed
   ```

4. Spot-check core flows in browser:
   - Root URL renders (sign-in page or anonymous read-only)
   - Taxonomy tree loads, node detail opens
   - Debate tab loads
   - Sync save-bar shows status
   - Conflict badge degrades gracefully when no conflicts exist

5. Scan flight-recorder logs for startup errors:
   ```bash
   az containerapp logs show --name taxonomy-editor -g ai-triad --type console --tail 50
   ```

## Rollback

If post-deploy issues are found after traffic shift:

1. List revisions and identify the previous good one:
   ```bash
   az containerapp revision list --name taxonomy-editor -g ai-triad \
     --query "[?properties.active].{name:name, traffic:properties.trafficWeight, created:properties.createdTime}" -o table
   ```

2. Shift traffic back to the previous revision:
   ```bash
   az containerapp ingress traffic set --name taxonomy-editor -g ai-triad \
     --revision-weight "<previous-revision>=100"
   ```

3. Deactivate the broken revision:
   ```bash
   az containerapp revision deactivate --name taxonomy-editor -g ai-triad \
     --revision "<broken-revision>"
   ```

The deploy workflow handles this automatically when health checks or acceptance tests fail. Manual rollback is only needed for issues discovered after the workflow completes.

**Rollback-anchor durability (t/3679 + t/3756).** A rollback target is only valid while its image is **tagged** or within the untagged-retention window. `ghcr-cleanup.yml` deletes **untagged** images older than 30 days (keeping the 5 most-recent untagged). Since deploy-by-digest (t/3679) makes `container.yml` push a **permanent `sha-<commit>` tag** for every built image, every deploy-pinnable image now stays **tagged → preserved**, so its digest remains pullable as a rollback target indefinitely — this is the going-forward fix. **Caveat for images built before t/3679 landed:** those were only ever tagged `:latest`, so once `:latest` moved past them they went untagged and prune at ~30 days. To roll back to a pre-t/3679 image, first confirm it still exists (`gh api orgs/ai-rosetta-stone/packages/container/taxonomy-editor/versions`) before relying on it; if you need a specific old digest preserved, tag it durably (`docker buildx imagetools create --tag ghcr.io/ai-rosetta-stone/taxonomy-editor:rollback-<date> <digest-ref>`). To forward-deploy a known-good digest directly, see the recovery path in [digest-pin-upgrade.md](digest-pin-upgrade.md).

## Deploy Hold

**Lifted.** The 2026-07-04 hold (below) was superseded by subsequent authorized deploys (revisions `taxonomy-editor--anonpull` on 2026-07-05, `taxonomy-editor--deploy-d6a05b2-9294` on 2026-07-07) — this note just wasn't updated at the time. No hold is in effect as of 2026-07-07; deploys proceed under normal owner-request authorization.

**2026-07-04 — Owner decision (historical, superseded above): NO production deploy until explicitly authorized.** Current prod is stable on ca8e7428 (July 1 code) against the migrated data. The cc→sit migration (t/1308) landed in the data repo but the code repo has accumulated significant changes (quality gates, doc-accuracy gates, dependency patches, cc→sit code-side tightening). Risk assessment deferred a deploy despite green CI.

## Alerts & Monitoring

### Azure Monitor Alerts (Bicep-managed)

All alerts route to the `ag-aitriad-restart-alert` action group, which emails `ALERT_EMAIL` (GitHub Actions variable). **If `ALERT_EMAIL` is not set, all alerts evaluate but notify nobody** — this was the root cause of the 2026-07-05 outage going undetected.

| Alert | Severity | Trigger | Window |
|-------|----------|---------|--------|
| `alert-image-pull-failure` | 0 (Critical) | Any `ImagePullBackOff` event | 5min eval / 10min |
| `alert-restart-loop` | 1 (Error) | 5+ `ContainerBackOff`/`StoppingContainer`/`ImagePullBackOff` in window | 5min / 10min |
| `alert-github-rate-limit-warning` | 2 (Warning) | Rate limit remaining < 1,000 | 5min / 5min |
| `alert-github-rate-limit-critical` | 1 (Error) | 429 or degraded rate limit | 1min / 5min |
| `alert-github-api-error-spike` | 1 (Error) | 5+ GitHub API errors | 5min / 5min |
| `alert-cache-degraded` | 2 (Warning) | 50+ cache misses | 5min / 5min |
| `alert-fallback-active` | 1 (Error) | App serving from fallback data | 5min / 5min |
| `alert-paid-fallback-overflow` | 2 (Warning) | Paid Gemini fallback key served a request (free pool exhausted → billable overflow; expect ~0) | 15min / 60min |
| `alert-branch-divergence` | 3 (Info) | Session branch 10+ commits behind | 15min / 15min |

### External Availability Probe (GitHub Actions)

`health-monitor.yml` runs every 15 minutes, checking `/health`, `/healthz`, and `/api/data/available`. 3/3 consecutive failures create a GitHub issue with label `health-alert`. Recovery auto-closes the issue. This catches connection timeouts (the 2026-07-05 outage signature — curl returns "000" on timeout).

**Owner action:** watch the repository for issues with the `health-alert` label to receive email notifications.

### Response Steps

1. **ImagePullBackOff alert:** Check GHCR package visibility (`ghcr.io/ai-rosetta-stone/taxonomy-editor` must be public). Verify `registries` is empty on the container app (`az containerapp show --name taxonomy-editor -g ai-triad --query 'properties.configuration.registries'`). If a credential was re-added, remove it and create a new revision.
2. **Restart loop alert:** Check container logs (`az containerapp logs show --name taxonomy-editor -g ai-triad --type console`). May indicate app crash, OOM, or bad deploy. Rollback to previous revision if needed.
3. **Health check issue:** Run `Invoke-TaxEditorSmokeTest -Detailed` for full diagnosis. Check Azure status page for platform outages.

## Registry Auth (GHCR)

**`ghcr.io/ai-rosetta-stone/taxonomy-editor` must remain a public package.** Anonymous pulls are the production auth mode — no registry credentials are configured on the container apps. A visibility flip on the GHCR package = outage.

If the image ever needs to go private, design around **ACR + managed identity**. Do not rotate or re-add a PAT — PATs rot, and the 2026-07-05 outage (expired GHCR PAT → ImagePullBackOff on every replica recycle) is the proof.

**Snapshot semantics:** ACA bakes registry credentials into the **revision snapshot at revision-creation time**. Changing app-level registry config (adding, removing, or updating credentials) does NOT affect existing revisions — restarts of a pre-existing revision still pull with whatever credential was frozen in its snapshot. To apply a registry config change, you must create a **new revision** (revision copy). `az containerapp registry remove` exits 0 even when ARM rejects the change (409 ContainerAppRegistryInUse) — always read back `properties.configuration.registries` to verify.

## Known Issues

- **Duplicate dispatch**: `gh workflow run` occasionally emits two `workflow_dispatch` events. The deploy workflow has `cancel-in-progress: true` so the duplicate is cancelled automatically. If you see a failed run alongside a successful one for the same commit, check both before investigating.
- **BCP318/BCP422 warnings**: `runner/runner.bicep` emits null-safety warnings during every deploy. These are cosmetic — the runner module is disabled (`enabled=false`) and the warnings don't affect the Container App deployment.
- **AlertsManagement RP warnings**: Bicep may emit stderr warnings about the AlertsManagement resource provider. These don't affect deployment (`failOnStdErr: false` is set).
