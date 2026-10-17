# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-SummaryViewer {
    <#
    .SYNOPSIS
        Launch the Summary Viewer Electron app.
    .DESCRIPTION
        Runs 'npm run dev' inside the summary-viewer directory.
    .EXAMPLE
        Show-SummaryViewer
        SummaryViewer
    .LINK
        Show-AITriadHelp
    .LINK
        Show-POViewer
    .LINK
        Show-TaxonomyEditor
    .LINK
        Show-WorkflowRunner
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding()]
    param()

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $CodeRoot = Get-CodeRoot
    if (-not $CodeRoot) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Launch Summary Viewer' `
            -Problem 'Cannot find the ai-triad-research code repository' `
            -Location 'Show-SummaryViewer' `
            -NextSteps @(
                'Set $env:AI_TRIAD_CODE_ROOT to the path where you cloned ai-triad-research'
                'Or cd into the ai-triad-research directory before running this command'
                'Or clone the repo: git clone https://github.com/jsnov/ai-triad-research'
            ))
    }
    $AppDir = Join-Path $CodeRoot 'summary-viewer'
    if (-not (Test-Path $AppDir)) {
        Write-Fail "App directory not found: $AppDir"
        return
    }
    Push-Location $AppDir
    try {
        $NodeModules = Join-Path $AppDir 'node_modules'
        if (-not (Test-Path $NodeModules)) {
            Write-Warn "node_modules/ not found — running pnpm install first"
            pnpm install
            if ($LASTEXITCODE -ne 0) {
                Write-Fail "pnpm install failed (exit code $LASTEXITCODE) in $AppDir"
                return
            }
        }
        npm run dev
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "npm run dev failed (exit code $LASTEXITCODE). Try: cd $AppDir && pnpm install && npm run dev"
        }
    }
    finally { Pop-Location }
}
