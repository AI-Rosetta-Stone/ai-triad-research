# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Writes Invoke-Ac2Rollback.ps1's result object to a GITHUB_OUTPUT-shaped file (t/4309 C5,
    SO review e/361#5).
.DESCRIPTION
    Extracted from deploy-azure.yml's "Rollback for AC2 failure" step so it's independently
    testable, not just read by eye in YAML. Two real bugs the SO caught in the inline version:
      1. `$result.RecheckFailed.ToString()` throws under Set-StrictMode whenever RecheckFailed
         is $null (the unrecoverable-target and catch paths both return $null there) --
         every unrecoverable rollback would have LOOKED like a script crash. Fixed with an
         explicit tri-state mapping (true/false/n-a) instead of relying on .ToString().
      2. `recheck_reason` was written as a bare "key=value" line -- an `az` exception message
         (RecheckReason on the catch path) can contain a newline, which GITHUB_OUTPUT would read
         as the START of a NEW key, silently injecting or overriding whatever key came next.
         Fixed with the documented multiline delimiter form (`key<<EOF` ... `EOF`).
.PARAMETER Result
    The [PSCustomObject] returned by Invoke-Ac2Rollback.ps1: { TargetUnrecoverable; RolledBack;
    RecheckFailed; RecheckReason }.
.PARAMETER OutputPath
    File to append the GITHUB_OUTPUT-shaped lines to (in real use, $env:GITHUB_OUTPUT; in a
    test, any temp file).
#>
function Write-Ac2RollbackOutput {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [PSCustomObject] $Result,
        [Parameter(Mandatory)] [string] $OutputPath
    )

    Set-StrictMode -Version Latest

    $recheckFailedStr = if ($Result.RecheckFailed -eq $true) { 'true' } elseif ($Result.RecheckFailed -eq $false) { 'false' } else { 'n/a' }
    Add-Content -Path $OutputPath -Value "target_unrecoverable=$($Result.TargetUnrecoverable.ToString().ToLower())"
    Add-Content -Path $OutputPath -Value "recheck_failed=$recheckFailedStr"

    $delim = "ac2rb_$([guid]::NewGuid().ToString('N'))"
    Add-Content -Path $OutputPath -Value "recheck_reason<<$delim"
    Add-Content -Path $OutputPath -Value "$($Result.RecheckReason)"
    Add-Content -Path $OutputPath -Value $delim
}
