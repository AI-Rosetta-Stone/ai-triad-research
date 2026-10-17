# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Resolve-BriefExportCli {
    <#
    .SYNOPSIS
        Resolve the invocation for the shared lib/brief full-pipeline export CLI (t/2837).
    .DESCRIPTION
        Returns @{ Exe = <string>; ArgPrefix = <string[]> } so the caller invokes:
            & $inv.Exe @($inv.ArgPrefix + $flagArgs)
        This isolates the tsx-vs-compiled-bin entrypoint decision (owned by lib/brief)
        from Export-TriadDebateBrief, which only knows the flag interface
        (--path/--model/--preset/--out + optional --skip-narration/--checker-model/--allow-open).

        The CLI (lib/brief/cli.ts) is a TypeScript module; lib/brief's tsconfig is noEmit,
        so there is no committed cli.js and no npm bin/script. Shared Lib froze the
        canonical entrypoint as `tsx lib/brief/cli.ts` from repo root, no compiled bin
        (t/2837#7 / Shared Lib p/44#47) — so we run the source via `npx tsx lib/brief/cli.ts`
        (npx keeps it portable; `tsx` is a root devDependency). If the entrypoint ever
        changes (a build output or npm script), only this function changes. Tests mock this.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    Set-StrictMode -Version Latest

    # Repo root = two levels up from the module (scripts/AITriad → repo root).
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $script:ModuleRoot '..' '..'))
    $cliPath = Join-Path $repoRoot 'lib' 'brief' 'cli.ts'

    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw (New-ActionableError `
                -Goal     'Run the offline brief-export pipeline (local mode)' `
                -Problem  "The brief full-pipeline CLI was not found at '$cliPath'. Local-mode export needs the lib/brief sources in the repo checkout." `
                -Location 'Resolve-BriefExportCli' `
                -NextSteps @(
                    'Run from a full repo checkout (where lib/brief lives)',
                    'Install dependencies (npm ci) — the pipeline needs tsx AND its runtime packages'
                ) `
                -AsErrorRecord)
    }

    return @{ Exe = 'npx'; ArgPrefix = @('--yes', 'tsx', $cliPath) }
}
