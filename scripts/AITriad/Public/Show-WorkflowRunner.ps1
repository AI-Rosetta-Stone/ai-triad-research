# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-WorkflowRunner {
    <#
    .SYNOPSIS
        Launch the AI Triad Workflow Runner.
    .DESCRIPTION
        Opens a visual pipeline app that walks through the full document
        ingestion workflow: import, summarise, detect conflicts, check
        taxonomy health, generate and review proposals, validate integrity,
        update embeddings, discover edges, extract attributes, and commit
        to git.

        Requires Node.js / npm.  On first run the command installs
        node_modules automatically if they are missing.
    .PARAMETER NoBrowser
        Start the Vite dev server without launching the Electron window
        (useful if you only want to view it in a browser at localhost:5176).
    .EXAMPLE
        Show-WorkflowRunner
        # Opens the Workflow Runner desktop app
    .EXAMPLE
        workflow
        # Same, using the alias
    .LINK
        Show-AITriadHelp
    .LINK
        Show-POViewer
    .LINK
        Show-SummaryViewer
    .LINK
        Show-TaxonomyEditor
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding()]
    param(
        [switch]$NoBrowser
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $CodeRoot = Get-CodeRoot
    if (-not $CodeRoot) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Launch Workflow Runner' `
            -Problem 'Cannot find the ai-triad-research code repository' `
            -Location 'Show-WorkflowRunner' `
            -NextSteps @(
                'Set $env:AI_TRIAD_CODE_ROOT to the path where you cloned ai-triad-research'
                'Or cd into the ai-triad-research directory before running this command'
            ))
    }

    $AppDir = Join-Path $CodeRoot 'workflow-app'
    if (-not (Test-Path $AppDir)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Launch Workflow Runner' `
            -Problem "App directory not found: $AppDir" `
            -Location 'Show-WorkflowRunner' `
            -NextSteps @(
                'Ensure the workflow-app/ directory exists in the code repository'
            ))
    }

    # ── Check npm ────────────────────────────────────────────────────────────
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Launch Workflow Runner' `
            -Problem 'npm is not installed — Node.js is required' `
            -Location 'Show-WorkflowRunner' `
            -NextSteps @(
                'Install Node.js from https://nodejs.org/'
                'Or run: Install-AIDependencies -SkipPython'
            ))
    }

    # ── Check / install node_modules ─────────────────────────────────────────
    $NodeModules = Join-Path $AppDir 'node_modules'
    if (-not (Test-Path $NodeModules)) {
        Write-Host '[workflow] Installing node modules...' -ForegroundColor Cyan
        Push-Location $AppDir
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Install Workflow Runner dependencies' `
                    -Problem "pnpm install failed (exit code $LASTEXITCODE)" `
                    -Location 'Show-WorkflowRunner' `
                    -NextSteps @(
                        "cd $AppDir"
                        'pnpm install'
                    ))
            }
            Write-Host '[workflow] Node modules installed.' -ForegroundColor Green
        }
        finally { Pop-Location }
    }

    # ── Check data repo ──────────────────────────────────────────────────────
    $TaxDir = Get-TaxonomyDir
    if (-not (Test-Path (Join-Path $TaxDir 'accelerationist.json') -ErrorAction SilentlyContinue)) {
        Write-Warning "AI Triad data not found at: $TaxDir"
        Write-Host 'Run Install-AITriadData to clone the data repository.' -ForegroundColor Yellow
    }

    # ── Launch ───────────────────────────────────────────────────────────────
    Write-Host '[workflow] Starting Workflow Runner...' -ForegroundColor Cyan
    Push-Location $AppDir
    try {
        if ($NoBrowser) {
            npm run dev:vite
        }
        else {
            npm run dev
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Workflow Runner exited with code $LASTEXITCODE."
        }
    }
    finally { Pop-Location }
}
