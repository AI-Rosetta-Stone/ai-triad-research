<#
.SYNOPSIS
    Pure predicate for t/4797 (prevention follow-up for t/4794): every AZURE_*_CONTAINER env var
    on a staging Container App revision must resolve to a staging- prefixed value.

.DESCRIPTION
    t/4794: staging served prod's blob containers for ~15h because Sync-StagingEnv.ps1 silently
    failed to apply the staging overrides, and the isolation gate added in #4431 checked only
    `freePoolBudget.container` (one var, AZURE_USER_CONTENT_CONTAINER). A regression in any of
    the other AZURE_*_CONTAINER vars -- including one added later, like AZURE_ANALYTICS_CONTAINER
    (t/4794#9) -- would still have passed that gate.

    This predicate enumerates by NAME PATTERN (`^AZURE_.*_CONTAINER$`), not a fixed list, so a
    future container var is covered automatically without a code change here. It takes the
    revision's OWN env array (as read live from the Container App revision via `az containerapp
    revision show`, the authoritative source -- not /health, which only ever reflected one var
    and depends on the app code choosing to surface it, and not Get-BicepBaseEnv's computed
    expectation, which was itself the thing that silently resolved wrong in t/4794).

    The workflow step (CLI wrapper, not duplicated here) does the `az` call -- and must fail
    closed on a non-zero exit, empty output, or invalid JSON BEFORE calling into this file, so a
    read failure can never reach this predicate disguised as a clean empty array.

    TL review condition (t/4797, p/404#165): no vacuous pass. Zero pattern matches is itself a
    violation (not an empty, clean result), and each of the known container vars must be present
    by name -- a var silently dropped from the revision entirely (not merely mis-valued) must
    also fail, not slip through because the pattern loop had nothing to iterate wrong.
#>

# t/4794 TL follow-up 2 convention: a local minimal helper, not a hard dependency on
# AITriad.psm1 -- this script can run from CI steps that haven't imported that module.
function New-ActionableError {
    param([string]$Goal, [string]$Problem, [string]$Location, [string]$NextSteps)
    "Goal: $Goal`nProblem: $Problem`nLocation: $Location`nResolve: $NextSteps"
}

# SYNC WITH main.bicep / Invoke-BlobContainerGateCheck.ps1's container list: the var names the
# server code actually reads (server.ts, blobBackendBoot.ts, userContentContainer.ts,
# communityContainer.ts, briefExportsContainer.ts). A var dropped from the revision entirely
# (not merely mis-valued) must still be caught -- the pattern loop below has nothing to iterate
# wrong if the var simply isn't there.
$script:KnownContainerVarNames = @(
    'AZURE_USER_CONTENT_CONTAINER',
    'AZURE_COMMUNITY_CONTAINER',
    'AZURE_BRIEF_EXPORTS_CONTAINER',
    'AZURE_ANALYTICS_CONTAINER'
)

<#
.SYNOPSIS
    Returns the list of isolation violations found on $EnvVars. Empty array means isolation
    holds. Three violation Reasons:
      - 'missing'                         : a known container var isn't present at all.
      - 'no-azure-container-vars-matched'  : the pattern matched zero entries (vacuous pass guard).
      - 'not-staging-prefixed'             : a matched var's value doesn't start with 'staging-'.
.PARAMETER EnvVars
    Array of objects with a `name` property and, optionally, a `value` property (the shape
    `az containerapp revision show --query properties.template.containers[0].env -o json`
    returns). An entry with no `value` property (secretRef-backed) is treated as a violation --
    none of the AZURE_*_CONTAINER vars are secrets, so a secretRef shape here is itself a drift
    this predicate should not silently wave through.
.PARAMETER RequiredNames
    The known container var names that must be present by name. Defaults to
    $script:KnownContainerVarNames. Exposed as a parameter so tests can inject a synthetic name
    without editing this file, proving the pattern-based check (below) is what covers an
    unknown future var, not this required-presence list.
#>
function Test-StagingContainerEnvIsolation {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]] $EnvVars,
        [string[]] $RequiredNames = $script:KnownContainerVarNames
    )

    $violations = @()

    $byName = @{}
    foreach ($e in $EnvVars) {
        if ($e.PSObject.Properties['name'] -and $e.name) { $byName[$e.name] = $e }
    }

    foreach ($required in $RequiredNames) {
        if (-not $byName.ContainsKey($required)) {
            $violations += [PSCustomObject]@{ Name = $required; Value = $null; Reason = 'missing' }
        }
    }

    $matched = @($EnvVars | Where-Object { $_.PSObject.Properties['name'] -and $_.name -match '^AZURE_.*_CONTAINER$' })

    if ($matched.Count -eq 0) {
        $violations += [PSCustomObject]@{ Name = '<none>'; Value = $null; Reason = 'no-azure-container-vars-matched' }
    }

    foreach ($e in $matched) {
        $valueProp = $e.PSObject.Properties['value']
        $value = if ($null -ne $valueProp) { $valueProp.Value } else { $null }
        if ([string]::IsNullOrEmpty($value) -or -not $value.StartsWith('staging-')) {
            $violations += [PSCustomObject]@{ Name = $e.name; Value = $value; Reason = 'not-staging-prefixed' }
        }
    }

    return $violations
}

<#
.SYNOPSIS
    Asserts isolation and throws an ActionableError naming every violation (not just the
    first) if any exist.
#>
function Assert-StagingContainerEnvIsolation {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]] $EnvVars,
        [string[]] $RequiredNames = $script:KnownContainerVarNames
    )

    $violations = Test-StagingContainerEnvIsolation -EnvVars $EnvVars -RequiredNames $RequiredNames
    if ($violations.Count -gt 0) {
        $detail = ($violations | ForEach-Object { "$($_.Name)='$($_.Value)' ($($_.Reason))" }) -join ', '
        throw (New-ActionableError -Goal 'Verify staging container isolation before traffic promotion' `
            -Problem "$($violations.Count) AZURE_*_CONTAINER isolation violation(s) on the new staging revision: $detail -- this revision could read/write PROD's blob containers, or the gate itself has gone blind." `
            -Location 'Test-StagingContainerEnvIsolation.ps1 / deploy-staging.yml isolation_gate (t/4797)' `
            -NextSteps 'Do not promote traffic. For not-staging-prefixed: check main.bicep stagingEnvOverrides and Sync-StagingEnv.ps1''s reconcile (t/4794 failure shape). For missing: the var was dropped from the revision template entirely. For no-azure-container-vars-matched: the revision env query itself may be broken -- verify the az call and query path before assuming containers are actually unset.')
    }
}
