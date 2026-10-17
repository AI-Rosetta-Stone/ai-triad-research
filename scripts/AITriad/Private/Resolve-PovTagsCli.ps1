# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Resolve-PovTagsCli {
    <#
    .SYNOPSIS
        Resolve the invocation for the blocking pov_tags validation gate, lib/schema/pov-tags-cli.ts
        (t/3955, TL t/3955#4 cond 1; this is "the CLI" t/3969 shells out to).
    .DESCRIPTION
        Returns @{ Exe = <string>; ArgPrefix = <string[]> } so the caller invokes:
            & $inv.Exe @($inv.ArgPrefix)
        and feeds the request JSON on stdin (the CLI's documented `… | tsx pov-tags-cli.ts` form —
        no --input file needed for a batch built in memory). Isolates the tsx-entrypoint decision
        (owned by Shared Lib / lib/schema) from Set-PovNodeTags, which only knows the stdin/stdout
        contract: input `[{id, pov_tags}, …]`, last stdout line `{checked, invalid, errors}`, exit
        0 = valid, 1 = invalid (errors[] lists them), anything else = could not run — never write.
        Modeled on Resolve-BriefExportCli.ps1 (t/2837). Tests mock this.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    Set-StrictMode -Version Latest

    # Repo root = two levels up from the module (scripts/AITriad → repo root).
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $script:ModuleRoot '..' '..'))
    $cliPath = Join-Path $repoRoot 'lib' 'schema' 'pov-tags-cli.ts'

    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw (New-ActionableError `
                -Goal     'Validate pov_tags against the registry before writing (t/3955 blocking gate)' `
                -Problem  "The pov-tags validation CLI was not found at '$cliPath'." `
                -Location 'Resolve-PovTagsCli' `
                -NextSteps @(
                    'Run from a full repo checkout (where lib/schema lives)',
                    'Install dependencies (npm ci) — the CLI needs tsx AND its runtime packages'
                ) `
                -AsErrorRecord)
    }

    return @{ Exe = 'npx'; ArgPrefix = @('--yes', 'tsx', $cliPath) }
}
