# Production Rollback Design — AI Triad Research

**Author:** Technical Lead
**Date:** 2026-06-23
**Status:** Draft — awaiting review
**Ticket:** t/861

---

## Problem Statement

The project has a blue-green deployment mechanism that implicitly handles rollback (a failing new revision never gets traffic), but there is no documented, formalized rollback strategy that covers all the systems that comprise a production release:

1. **Azure Container Apps** — web application serving
2. **Electron desktop app** — local application
3. **Taxonomy data** — structured JSON in `AI-Rosetta-Stone/ai-triad-data` via GitHub API
4. **User content** — chats, debates, API keys in Azure Blob Storage
5. **Infrastructure** — Bicep-managed Azure resources

Without a documented strategy, rollback depends on tribal knowledge and ad-hoc investigation — as demonstrated by the 2026-06-22 ImagePullBackOff outage where the old revision silently kept serving traffic while the new one failed to start.

---

## Current State

### What Exists

| Layer | Mechanism | Automated? | Documented? |
|---|---|---|---|
| ACA revision | Blue-green: deploy at 0% → health check → acceptance tests → traffic shift. Auto-rollback deactivates failed revision, keeps old at 100%. | Yes (deploy-azure.yml:501-516) | Workflow comments only |
| Health monitor | 15-min cron checks /health + /api/data/available. Creates GitHub issue on 3 consecutive failures, auto-closes on recovery. | Yes (health-monitor.yml) | Workflow header |
| Staging | Auto-deploys after container build. Validates before production. | Yes (deploy-staging.yml) | Workflow header |
| Container image | CI gate + image verification before deploy. Trivy scan + SBOM. | Yes (container.yml) | Workflow header |
| Taxonomy data | Git-backed via GitHub API. Full history. Session branches isolate edits. | Manual (`git revert`) | No |
| User content | Azure Blob Storage. No versioning enabled. | None | No |
| Electron desktop | Manual download. No auto-updater. | None | No |
| Infrastructure | Bicep IaC with what-if preview. Delete guard fails the deploy. | Partial | No |

### What's Missing

1. **Manual rollback runbook** — when automated rollback isn't enough (e.g., bad data, infra drift)
2. **Data rollback** — reverting taxonomy changes that shipped with a bad release
3. **User content rollback** — recovering from Azure Blob corruption or accidental deletion
4. **Post-incident review trigger** — no formal process after a rollback
5. **Rollback testing** — no verification that the rollback mechanism itself works

---

## Design

### Rollback Tiers

Not all failures need the same response. Define three escalation tiers:

| Tier | Trigger | Response | Who | RTO |
|---|---|---|---|---|
| **T1 — Revision rollback** | Health check fails, acceptance test fails, feature regression | Shift traffic to previous ACA revision | Automated / DevOps | < 2 min (automated), < 10 min (manual) |
| **T2 — Image rollback** | Bad image (crash loop, missing files, wrong base) | Redeploy previous known-good image tag | DevOps (manual) | < 15 min |
| **T3 — Data rollback** | Taxonomy corruption, bad migration, data loss | Revert data commits, restore blob backups | TL + DevOps | < 30 min |

### T1 — Revision Rollback (Automated + Manual)

**Automated (already implemented):**
The deploy workflow (deploy-azure.yml:501-516) handles this:
1. New revision deployed at 0% traffic
2. Two-phase health check: server up (Phase 1) + data loaded (Phase 2)
3. Acceptance tests: 8 categories, ~20 checks against the 0% revision
4. If unhealthy or tests fail → deactivate new revision → keep old at 100%
5. Failure diagnostics collected (revision status, console logs, system events)

**Manual rollback** (when automated didn't catch the issue):

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# See what's running
Get-TaxEditorRevision                          # list all revisions with status + traffic

# Roll back to the previous revision
Switch-TaxEditorRevision -Previous             # shift traffic to previous GREEN, deactivate current

# Or target a specific revision
Switch-TaxEditorRevision -Revision 'taxonomy-editor--deploy-abc1234-5678'

# Verify
Test-TaxEditorHealth
```

**When to use:** Feature regressions caught after traffic shift, performance degradation, intermittent errors not caught by acceptance tests.

### T2 — Image Rollback

When the container image itself is the problem (not just the ACA revision):

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# See what images are available in GHCR
Get-TaxEditorImage                             # list GHCR tags with dates + digest

# Deploy a specific image tag (follows blue-green: 0% → health check → promote)
Deploy-TaxEditorImage -Tag '0.8.0'

# Or deploy by digest for certainty
Deploy-TaxEditorImage -Digest 'sha256:abc123...'

# Verify
Invoke-TaxEditorSmokeTest
```

**When to use:** Crash loops, missing dependencies in the image, wrong base image, container won't start at all.

### Known Good Image — Golden Rollback Anchor

A manually designated "Known Good" image serves as the guaranteed rollback target. When production is stable and verified, the operator tags the current image as `known-good`. At any point, a single cmdlet rolls back to that image.

**Invariants:**
- Exactly one `known-good` tag exists in GHCR at any time. Tagging a new image as known-good removes the tag from the previous one.
- The `known-good` image is never garbage-collected — it persists until replaced.
- Rolling back to the known-good image makes it the GREEN (active, 100% traffic) revision. Subsequent deploys follow the normal BLUE (0% traffic → health check → acceptance tests → promote to GREEN) flow.

**GHCR tag model:**

```
ghcr.io/ai-rosetta-stone/taxonomy-editor:latest        ← most recent build
ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1         ← semantic version from git tag
ghcr.io/ai-rosetta-stone/taxonomy-editor:known-good    ← operator-designated golden image (exactly one)
```

**Blue-Green lifecycle with Known Good:**

```
Normal deploy:
  BLUE (new image, 0% traffic) → passes tests → promoted to GREEN (100%) → old GREEN deactivated

Rollback to Known Good:
  known-good image deployed as new revision → becomes GREEN (100%) → bad revision deactivated

Next deploy after rollback:
  New image deploys as BLUE (0%) → normal promotion flow resumes
```

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# After verifying production is stable — tag current image as the golden rollback target
Invoke-TaxEditorSmokeTest
Set-TaxEditorKnownGood

# Production is broken — roll back to the known-good image immediately
Restore-TaxEditorKnownGood
Invoke-TaxEditorSmokeTest
```

### T3 — Data Rollback

#### Taxonomy Data (GitHub-backed)

Taxonomy data lives in `AI-Rosetta-Stone/ai-triad-data` and is accessed via GitHub API. Full git history is preserved.

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# Show recent data commits
Get-TaxEditorDataCommit -Last 20

# Revert a bad commit (creates a new revert commit — safe for shared repos)
Undo-TaxEditorDataCommit -Sha 'abc1234'

# Force the server to reload data immediately (otherwise < 5 min poll)
Sync-TaxEditorData
```

**Session branch isolation:** Per-user edits live on `api-session/{userId}` branches. A bad edit from one user doesn't affect others until their PR is merged.

```powershell
# Reset a user's session branch to main (discards their uncommitted edits)
Reset-TaxEditorSession -UserId 'jpsnover'
```

#### User Content (Azure Blob)

Chats, debates, and encrypted API keys live in Azure Blob Storage. Currently no versioning.

**Immediate improvement needed (see Recommendations):** Enable Azure Blob soft-delete (7-day retention) and versioning. Until then, data recovery depends on the container's in-memory state and GitHub-backed community content.

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# List soft-deleted blobs (requires soft-delete enabled — see P0 recommendation)
Get-TaxEditorBlob -Deleted

# Restore a soft-deleted blob
Restore-TaxEditorBlob -Container 'users' -Path 'jpsnover/chats/chat-123.json'
```

### Electron Desktop Rollback

The Electron app has no auto-updater. Users manually download builds. Rollback means:

1. User downloads the previous version from the GitHub Releases page
2. Installs over the current version (NSIS installer on Windows, DMG on macOS)
3. Local data (chats, debates, settings) is preserved — stored in `%APPDATA%/taxonomy-editor/`, not in the app directory

**No automated mechanism needed** at current scale (~10 users). If we add auto-update later, include a "rollback to previous version" option in the app settings.

### Infrastructure Rollback (Bicep)

Bicep deployments are idempotent. The deploy workflow includes a `what-if` preview that fails on unexpected resource deletions.

```powershell
Import-Module ./scripts/AITriad/AITriad.psm1

# Preview what a Bicep deployment would change (dry run)
Test-TaxEditorInfra

# Deploy infrastructure from a specific commit (rolls back Bicep changes)
Deploy-TaxEditorInfra -Commit 'abc1234'
```

**Danger zone:** Some Bicep changes are irreversible (storage account deletion, Key Vault purge). The `what-if` delete guard protects against accidental deletes, but won't catch semantic changes (e.g., changing a Key Vault access policy that locks out the managed identity).

---

## Monitoring & Detection

### Current Detection

| Signal | Latency | Scope |
|---|---|---|
| Deploy acceptance tests | 0 (pre-traffic) | Server health, API layer, data, frontend |
| Health monitor cron | ≤ 15 min | /health + /api/data/available |
| Flight recorder | Continuous | Client-side errors (requires user to submit) |
| Manual observation | Variable | Everything else |

### Gap: Post-Traffic-Shift Regression

The acceptance tests run against the 0% revision. After traffic shifts, there's a 15-minute gap before the health monitor runs. A regression that only manifests under real traffic (load-dependent, auth-dependent) could go unnoticed.

**Recommendation:** Add a post-deploy verification step (already partially implemented at deploy-azure.yml:524-566 as `continue-on-error: true`). Promote this to a hard failure that triggers rollback if critical checks fail.

---

## Recommendations (Implementation Tickets)

### P0 — Immediate

1. **Rollback cmdlet suite** — Implement the full cmdlet suite in the PowerShell module. Owner: PowerShell.

   | Cmdlet | Tier | What It Does |
   |---|---|---|
   | `Get-TaxEditorRevision` | T1 | List ACA revisions with status, traffic weight, health, image tag |
   | `Switch-TaxEditorRevision` | T1 | Shift traffic to a specific or previous revision. `-Previous` for quick rollback |
   | `Get-TaxEditorImage` | T2 | List GHCR image tags with dates, digests, and `known-good` indicator |
   | `Deploy-TaxEditorImage` | T2 | Deploy a specific image tag or digest via blue-green flow (0% → health → promote) |
   | `Set-TaxEditorKnownGood` | T2 | Tag current production image as `known-good` in GHCR. Removes previous tag |
   | `Restore-TaxEditorKnownGood` | T2 | Deploy `known-good` image, make it GREEN. Fails if no known-good tag exists |
   | `Get-TaxEditorDataCommit` | T3 | Show recent commits in `ai-triad-data` repo |
   | `Undo-TaxEditorDataCommit` | T3 | Revert a specific data commit (git revert, not reset) |
   | `Sync-TaxEditorData` | T3 | Force server to reload data from GitHub (bypass poll interval) |
   | `Reset-TaxEditorSession` | T3 | Reset a user's session branch to main |
   | `Get-TaxEditorBlob` | T3 | List blobs or soft-deleted blobs in user content storage |
   | `Restore-TaxEditorBlob` | T3 | Undelete a soft-deleted blob (requires soft-delete enabled) |
   | `Test-TaxEditorInfra` | Infra | Bicep what-if dry run — preview infrastructure changes |
   | `Deploy-TaxEditorInfra` | Infra | Deploy Bicep from a specific commit (infra rollback) |

   All cmdlets support `-WhatIf`/`-Confirm` on destructive operations. All use `New-ActionableError` on failure. Prerequisites: `$env:GITHUB_TOKEN` (for GHCR/data), `az` CLI logged in (for ACA/Blob/Bicep).

   Acceptance criteria:
   - (a) `Set-TaxEditorKnownGood` + `Restore-TaxEditorKnownGood`: exactly-one invariant enforced, health check gate on restore
   - (b) `Switch-TaxEditorRevision -Previous`: one-command production rollback with traffic shift + deactivation
   - (c) `Deploy-TaxEditorImage`: full blue-green (0% → health check → promote to GREEN)
   - (d) `Undo-TaxEditorDataCommit`: creates revert commit (never force-pushes main)
   - (e) All cmdlets discoverable via `Get-Command *TaxEditor*`

2. **Enable Azure Blob soft-delete + versioning** — 7-day retention window for all user content. Zero-code change, pure infrastructure (Bicep param). Without this, `Restore-TaxEditorBlob` has nothing to restore. Owner: Azure/DevOps.

### P1 — Near-term

3. **Add `GET /api/admin/rollback/status`** — Returns: current active revision, previous revision name, deploy SHA, deploy timestamp, image tag, known-good image tag (if set). Gives the admin a one-call view of what's running and what to roll back to. Owner: ServerAPI.

4. **Promote post-deploy verification** — Make the post-traffic-shift smoke test (deploy-azure.yml:524) a hard gate. If it fails, auto-rollback to the previous revision. Currently `continue-on-error: true` means failures are logged but ignored. Owner: DevOps/Azure.

5. **Add rollback test to CI** — A workflow that deploys to staging, verifies health, then intentionally deploys a "bad" image (health endpoint returns 500), and verifies the rollback fires and restores the previous revision. Run monthly or on deploy workflow changes. Owner: DevOps.

### P2 — Future

6. **Electron auto-updater** — When user base grows beyond ~20, implement `electron-updater` with GitHub Releases as the update source. Include rollback capability (keep previous version's asar, switch on failure).

7. **Canary deployment** — Instead of 0% → 100%, shift traffic gradually (10% → 50% → 100%) with error-rate monitoring between each step. Requires Azure Monitor integration to compare error rates between revisions.

---

## Case Study: 2026-06-22 ImagePullBackOff Outage

**What happened:** A deploy created a new revision that referenced stale GHCR registry credentials (an expired PAT). The new revision entered ImagePullBackOff — it couldn't pull the container image. ACA's multiple-revision mode meant the old revision kept serving traffic at 100%, so the app appeared functional from the outside.

**Why automated rollback didn't fire:** The deploy workflow's health check targets the new revision's direct URL. When the new revision never started (ImagePullBackOff), the health check correctly detected failure and the workflow should have rolled back. However, the root cause was a credential issue in the ACA configuration — stale `registries` entries — not a bad image. The fix was removing the stale credential so ACA could pull anonymously from public GHCR.

**Lessons:**
1. ACA multi-revision mode is an implicit safety net — a failing new revision doesn't take down the app
2. Credential/config issues are harder to diagnose than code bugs — the image was fine, the pull mechanism was broken
3. The deploy workflow now includes a post-deploy cleanup step (commit ab969c6d) that removes stale registry credentials
4. Monitor for ImagePullBackOff in system logs, not just health endpoint failures

---

## Decision Record

This design does NOT propose an ADR because rollback is an operational process, not a one-way-door architectural decision. The rollback tiers and runbook procedures can evolve without requiring a formal supersession process. If we later adopt canary deployments (P2.7) or add a deployment orchestrator, that architectural change would warrant an ADR.
