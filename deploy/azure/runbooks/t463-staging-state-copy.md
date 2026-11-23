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

## Step 1: pause staging writes (window starts)
- Pause method: set staging to take no writes during the window. The method must be approved with the PI
  (open item). Default: staging ingress disabled through the approved deploy path. NO ad-hoc `az containerapp update`.
- Check: staging health endpoint shows no writes; a test write to the staging state share from staging fails or
  is refused, proving the pause holds. Record the time.
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

## No-delete assertion (applies to the whole run)
- Before and after: the source's file count, total bytes and SHA-256 must be identical. A change on the source
  stops the run and triggers the rollback.
- The copy command is grep-checked for delete flags (step 3). The source is never a destination.
- Nothing is deleted from either account by this plan. Retiring the old share is a separate PI decision.

## Step 5: end the pause (window ends)
- Restore staging writes through the approved path, with the staging app on the NEW mount only after the Step 3
  of the separate mount change has been deployed (prod deploy, separate PI go). Until then, the staging app still
  mounts the old share, so restoring writes before the mount change would write to the OLD share. Order matters:
  the pause is not ended until the mount is confirmed (see the rollback and open items).
- Check: a staging write lands on the path the staging app actually mounts. Record the time. Window end recorded on
  t/463, total pause time recorded (must be under two hours).

## Rollback
- Trigger: any failed check, a source change, a copy error, or the two-hour stop.
- Action: staging stays on the OLD share (the source is intact and was never deleted), restore staging writes
  through the approved path, and record the rollback time and reason on t/463.
- Because the source is never deleted, rollback needs no restore from backup.

## Two-hour stop
- A hard stop at two hours from Step 1. If the copy has not verified by then, roll back (above) and report.

## Open items for the PI (must be settled before the go)
1. The pause method (approved deploy path, not ad-hoc).
2. Whether azcopy accepts Entra auth for this Azure Files share (dry run).
3. The order of the mount change (prod deploy, separate PI go) relative to the pause end.
