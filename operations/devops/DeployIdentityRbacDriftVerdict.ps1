# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4397 deploy-identity RBAC drift check.
.DESCRIPTION
    None of github-ai-triad-deploy's role assignments are declared in main.bicep -- they were all
    made out-of-band via `az role assignment create` (t/4390, plus pre-existing ones of unknown
    origin). If the storage account or the deploy identity is ever recreated, or someone runs an
    RBAC cleanup pass against what IaC actually declares, these grants disappear with no signal --
    the exact class t/4390 just fixed, recurring invisibly. This predicate compares the checked-in
    expected-roles manifest (deploy-identity-rbac-manifest.json) against live `az role assignment
    list` output and flags both directions of drift:
      - missing -- an expected assignment is no longer present (the dangerous direction: a grant
        silently disappeared, breaking whatever depends on it).
      - extra   -- a live assignment isn't in the manifest (a scope-creep signal: something was
        granted out-of-band and never recorded here, or the manifest is stale).

    PURE: no I/O. The expected list (data) and the live assignments (from `az role assignment
    list --assignee <appId> --all -o json`) are both gathered by the caller.
#>

Set-StrictMode -Version Latest

function Get-DeployIdentityRbacDriftVerdict {
    [CmdletBinding()]
    param(
        # Expected entries: { roleDefinitionName, roleScopeSuffix, why }.
        [AllowEmptyCollection()] [object[]] $Expected = @(),
        # Live entries: { roleDefinitionName, scope }. The caller is responsible for resolving
        # roleScopeSuffix against the live RG scope prefix before calling -- this predicate only
        # compares the full live scope strings it's given against Expected's roleScopeSuffix-
        # derived full scopes (also computed by the caller, passed as part of Expected via
        # ResolvedExpected -- see the wrapper function below for the actual entry point).
        [AllowEmptyCollection()] [object[]] $Live = @(),
        [Parameter(Mandatory)] [string] $RgScope
    )

    $expectedFull = $Expected | ForEach-Object {
        [pscustomobject]@{
            RoleDefinitionName = $_.roleDefinitionName
            Scope              = "$RgScope$($_.roleScopeSuffix)"
            Why                = $_.why
        }
    }

    $missing = @(
        foreach ($e in $expectedFull) {
            $found = $Live | Where-Object { $_.roleDefinitionName -eq $e.RoleDefinitionName -and $_.scope -eq $e.Scope }
            if (-not $found) {
                [pscustomobject]@{
                    Kind    = 'missing'
                    Role    = $e.RoleDefinitionName
                    Scope   = $e.Scope
                    Message = "expected '$($e.RoleDefinitionName)' @ $($e.Scope) ($($e.Why)) is no longer assigned"
                }
            }
        }
    )

    $extra = @(
        foreach ($l in $Live) {
            $found = $expectedFull | Where-Object { $_.RoleDefinitionName -eq $l.roleDefinitionName -and $_.Scope -eq $l.scope }
            if (-not $found) {
                [pscustomobject]@{
                    Kind    = 'extra'
                    Role    = $l.roleDefinitionName
                    Scope   = $l.scope
                    Message = "live assignment '$($l.roleDefinitionName)' @ $($l.scope) is not in the manifest -- granted out-of-band and never recorded, or the manifest is stale"
                }
            }
        }
    )

    $violations = @($missing) + @($extra)
    [pscustomobject]@{
        Violations = $violations
        ShouldAct  = (@($violations).Count -gt 0)
    }
}
