# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Arms for the t/4567 C2 ruleset-alert-gating comparator (RulesetAlertGatingVerdict.ps1).
.DESCRIPTION
    Alert-gating for the merge queue now lives ONLY in the ruleset's own `code_scanning` rule
    (not in classic branch protection, which requires the job-level `CodeQL Analysis` check that
    never fails on an alert). These test the pure comparator (no network): active/disabled,
    matching/mismatching code_scanning rule, and the not-applicable skip when undeclared.
#>

Describe 'Get-RulesetAlertGatingVerdict (t/4567 C2)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/RulesetAlertGatingVerdict.ps1"
    }

    It 'BACKWARD COMPAT: omitting every expectation is NOT APPLICABLE, not a failure' {
        $v = Get-RulesetAlertGatingVerdict
        $v.InSync | Should -BeTrue
        $v.ActiveChecked | Should -BeFalse
        $v.CodeScanningRuleChecked | Should -BeFalse
    }

    It 'IN SYNC — active matches and code_scanning rule matches' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $true `
            -ExpectedTool 'CodeQL' -ExpectedSecurityAlertsThreshold 'high_or_higher' -ExpectedAlertsThreshold 'errors' `
            -ActualTool 'CodeQL' -ActualSecurityAlertsThreshold 'high_or_higher' -ActualAlertsThreshold 'errors'
        $v.InSync | Should -BeTrue
        $v.ActiveChecked | Should -BeTrue
        $v.ActiveInSync | Should -BeTrue
        $v.CodeScanningRuleChecked | Should -BeTrue
        $v.CodeScanningRuleInSync | Should -BeTrue
    }

    It 'LOAD-BEARING: ruleset disabled (expected active, live disabled) -> NOT in sync' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $false `
            -ExpectedTool 'CodeQL' -ExpectedSecurityAlertsThreshold 'high_or_higher' -ExpectedAlertsThreshold 'errors' `
            -ActualTool 'CodeQL' -ActualSecurityAlertsThreshold 'high_or_higher' -ActualAlertsThreshold 'errors'
        $v.InSync | Should -BeFalse
        $v.ActiveInSync | Should -BeFalse
        $v.CodeScanningRuleInSync | Should -BeTrue
    }

    It 'LOAD-BEARING: code_scanning rule missing entirely (ActualTool null) while ruleset stays active -> NOT in sync' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $true `
            -ExpectedTool 'CodeQL' -ExpectedSecurityAlertsThreshold 'high_or_higher' -ExpectedAlertsThreshold 'errors'
        $v.InSync | Should -BeFalse
        $v.ActiveInSync | Should -BeTrue
        $v.CodeScanningRuleInSync | Should -BeFalse
        $v.ActualToolPresent | Should -BeFalse
    }

    It 'LOAD-BEARING: code_scanning rule present but threshold weakened (medium_or_higher instead of high_or_higher) -> NOT in sync' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $true `
            -ExpectedTool 'CodeQL' -ExpectedSecurityAlertsThreshold 'high_or_higher' -ExpectedAlertsThreshold 'errors' `
            -ActualTool 'CodeQL' -ActualSecurityAlertsThreshold 'medium_or_higher' -ActualAlertsThreshold 'errors'
        $v.InSync | Should -BeFalse
        $v.CodeScanningRuleChecked | Should -BeTrue
        $v.CodeScanningRuleInSync | Should -BeFalse
        $v.ActualToolPresent | Should -BeTrue
    }

    It 'active mismatch and code_scanning mismatch are INDEPENDENT — both can fire together' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $false `
            -ExpectedTool 'CodeQL' -ExpectedSecurityAlertsThreshold 'high_or_higher' -ExpectedAlertsThreshold 'errors'
        $v.ActiveInSync | Should -BeFalse
        $v.CodeScanningRuleInSync | Should -BeFalse
        $v.InSync | Should -BeFalse
    }

    It 'NOT APPLICABLE: ExpectedTool undeclared skips the code_scanning check even if active is checked' {
        $v = Get-RulesetAlertGatingVerdict -ExpectedActive $true -ActualActive $true
        $v.ActiveChecked | Should -BeTrue
        $v.ActiveInSync | Should -BeTrue
        $v.CodeScanningRuleChecked | Should -BeFalse
        $v.InSync | Should -BeTrue
    }
}
