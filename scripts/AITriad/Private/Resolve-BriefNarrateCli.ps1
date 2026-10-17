# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Resolve-BriefNarrateCli {
    <#
    .SYNOPSIS
        Resolve the invocation for the shared lib/brief narrate-stage CLI (t/2873).
    .DESCRIPTION
        Returns @{ Exe = <string>; ArgPrefix = <string[]> } so the caller invokes:
            & $inv.Exe @($inv.ArgPrefix + $flagArgs)
        Isolates the tsx entrypoint decision (owned by lib/brief) from
        Test-BriefNarrationStage, which only knows the flag interface
        (--spec/--model + optional --preset/--checker-model/--skip-narration).

        Sibling of Resolve-BriefExportCli: lib/brief's tsconfig is noEmit (no committed
        .js, no npm bin), and Shared Lib froze the canonical entrypoint as
        `tsx lib/brief/<cli>.ts` from repo root (t/2837#7). We run the source via
        `npx tsx lib/brief/narrate-cli.ts` (npx keeps it portable; tsx is a root
        devDependency). If the entrypoint ever changes, only this function changes.
        Tests mock this.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    Set-StrictMode -Version Latest

    # Repo root = two levels up from the module (scripts/AITriad → repo root).
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $script:ModuleRoot '..' '..'))
    $cliPath = Join-Path $repoRoot 'lib' 'brief' 'narrate-cli.ts'

    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw (New-ActionableError `
                -Goal     'Run the offline brief narrate stage' `
                -Problem  "The brief narrate-stage CLI was not found at '$cliPath'. It is provided by lib/brief (t/2873) and needs the lib/brief sources in the repo checkout." `
                -Location 'Resolve-BriefNarrateCli' `
                -NextSteps @(
                    'Run from a full repo checkout (where lib/brief lives)',
                    'Install dependencies (npm ci) — the stage needs tsx AND its runtime packages',
                    'If lib/brief/narrate-cli.ts has not landed yet, track t/2873'
                ) `
                -AsErrorRecord)
    }

    return @{ Exe = 'npx'; ArgPrefix = @('--yes', 'tsx', $cliPath) }
}
