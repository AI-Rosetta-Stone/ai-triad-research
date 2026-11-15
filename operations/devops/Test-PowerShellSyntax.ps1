# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Parse PowerShell files and report syntax errors as path:line:column (t/289).
.DESCRIPTION
    Called by operations/devops/pre-push-checks.sh for the *.ps1 / *.psm1 / *.psd1 files a push
    changes. Parse-only: nothing is executed, imported or dot-sourced. #4961 shipped an
    `Unexpected token '}'` that broke 73 Pester tests; this catches that class before the push.
    Exit 0 = every file parsed clean; exit 1 = at least one parse error or unreadable file.
.EXAMPLE
    pwsh -NoProfile -File operations/devops/Test-PowerShellSyntax.ps1 a.ps1 b.psm1
#>
param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]] $Path
)

$bad = 0
foreach ($p in $Path) {
    if (-not $p) { continue }
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
        Write-Output "${p}: cannot read file"
        $bad++
        continue
    }
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $p).ProviderPath, [ref]$tokens, [ref]$errors)
    foreach ($e in $errors) {
        Write-Output "${p}:$($e.Extent.StartLineNumber):$($e.Extent.StartColumnNumber): $($e.Message)"
    }
    if ($errors.Count -gt 0) { $bad++ }
}
if ($bad -gt 0) { exit 1 }
exit 0
