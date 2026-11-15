<#
.SYNOPSIS
    Reconciles the staging Container App env template to main.bicep: syncs baseEnv literal drift AND
    (Phase-2, t/3345) REMOVES orphaned keys — live keys bicep no longer declares. Idempotent — exits 0
    no-op if already in sync. (t/2630; Phase-2 flip TL GV t/3345#15 + Second Opinion e/144#2.)

    Fail-closed guards before any removal: the membership-superset guard (Test-ManagedNamesSuperset),
    the mass-removal circuit breaker (orphan-count cap), and the staging-only app-name guard.

.PARAMETER MockCurrentEnvPath
    Testing only: path to a JSON file whose content replaces the az containerapp
    show query. Eliminates the real Azure call so tests run without credentials.

.PARAMETER DryRun
    Testing only: skip the az containerapp update calls. Exits 2 if drift OR an orphan removal would
    occur, 0 if in sync, 1 if a fail-closed guard trips. Proves the plan without touching Azure.
#>
[CmdletBinding()]
Param(
    [string] $BicepPath,
    [string] $AppName         = 'taxonomy-editor-staging',
    [string] $ResourceGroup   = 'ai-triad',
    [string] $MockCurrentEnvPath,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BicepPath) {
    $BicepPath = Join-Path $PSScriptRoot '../../deploy/azure/main.bicep'
}

$isStaging = $AppName -like '*-staging*'
$getEnvArgs = @{ BicepPath = $BicepPath }
if ($isStaging) { $getEnvArgs['ForStaging'] = $true; $getEnvArgs['RequireStagingAppId'] = $true }  # t/77 Option B
$BicepEnv = & (Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1') @getEnvArgs
if ($BicepEnv.Count -eq 0) {
    Write-Error "Get-BicepBaseEnv.ps1 returned 0 entries — Bicep parse failed or baseEnv block is empty"
    exit 1
}

# Get full managed-name set (all key names bicep declares, including non-literal values)
# Used to safely scope orphan detection — a key absent from this set was removed from bicep. (t/3345)
$getEnvArgsNamesOnly = @{ BicepPath = $BicepPath; NamesOnly = $true }
if ($isStaging) { $getEnvArgsNamesOnly['ForStaging'] = $true }
$ManagedNames = & (Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1') @getEnvArgsNamesOnly

# Fail-closed membership-superset guard (t/3345, TL cond-3 t/3345#8): NamesOnly MUST contain EVERY
# literal-value key — not merely a larger COUNT (a dropped literal key offset by a spurious
# non-literal match passes a count check, then gets deleted live). The set-logic is the pure,
# directly-tested Test-ManagedNamesSuperset (t/2971 Guard Testability, TL t/3345#14).
. (Join-Path $PSScriptRoot 'Test-ManagedNamesSuperset.ps1')
$supersetVerdict = Test-ManagedNamesSuperset -LiteralKeys @($BicepEnv.Keys) -ManagedNames $ManagedNames
if (-not $supersetVerdict.Ok) {
    Write-Error ("Get-BicepBaseEnv.ps1 -NamesOnly failed the membership-superset guard: " +
        "$(@($ManagedNames).Count) name(s) returned; literal key(s) missing from the managed-name set: " +
        "[$($supersetVerdict.Missing -join ', ')]. NamesOnly must contain every literal key. " +
        "Aborting reconcile to prevent mass-wipe of env vars. (t/3345)")
    exit 1
}

# Get current staging env vars from the active template
if ($MockCurrentEnvPath) {
    $CurrentEnvJson = Get-Content $MockCurrentEnvPath | ConvertFrom-Json
} else {
    $CurrentEnvJson = az containerapp show --name $AppName -g $ResourceGroup `
        --query 'properties.template.containers[0].env' -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        Write-Error "az containerapp show failed (exit $LASTEXITCODE)"
        exit 1
    }
}

$CurrentMap = @{}
$SecretNamesBefore = [System.Collections.Generic.List[string]]::new()
foreach ($e in @($CurrentEnvJson)) {
    # az returns secret-backed vars as {secretRef:'x', value:''} — skip them from the reconcile map
    # (filtering only on value-property presence misses this: empty string passes). Record their names
    # so the post-removal verification (SO e/144#2 cond 2) can assert none were touched.
    $secretRefProp = $e.PSObject.Properties['secretRef']
    if ($null -ne $secretRefProp -and $secretRefProp.Value -ne '') { $SecretNamesBefore.Add($e.name); continue }
    $valProp = $e.PSObject.Properties['value']
    if ($null -ne $valProp) { $CurrentMap[$e.name] = $valProp.Value }
}

# Workflow-injected keys set per-revision at deploy time — not bicep-managed.
# Exclude from orphan detection so they don't trigger false positives. (t/3345)
$WorkflowManagedKeys = @('DEPLOY_TAG', 'DEPLOY_SHA')

# Idempotency check — skip update if all literal keys already match
$Drifted = [System.Collections.Generic.List[string]]::new()
foreach ($key in $BicepEnv.Keys) {
    if ($CurrentMap[$key] -ne $BicepEnv[$key]) {
        $Drifted.Add("$key (was='$($CurrentMap[$key])', expected='$($BicepEnv[$key])')")
    }
}

# Orphan check: live app-template env keys absent from the full bicep managed set.
# A key removed from bicep but still in the live ACA template is stale standing-state. (t/3345)
$Orphans = @($CurrentMap.Keys | Where-Object { $_ -notin $ManagedNames -and $_ -notin $WorkflowManagedKeys })

if ($Drifted.Count -eq 0 -and $Orphans.Count -eq 0) {
    Write-Host "Staging baseEnv matches Bicep — no update needed"
    exit 0
}

if ($Drifted.Count -gt 0) {
    Write-Host "Drift detected in $($Drifted.Count) key(s):"
    $Drifted | ForEach-Object { Write-Host "  $_" }
}

# ── Orphan handling — Phase-2 LIVE removal (t/3345; TL GV t/3345#15; Second Opinion e/144#2) ──
# The reconcile now DELETES live env keys bicep no longer declares. Two SO fail-closed guards run
# BEFORE any removal — and in DryRun too, so they abort the PLAN, not just the apply.
$StagingAppName   = 'taxonomy-editor-staging'  # SO cond 3: removal is staging-only (guard below)
$OrphanRemovalCap = 3                           # SO cond 1: mass-removal circuit breaker
if ($Orphans.Count -gt 0) {
    Write-Host ("Orphan(s) on the live template not in the bicep managed set (removed from bicep): " +
        "$($Orphans -join ', ') (t/3345)")

    # SO cond 1 (e/144#2) — mass-removal CIRCUIT BREAKER. The membership-superset guard catches an
    # empty/short managed set (incl. the vacuous ∅⊆everything case), but cap the blast radius
    # regardless: real drift arrives 1–2 keys at a time, so an orphan set larger than the cap signals
    # a bicep-PARSE failure, not drift → abort WITHOUT removal, fail-closed, naming the trip.
    if ($Orphans.Count -gt $OrphanRemovalCap) {
        Write-Error ("::error::Orphan-removal CIRCUIT BREAKER: $($Orphans.Count) orphans exceed the cap " +
            "of $OrphanRemovalCap — [$($Orphans -join ', ')]. A set this large signals a bicep-parse " +
            "failure, not real drift. Aborting WITHOUT removal to prevent a staging env mass-wipe; " +
            "investigate Get-BicepBaseEnv parsing. (t/3345, SO e/144#2 cond 1)")
        exit 1
    }

    # SO cond 3 (e/144#2) — STAGING-ONLY, enforced in CODE not convention. Live --remove-env-vars is
    # destructive and this incremental model is WRONG for prod (prod reconciles via a wholesale ARM
    # redeploy). A future "reconcile prod too" reuse must hit this guard, not succeed accidentally.
    if ($AppName -ne $StagingAppName) {
        Write-Error ("::error::Refusing orphan removal: -AppName '$AppName' is not the staging app " +
            "'$StagingAppName'. This incremental reconcile is staging-only; prod reconciles via its " +
            "wholesale ARM redeploy. (t/3345, SO e/144#2 cond 3)")
        exit 1
    }
}

if ($DryRun) {
    if ($Orphans.Count -gt 0) { Write-Host "[DryRun] Would REMOVE orphan(s): $($Orphans -join ', ')" }
    if ($Drifted.Count -gt 0) { Write-Host "[DryRun] Would set-env-vars for drifted key(s)." }
    exit 2
}

# ── LIVE apply (synchronous, no --no-wait, so failures surface + the next revision inherits the
#    updated template — t/2630 TL condition) ──
if ($Drifted.Count -gt 0) {
    $EnvArgs = @($BicepEnv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Write-Host "Syncing baseEnv drift to Azure..."
    az containerapp update --name $AppName -g $ResourceGroup --set-env-vars @EnvArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "az containerapp update (--set-env-vars) failed (exit $LASTEXITCODE)"; exit 1 }
    Write-Host "Staging baseEnv drift synced."
}

if ($Orphans.Count -gt 0) {
    # SO cond 2 (e/144#2) — LOUD removal log (job summary, not verbose-only).
    Write-Host ("::warning::Phase-2 reconcile REMOVING $($Orphans.Count) orphaned staging env key(s): " +
        "$($Orphans -join ', ') (t/3345)")
    az containerapp update --name $AppName -g $ResourceGroup --remove-env-vars @Orphans
    if ($LASTEXITCODE -ne 0) { Write-Error "az containerapp update (--remove-env-vars) failed (exit $LASTEXITCODE)"; exit 1 }

    # SO cond 2 (e/144#2) — POST-REMOVAL VERIFICATION. Re-read the live template and assert the removal
    # did EXACTLY what was intended: orphans gone, every bicep-managed key still present, every
    # secretRef key untouched. Turns a silent over-delete into a same-run RED (a deleted GEMINI_PAID_KEY
    # is caught here, not from a backend outage).
    $After = az containerapp show --name $AppName -g $ResourceGroup `
        --query 'properties.template.containers[0].env' -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { Write-Error "post-removal az containerapp show failed (exit $LASTEXITCODE)"; exit 1 }
    $afterNames = @(@($After) | ForEach-Object { $_.name })
    $afterSecretNames = @(@($After) | Where-Object {
        $sp = $_.PSObject.Properties['secretRef']; $null -ne $sp -and $sp.Value -ne '' } | ForEach-Object { $_.name })
    $verifyFails = [System.Collections.Generic.List[string]]::new()
    foreach ($o in $Orphans)           { if ($o -in $afterNames)          { $verifyFails.Add("orphan '$o' still present") } }
    foreach ($k in $BicepEnv.Keys)     { if ($k -notin $afterNames)       { $verifyFails.Add("bicep-managed '$k' MISSING") } }
    foreach ($s in $SecretNamesBefore) { if ($s -notin $afterSecretNames) { $verifyFails.Add("secretRef '$s' MISSING") } }
    if ($verifyFails.Count -gt 0) {
        Write-Error ("::error::POST-REMOVAL VERIFICATION FAILED (t/3345, SO e/144#2 cond 2): " +
            "$($verifyFails -join '; '). Removal did not match intent — investigate immediately.")
        exit 1
    }
    Write-Host ("Post-removal verification PASSED: orphan(s) gone; all $($BicepEnv.Count) bicep-managed " +
        "+ $($SecretNamesBefore.Count) secretRef key(s) intact. (t/3345 Phase-2)")
}
