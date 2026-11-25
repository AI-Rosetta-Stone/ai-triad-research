# Prod state share migration (t/617 design A, t/624)

Status: DRAFT for Security review. Nothing in this runbook has been run. The TL takes it to the PI as one go (t/617, TL p/45#245).

## Why

Prod sets no `AI_TRIAD_STATE_ROOT`, so `getStateRoot()` falls back to the data root, `/mnt/shared` (`taxonomy-editor/src/server/config.ts:142-146`). That puts all of prod's class-A writable state on the Azure Files share `taxonomy-data`. Staging mounts the same share read-only as `taxonomy-data-ro`, so staging code and staging operators can read prod's state. That includes the flight-recorder dumps with personal data (t/579#87) and a legacy key file (t/617#4, #11).

Design A gives prod its own state share, which staging never mounts. Staging already isolates its own state this way (t/2643, `/mnt/staging-state`).

## What moves, and what stays

**Moves to the new share** (every path the server builds from `getStateRoot()` on origin/main 9bc0def4b):

| Path under the state root | Writer | Notes |
|---|---|---|
| `admin/feature-flags.json` | `featureFlags.ts:168` | Prod boots with defaults if this is missing, so it must be copied before the switch. |
| `admin/feature-flags-audit.ndjson` | `featureFlags.ts:169` | Append-only. |
| `admin/runtime-config.json` | `runtimeConfig.ts:517` | Must be copied before the switch. |
| `admin/admin-allowlist.json` | `storage/allowlistStore.ts:35` | Fails closed to empty if missing, so it must be copied before the switch. |
| `admin/provider_bindings.json` | `ai/providerBinding.ts:45` | |
| `admin/telemetry/` (95 files on 2026-11-25) | `routes/admin.ts:844,885` | |
| `flight-recorder/` | `routes/diagnostics.ts`, `server.ts:1242,1301`, `routes/admin.ts:246` | Copied **after** the PI-approved deletion of the shutdown dumps (t/579#90). Only what remains moves. |
| `calibration/core/calibration-log.jsonl`, `calibration/validation-report.json`, `calibration/parameter-history.json` | `routes/diagnostics.ts:92,100,116`, `routes/debates.ts:55`, `lib/debate/calibrationLogger/history.ts:147` | |
| `ai-call-log.jsonl` | `ai/aiCallLog.ts:142` | Append-only. |
| `cache/node-source-index-snapshot-hashes.json` | `storage/snapshotHashCache.ts:37` | A cache; it is fine to leave it behind and let it rebuild. |
| `taxonomy/Origin/policy_actions.lock` | `routes/policyRegistry.ts:136` | A lock file; do not copy it. It is recreated. |
| Analytics NDJSON fallback | `server.ts:1443` | Prod uses Blob analytics, so this is expected to be empty. Confirm at the inventory step. |

**Does not move, and gets deleted:** `.aitriad-key-gemini.enc` (share root, written 2026-04-14). It is a legacy file-mode key store; prod uses Key Vault. It is deleted from `taxonomy-data` after the PI decides on rotation (t/617#11). It is never copied to the new share.

**Stays on `taxonomy-data`** (read from the **data** root by code, so it moves only with TaxonomyServer and Debate Engine's code change in t/625):
`admin/quotas.json`, `proxy-tiers.json`, `authorized-users.json`, `admin/flight-recorder-dumps/`, `node-delete-log.jsonl`, `calibration/` crux registry, `greatest-hits.json` and the situation-statements sidecar, plus all taxonomy and grounding data.

> **Open item for Security (condition 4).** Security asked that nothing left readable to staging carries ids or emails, and that `admin/` and `calibration/users` move in A. The files above are read through the **data** root, so moving them without t/625's code change would make prod fall back to defaults (for example, losing quota overrides). Step 0 checks each of them for ids and emails (counts only). If any carries them, there are two choices: (a) A waits for t/625 for that file, or (b) the TL sets a review date and accepts it in the interim (TL p/45#245: "the interim is acceptable"). `calibration/users/` (6 files) is read through the storage backend (GitHub), not the share. Step 0 also confirms whether the share copy is used at all; if not, it is deleted with the PI's go rather than moved.

## Infrastructure (Bicep, T2)

Two deploys, so that the copy happens between them.

**Phase 1: create and mount, no behaviour change.**
- A new file share `taxonomy-state-prod` on `staitriadkvwl3nywge4iw`, standard tier, 10 GiB quota.
- A new managed-environment storage registration `taxonomy-state-prod` on `cae-aitriad`, ReadWrite.
- The **prod** app gets volume `prod-state` (`storageName: 'taxonomy-state-prod'`) mounted at `/mnt/prod-state`. `AI_TRIAD_STATE_ROOT` is **not** set yet, so prod keeps using `/mnt/shared`.
- The staging app is unchanged.
- **Security condition 1:** a Pester test that parses `main.bicep` and fails if any app other than `containerApp` (prod) references `taxonomy-state-prod`. Bicep has no cross-resource assertion, so the test is the guard.

**Phase 3: switch.**
- Prod gets `AI_TRIAD_STATE_ROOT=/mnt/prod-state` (prod only; staging already overrides it to `/mnt/staging-state`).
- `deploy-azure.yml`'s `ExpectedEnvVars` must list it in the same PR (the `BicepEnvDrift` test enforces that). That is Azure's file, so a T2 change, and DeployAzure is the required reviewer.

**What-if, expected:**
- Phase 1: **Create** on the share and the env storage. **Modify** on the prod container app: one added volume, one added volumeMount, and the image unchanged when dispatched with the running SHA. Nothing on staging.
- Phase 3: **Modify** on the prod container app: one added env var. Nothing else.
- Each what-if runs from the exact dispatch ref before dispatch (the t/612 route check) and is posted on t/624.

## Migration (phase 2, between the two deploys)

The copy runs **inside the prod container**. After phase 1, prod mounts both `/mnt/shared` (old) and `/mnt/prod-state` (new). The data never leaves prod's own container, and no storage role grant is needed. It uses one exec at a time (the exec API takes no shell and limits command length; t/579#86), with a one-line `node -e` that prints counts and hashes only.

0. **Inventory** (read-only, before phase 1): file counts and total bytes for every path in the "moves" table, and the id or email check for the "stays" list (counts only). Posted on t/624.
1. **Write freeze:** no admin changes to flags, runtime config or the allowlist during the window. The PI is the only admin. Append-only files (`ai-call-log.jsonl`, `feature-flags-audit.ndjson`, `admin/telemetry/`, `flight-recorder/`) may lose the lines written between the copy and the switch, typically under a minute. That is accepted, and the count is reported.
2. **Copy:** `fs.cpSync` of each listed path from `/mnt/shared` to `/mnt/prod-state`, preserving timestamps. It prints one JSON line: files copied and bytes per path.
3. **Verify:** sha256 of every copied file on both sides, plus counts. It prints `{path: {files, bytesOld, bytesNew, hashMismatches}}`. **Stop on any mismatch.**
4. **Switch:** the phase 3 deploy through the gated workflow (0%-traffic smoke, persona matrix, warm-gate, auto-rollback).
5. **Read-back on the new revision, before declaring done:**
   - `GET /api/flags` returns the same flag values as the inventory snapshot.
   - The runtime config has the same keys and values (admin route, read-only).
   - The admin allowlist is non-empty, with the same count.
   - New writes land in `/mnt/prod-state`: one telemetry or flight-recorder file has a fresh mtime under `/mnt/prod-state`, and none under `/mnt/shared`.
6. **Delta:** re-hash the old side. Any append-only file that grew after the copy has its extra lines appended to the new side once, and the count is reported. Any config file that changed is a stop condition, because the write freeze was broken.
7. **Delete originals** (**the PI's go**, Security condition 2): delete exactly the copied paths and the key file from `/mnt/shared`, by name, from inside the prod container (prod mounts it read-write). Report counts.
8. **Staging listing** (Security condition 3): the names-and-counts walker from staging's read-only mount (t/617#4) shows none of the moved paths and no key file.

## Rollback

- **Before step 7:** run the gated rollback (`Invoke-GatedRollback.ps1`) to the previous prod revision. That revision still has `AI_TRIAD_STATE_ROOT` unset and reads `/mnt/shared`, where the originals are still intact. Writes made to `/mnt/prod-state` during the window get their append-only lines copied back by the same delta step in reverse. Config changes are frozen, so there are none.
- **After step 7:** the originals are gone. First copy them back from `/mnt/prod-state` to `/mnt/shared` (the same in-container copy and verify, reversed), then roll back.
- Phase 1 alone is harmless to roll back: an unused mount and a new empty share.

## Downtime

None expected. Each phase is a normal revision swap behind the warm-gate, and traffic shifts only when the new revision is ready. The risk is a boot with missing state (default flags or an empty allowlist) if the copy is incomplete. Step 3 blocks the switch on any mismatch, and step 5 checks the result.

## Approvals needed

- **PI:** one go covering the phase 1 and phase 3 deploys, the in-container copy, and the delete in step 7. Plus the separate rotation decision for the key file.
- **Security:** review this runbook and the Bicep PR, and confirm the step 8 listing.
- **TL:** T2 approval, and the vehicle (own PR or train).
- **Azure:** the `deploy-azure.yml` `ExpectedEnvVars` change for phase 3.
