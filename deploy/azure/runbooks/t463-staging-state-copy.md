# t/463: copy the staging state share to staitriadstg19 (PLAN, not run)

Status: DRAFT. Nothing in this file has been run. No copy starts until the PI gives a go on this written plan
(TL p/9#360). Tier T2. PR #5300 stays draft with consult-hold on.

## Scope
- SOURCE: share `taxonomy-data-staging` on storage account `staitriadkvwl3nywge4iw` (the PROD account; this share
  is staging's own state, mounted only by the staging app. Prod mounts `taxonomy-data`).
- DESTINATION: share `taxonomy-data-staging` on storage account `staitriadstg19` (new, created by
  deploy/azure/staging-data-account.bicep in its own staging-only run).
- Out of scope: prod's share `taxonomy-data`, every other share on `staitriadkvwl3nywge4iw`, every prod resource,
  and any delete on the source.

## Preconditions (each is a check, and the run stops if one fails)
P1. PI go recorded on t/463 for THIS plan.
P2. staitriadstg19 exists, AADKERB set, share taxonomy-data-staging exists (same check as the deploy preflight).
P3. Consent owner (Jeffrey) has recorded consent with time on t/463, and the consent text has been checked.
P4. Staging writes are paused for the copy window only (see the pause step). The pause is set up and confirmed
    before the inventory is taken.
P5. BEFORE-RECORD, taken BEFORE the pause (step 1), and saved on t/463 with the time: (a) the complete role
    assignment list on staitriadkvwl3nywge4iw and each of its shares (az role assignment list with --all, and the
    share-scoped lists); (b) the shared-key setting and key-rotation state; (c) the default network action and
    bypass. The P5 record is the reference for condition 3 after the run.

## Step 1: pause staging writes (window starts)
- Pause method (PI-approved, t/463 TL p/9#362): scale the staging app to ZERO replicas for the copy window.
  Scaling to zero stops every write path at once, including the staging-state volume and the shared-data
  volume below. NO ad-hoc `az containerapp update --set-env-vars`.
- Coverage (SO condition b, TL p/9#370): the staging app mounts TWO volumes, and BOTH are covered by the pause:
  (i) `staging-state` (taxonomy-data-staging on the account being copied; the subject of this plan), and
  (ii) `shared-data`, which mounts PROD's share `taxonomy-data` read-write by default (main.bicep line 1086:
  `storageName: (stagingSharedReadOnly || stagingLoadTestSize) ? 'taxonomy-data-ro' : 'taxonomy-data'`).
  Zero replicas stops writes to (ii) as well, so no staging write reaches prod storage during the window.
  Check: the staging app's replica count reads 0 and no replica is running, before the inventory is taken.
- Check: a test write from staging is refused (no replica), proving the pause holds. Record the time.
- Window start time recorded on t/463. HARD STOP at two hours from this time.

## Step 2: frozen inventory of the source (read-only)
- Command: `az storage file list --account-name staitriadkvwl3nywge4iw --share-name taxonomy-data-staging
  --path "" --recursive --auth-mode login --enable-file-backup-request-intent`
  (the backup-intent flag is per the PI's one-off approval; NOT a storage key).
- Record for every file: path, size, Content-MD5 (from `az storage file show` if not in the list).
- Save the inventory to a dated file and record its file count, total bytes and a SHA-256 over the sorted list
  on t/463. This is the frozen record.
- Check: count and bytes are non-zero and the listing completed without error. Any error stops the run.

## Step 3: copy (server-side, no delete)
- Command shape: `azcopy copy "https://staitriadkvwl3nywge4iw.file.core.windows.net/taxonomy-data-staging/*"
  "https://staitriadstg19.file.core.windows.net/taxonomy-data-staging" --recursive --preserve-smb-info=false`
  Authentication: Entra (azcopy login with my identity). No SAS, no account key. Verify on a dry run that azcopy
  accepts Entra auth for Azure Files on this account; if it does not, STOP and report (no key fallback).
- NO delete flags: the command must not contain `--delete-destination`, `remove`, `rm` or `delete`. This is
  asserted by a grep of the command before it runs.
- Check: exit code 0, and azcopy's final summary shows zero failed transfers.

## Step 4: verification
- Re-list the destination (same list command, on staitriadstg19). Compare with the frozen inventory:
  count equal, total bytes equal, the sorted-list SHA-256 equal, and per-file size and MD5 equal.
- Any mismatch: STOP. The source is untouched; re-run the copy only after the cause is recorded.

## Pre-existing grants on the prod account (TL p/9#379): named, NOT changed by this plan
These exist already, are not part of this plan, and must not be changed by it. They are the check's baseline,
not expected changes. The PI decides what happens to the 22 November grants.
- Storage Blob Data Reader on staitriadkvwl3nywge4iw, principal 5abf01bc-a673-4d31-851e-86607dae5f01: granted August 2026.
- Storage Account Backup Contributor on staitriadkvwl3nywge4iw, principal 5abf01bc-a673-4d31-851e-86607dae5f01: granted 22 November 2026.
- Storage File Data SMB Share Contributor on the share taxonomy-data-staging on staitriadkvwl3nywge4iw, principal
  5abf01bc-a673-4d31-851e-86607dae5f01: granted 22 November 2026. This is a WRITE role on the staging share.
  This plan does not use it, and it is not the approved reader.
The reader grant (created 2026-11-23T15:43:55Z) is the only expected change.

## Condition 3 (SO, TL p/9#372): t/92 blob reach to the prod account is unchanged
- Check, before and after the run, against the BEFORE-RECORD (precondition P5):
  (a) RBAC: the role assignments on staitriadkvwl3nywge4iw and its shares must equal the before-record, EXCEPT the
      one expected change named below;
  (b) keys: the shared-key setting and key-rotation state unchanged;
  (c) network: the default action and bypass unchanged.
  Any difference outside the expected change stops the run and is reported on t/463.
- EXPECTED CHANGE (the only one allowed on the prod account, under the PI's approval on t/463):
  - Assignment: Storage File Data SMB Share Reader
  - Scope: the share taxonomy-data-staging on staitriadkvwl3nywge4iw
    (/subscriptions/ba91d835-ea25-49fe-9a86-a2694201ae21/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/fileServices/default/shares/taxonomy-data-staging)
  - Principal: the DevOps identity, object id 5abf01bc-a673-4d31-851e-86607dae5f01
  - Status: CREATED 2026-11-23T15:43:55Z, through the ARM roleAssignments PUT after the CLI call failed with
    MissingSubscription (TL, t/463#103). Verified with `az role assignment list`, and Second Opinion verified the
    grant exists (p/59#106). The before-record (P5) is taken after this grant, so it already includes it.
  - It is a read grant on that one share. It does not change the account's blob reach, keys or network rules,
    and it is not part of the copy itself.

## No-delete assertion (applies to the whole run)
- Before and after: the source's file count, total bytes and SHA-256 must be identical. A change on the source
  stops the run and triggers the rollback.
- The copy command is grep-checked for delete flags (step 3). The source is never a destination.
- Nothing is deleted from either account by this plan. Retiring the old share is a separate PI decision.

## Step 5: end the pause (window ends) — ONLY after the new mount is serving and verified (TL p/9#362 (3))
- Order is fixed and cannot be reversed: the staging app must mount the NEW share (the separate mount change,
  in main.bicep, deployed on the next prod deploy with its own PI go) and be verified serving from it, BEFORE
  staging scales back up. Scaling up earlier would serve writes from the OLD mount.
- Check: the serving revision mounts staitriadstg19's taxonomy-data-staging, a staging write lands on that share,
  and the shared-data volume is the approved mount. Record the time. Window end and total pause (under two hours)
  recorded on t/463.

## State at the stop (written down, per SO condition a, TL p/9#370)
Decision: the mount change is NOT deployed before the copy, because it would point staging at an empty
destination. So at any stop, the state is defined as follows and is never left undefined:
- Staging stays at ZERO replicas (paused). It does not write to the old share, to the new share, or to prod's
  `taxonomy-data`. This is a staging outage for the duration, which the PI accepts for the copy window only.
- The mount is still the OLD share (`staitriadkvwl3nywge4iw`/`taxonomy-data-staging`, unchanged). The source is
  never written or deleted, so it is the intact state of record.
- Two outcomes, decided at the stop, and recorded on t/463:
  (A) copy verified before the stop AND the mount change is approved and deployed: end the pause per Step 5.
  (B) copy NOT verified, or no mount change approved: staging resumes on the OLD mount, scaled back up through the
      approved path (no mount change), the destination copy is discarded and not used, and the rollback is recorded.
- Staying paused past two hours without a PI decision is not allowed: the stop forces (A) or (B).

## Rollback
- Trigger: any failed check, a source change, a copy error, or the two-hour stop with no approved mount change.
- Action: outcome (B) above. Staging resumes on the OLD share (the source is intact and was never deleted), scaled
  back up through the approved path. Record the rollback time and reason on t/463.
- Because the source is never deleted, rollback needs no restore from backup.

## Two-hour stop
- A hard stop at two hours from Step 1. At the stop, the state is set by the "State at the stop" rules above:
  outcome (A) if verified and approved, otherwise outcome (B). Staging is never left paused undecided.

## Open items for the PI (must be settled before the go)
1. The pause method (approved deploy path, not ad-hoc).
2. Whether azcopy accepts Entra auth for this Azure Files share (dry run).
3. The order of the mount change (prod deploy, separate PI go) relative to the pause end.
