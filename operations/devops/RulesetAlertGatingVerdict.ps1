# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure comparator for t/4567 SO C2 (e/387#2): is the merge-queue ruleset's alert-gating
    still intact? No network — unit-testable.
.DESCRIPTION
    The required-status-check swap from `CodeQL` (native alert check) to `CodeQL Analysis`
    (the job) moved alert-gating OUT of classic branch protection and INTO the ruleset's own
    `code_scanning` rule. Classic protection cannot carry it back (re-adding `CodeQL` there
    would re-stall the queue on merge-group refs the same way). That means disabling the
    ruleset — the exact rollback this whole incident already reached for once — silently
    drops alert-gating, with classic protection looking perfectly normal throughout.

    This verdict checks TWO things, both required for alert-gating to be live:
      1. the ruleset's enforcement is "active" (not "disabled"/"evaluate");
      2. the ruleset has a `code_scanning` rule matching the declared tool + thresholds.

    Declared expectations come from the SSOT (.github/ci/required-contexts.json), same
    pattern as `strict`/`enforce_admins` in RequiredContextsDriftVerdict.ps1 — a missing
    declaration is NOT APPLICABLE (skip, don't assume), not a silent pass.
#>

function Get-RulesetAlertGatingVerdict {
    [CmdletBinding()]
    param(
        [Nullable[bool]]$ExpectedActive = $null,
        [Nullable[bool]]$ActualActive = $null,
        [string]$ExpectedTool = $null,
        [string]$ExpectedSecurityAlertsThreshold = $null,
        [string]$ExpectedAlertsThreshold = $null,
        # Actual code_scanning rule parameters read from the live ruleset, or $null if no
        # code_scanning rule exists at all on it.
        [string]$ActualTool = $null,
        [string]$ActualSecurityAlertsThreshold = $null,
        [string]$ActualAlertsThreshold = $null
    )

    $activeChecked = ($null -ne $ExpectedActive) -and ($null -ne $ActualActive)
    if ($activeChecked) { $activeInSync = ($ExpectedActive -eq $ActualActive) } else { $activeInSync = $true }

    $toolDeclared = -not [string]::IsNullOrWhiteSpace($ExpectedTool)
    $codeScanningRuleChecked = $toolDeclared
    if ($toolDeclared) {
        $codeScanningRuleInSync = (
            ($ActualTool -eq $ExpectedTool) -and
            ($ActualSecurityAlertsThreshold -eq $ExpectedSecurityAlertsThreshold) -and
            ($ActualAlertsThreshold -eq $ExpectedAlertsThreshold)
        )
    } else {
        $codeScanningRuleInSync = $true
    }

    [pscustomobject]@{
        InSync                  = $activeInSync -and $codeScanningRuleInSync
        ActiveChecked            = $activeChecked
        ActiveInSync             = $activeInSync
        ExpectedActive           = $ExpectedActive
        ActualActive             = $ActualActive
        CodeScanningRuleChecked  = $codeScanningRuleChecked
        CodeScanningRuleInSync   = $codeScanningRuleInSync
        ActualToolPresent        = (-not [string]::IsNullOrWhiteSpace($ActualTool))
    }
}
