# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-Az {
    <#
    .SYNOPSIS
        Runs the Azure CLI with a captured stdout string and non-zero-exit error handling.
    .DESCRIPTION
        Thin wrapper around `& az ...` that:
          - passes args as a positional array (avoids Windows quoting traps)
          - captures stdout as a single string for JSON parsing
          - throws ActionableError on non-zero exit
          - returns $null when stdout is empty (matches PS pipeline conventions)

        Exists so cmdlets can mock the Azure CLI in Pester (t/1498).
    .PARAMETER Arguments
        The az CLI argument array, e.g. @('containerapp', 'revision', 'list', '--name', 'x').
        Do NOT include 'az' itself.
    .PARAMETER CallerName
        Location string used in the thrown error's ActionableError.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [Parameter()]
        [string]$CallerName = 'Invoke-Az'
    )

    Set-StrictMode -Version Latest

    # Capture stdout and stderr separately by filtering type: PS represents
    # stderr from native commands as [ErrorRecord] objects when using 2>&1.
    # Mixing them corrupts JSON output (az update emits warnings to stderr
    # that az revision list/show do not — discovered in t/1500 staging dry-run).
    $RawOutput   = & az @Arguments 2>&1
    $ExitCode    = $LASTEXITCODE
    $StdoutLines = @($RawOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $StderrLines = @($RawOutput | Where-Object { $_ -is  [System.Management.Automation.ErrorRecord] } |
                     ForEach-Object { $_.ToString() })

    foreach ($Line in $StderrLines) { Write-Verbose "[az stderr] $Line" }

    if ($ExitCode -ne 0) {
        throw (New-ActionableError `
            -Goal "Run az $($Arguments -join ' ')" `
            -Problem "Azure CLI exit $ExitCode" `
            -Location $CallerName `
            -NextSteps @('Verify az login: az account show',
                         'Check the arguments passed to Invoke-Az',
                         "Stderr: $($StderrLines -join '; ')",
                         "Output: $(($StdoutLines | Out-String).Trim())") `
            -AsErrorRecord)
    }
    if (-not $StdoutLines) { return $null }
    ($StdoutLines | Out-String).Trim()
}
