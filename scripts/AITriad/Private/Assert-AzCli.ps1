# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Preflight: assert the Azure CLI is installed and logged in, else throw an actionable error.
.DESCRIPTION
    Two checks the az-using cmdlets need before their first real call:
      1. `az` resolves on PATH (a bare `& az` otherwise throws a raw CommandNotFoundException,
         not an actionable error).
      2. `az account show` succeeds (confirms an authenticated context).
    Routes the account probe through Invoke-Az so callers can mock a single seam in Pester.
    This is the shared form of the login-preflight block that is otherwise copy-pasted across the
    Azure cmdlets; new az cmdlets should call it instead of re-inlining.
.PARAMETER CallerName
    Location string stamped into the thrown ActionableError (usually the calling cmdlet's name).
#>
function Assert-AzCli {
    [CmdletBinding()]
    param(
        [string]$CallerName = 'Assert-AzCli'
    )

    Set-StrictMode -Version Latest

    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw (New-ActionableError `
            -Goal     'Run an Azure CLI command' `
            -Problem  'The Azure CLI (az) was not found on PATH.' `
            -Location $CallerName `
            -NextSteps @(
                'Install the Azure CLI: https://aka.ms/azcli'
                'Then authenticate: az login'
            ) `
            -AsErrorRecord)
    }

    # Invoke-Az throws an actionable error on non-zero exit (the not-logged-in case);
    # a null return means az produced no account context.
    $Account = Invoke-Az -Arguments @('account', 'show', '--output', 'json') -CallerName $CallerName
    if (-not $Account) {
        throw (New-ActionableError `
            -Goal     'Run an Azure CLI command' `
            -Problem  'Not logged into Azure (az account show returned no context).' `
            -Location $CallerName `
            -NextSteps @(
                'Run: az login'
                'Verify the active subscription: az account show'
            ) `
            -AsErrorRecord)
    }
}
