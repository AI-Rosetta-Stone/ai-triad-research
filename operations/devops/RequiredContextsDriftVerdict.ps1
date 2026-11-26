# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure comparator for t/3646: does the committed required-contexts SSOT match the live
    branch-protection required status checks? No network — unit-testable.
.DESCRIPTION
    The SSOT (.github/ci/required-contexts.json) is a MIRROR; branch protection is authoritative.
    workflow-lint enforces its required-context rules against the workflows named in the SSOT, so
    an SSOT that has drifted from branch protection makes the lint enforce the wrong set — blocking
    correct changes or passing incorrect ones. This comparator is the guard that must be green on
    main BEFORE the lint is promoted to blocking (TL t/3646 ruling 1).

    Compares as SETS (order-insensitive, deduped). Returns:
      InSync         — bool, true iff the two sets are identical AND strict matches (when checked)
      MissingFromApi — contexts in the SSOT but NOT required by branch protection (SSOT over-claims)
      MissingFromSsot— contexts required by branch protection but NOT in the SSOT (SSOT under-claims)
    Both difference lists empty <=> context names in sync.

    Split into its own dot-sourceable file (mirrors FlakeVerdict.ps1 / BranchStrandVerdict.ps1) so
    both arms are testable without a live API call.

    t/3804 PR-1: optional -SsotStrict/-ApiStrict (nullable bool) fold `strict` into the verdict —
    the guard was previously BLIND to `strict` even though it was already present in the payload
    it queries (the "free half" of t/3804). Kept OPTIONAL (default $null) rather than Mandatory so
    the 5 pre-existing callers in
    tests/RequiredContextsDrift.Tests.ps1 (which only ever passed -Ssot/-Api) continue to pass
    unchanged — when either side is omitted, strict is NOT APPLICABLE and cannot affect InSync.
    Returns StrictChecked/SsotStrict/ApiStrict/StrictInSync alongside the existing fields.

    t/3804 PR-2: optional -SsotEnforceAdmins/-ApiEnforceAdmins (nullable bool), same opt-in shape
    as -SsotStrict/-ApiStrict — omitted on either side, enforce_admins is NOT APPLICABLE and cannot
    affect InSync. `enforce_admins` is NOT in the `required_status_checks` sub-resource; the caller
    (Test-RequiredContextsListDrift.ps1) fetches it from a SECOND call to the parent `/protection`
    endpoint. This function stays endpoint-agnostic — it only compares the two bools it's handed.
    Returns EnforceAdminsChecked/SsotEnforceAdmins/ApiEnforceAdmins/EnforceAdminsInSync.
#>

function Get-RequiredContextsDriftVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Ssot,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Api,
        [Nullable[bool]]$SsotStrict = $null,
        [Nullable[bool]]$ApiStrict = $null,
        [Nullable[bool]]$SsotEnforceAdmins = $null,
        [Nullable[bool]]$ApiEnforceAdmins = $null
    )
    $ssotSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@($Ssot | Where-Object { $_ } | ForEach-Object { $_.Trim() }))
    $apiSet  = [System.Collections.Generic.HashSet[string]]::new([string[]]@($Api  | Where-Object { $_ } | ForEach-Object { $_.Trim() }))
    $missingFromApi  = @($ssotSet  | Where-Object { -not $apiSet.Contains($_) }  | Sort-Object)
    $missingFromSsot = @($apiSet   | Where-Object { -not $ssotSet.Contains($_) } | Sort-Object)

    $strictChecked = ($null -ne $SsotStrict) -and ($null -ne $ApiStrict)
    # Explicit if/else assignment, NOT an inline ternary-via-sub-expression (t/3801 PowerShell
    # gotcha: `$a -and (if (cond) {...} else {...})` is unreliable — `if` is only safe as the
    # ENTIRE right-hand side of an assignment, not embedded inside a larger expression).
    if ($strictChecked) { $strictInSync = ($SsotStrict -eq $ApiStrict) } else { $strictInSync = $true }

    $enforceAdminsChecked = ($null -ne $SsotEnforceAdmins) -and ($null -ne $ApiEnforceAdmins)
    if ($enforceAdminsChecked) { $enforceAdminsInSync = ($SsotEnforceAdmins -eq $ApiEnforceAdmins) } else { $enforceAdminsInSync = $true }

    return [PSCustomObject]@{
        InSync               = ($missingFromApi.Count -eq 0 -and $missingFromSsot.Count -eq 0 -and $strictInSync -and $enforceAdminsInSync)
        MissingFromApi       = $missingFromApi
        MissingFromSsot      = $missingFromSsot
        StrictChecked        = $strictChecked
        SsotStrict           = $SsotStrict
        ApiStrict            = $ApiStrict
        StrictInSync         = $strictInSync
        EnforceAdminsChecked = $enforceAdminsChecked
        SsotEnforceAdmins    = $SsotEnforceAdmins
        ApiEnforceAdmins     = $ApiEnforceAdmins
        EnforceAdminsInSync  = $enforceAdminsInSync
    }
}

<#
.SYNOPSIS
    t/728 (SO p/136#101): compare the APP PIN of each required context, not just its name.
.DESCRIPTION
    Each required check is pinned to the App that may post it (ci-gate etc. to GitHub Actions 15368,
    merge-approval to 5912670), in classic protection (`checks[].app_id`) and in the merge-queue ruleset
    (`required_status_checks[].integration_id`). A name-only comparison reads IN SYNC even after a pin is loosened
    to "any source", when any workflow job could post a check with that name and satisfy the requirement.
    A pin is valid only as an integer greater than zero: null, missing and -1 (GitHub's "any source") are UNPINNED,
    and an unpinned live context is drift EVEN WHEN the mirror also says null.
    Inputs are objects with `context` and the pin property: Ssot/Classic use `app_id`, Ruleset uses `integration_id`.
    `-RulesetChecked` says the ruleset was read; when it is false the ruleset arm is skipped.
    Returns InSync and Problems (strings).
#>
function Get-RequiredContextsAppPinVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Ssot,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Classic,
        [AllowEmptyCollection()][object[]]$Ruleset = @(),
        [bool]$RulesetChecked = $false
    )
    function ConvertTo-Pin($v) {
        if ($null -eq $v) { return $null }
        $n = 0L
        if ([long]::TryParse("$v", [ref]$n) -and $n -gt 0) { return $n }
        return $null
    }
    $problems = [System.Collections.Generic.List[string]]::new()
    $ssotPins = @{}
    foreach ($e in @($Ssot)) {
        if (-not $e -or -not $e.context) { continue }
        $pin = ConvertTo-Pin $(if ($e.PSObject.Properties['app_id']) { $e.app_id } else { $null })
        $ssotPins[$e.context.Trim()] = $pin
        if ($null -eq $pin) { $problems.Add("SSOT has no valid app_id for '$($e.context)' (a pin must be an integer greater than 0)") }
    }
    $classicPins = @{}
    foreach ($e in @($Classic)) {
        if (-not $e -or -not $e.context) { continue }
        $classicPins[$e.context.Trim()] = ConvertTo-Pin $(if ($e.PSObject.Properties['app_id']) { $e.app_id } else { $null })
    }
    foreach ($c in ($classicPins.Keys | Sort-Object)) {
        if ($null -eq $classicPins[$c]) { $problems.Add("classic protection leaves '$c' unpinned (app_id null or -1: any source may post it)"); continue }
        if ($ssotPins.ContainsKey($c) -and $null -ne $ssotPins[$c] -and $ssotPins[$c] -ne $classicPins[$c]) {
            $problems.Add("classic protection pins '$c' to $($classicPins[$c]), the SSOT expects $($ssotPins[$c])")
        }
    }
    if ($RulesetChecked) {
        $rulesetPins = @{}
        foreach ($e in @($Ruleset)) {
            if (-not $e -or -not $e.context) { continue }
            $rulesetPins[$e.context.Trim()] = ConvertTo-Pin $(if ($e.PSObject.Properties['integration_id']) { $e.integration_id } else { $null })
        }
        foreach ($c in ($ssotPins.Keys | Sort-Object)) {
            if (-not $rulesetPins.ContainsKey($c)) { $problems.Add("the ruleset does not require '$c'"); continue }
            if ($null -eq $rulesetPins[$c]) { $problems.Add("the ruleset leaves '$c' unpinned (integration_id null or -1: any source may post it)"); continue }
            if ($null -ne $ssotPins[$c] -and $ssotPins[$c] -ne $rulesetPins[$c]) {
                $problems.Add("the ruleset pins '$c' to $($rulesetPins[$c]), the SSOT expects $($ssotPins[$c])")
            }
            if ($classicPins.ContainsKey($c) -and $null -ne $classicPins[$c] -and $classicPins[$c] -ne $rulesetPins[$c]) {
                $problems.Add("classic protection pins '$c' to $($classicPins[$c]) but the ruleset to $($rulesetPins[$c]): the two disagree")
            }
        }
    }
    return [PSCustomObject]@{ InSync = ($problems.Count -eq 0); Problems = @($problems) }
}
