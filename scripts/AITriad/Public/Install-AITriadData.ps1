# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Install-AITriadData {
    <#
    .SYNOPSIS
        Clones or updates the AI Triad data repository.
    .DESCRIPTION
        Ensures the ai-triad-data repository is available as a sibling to
        the code repository. If missing, clones it from GitHub. If present,
        optionally pulls the latest changes.

        The data repo contains taxonomy files, source documents, summaries,
        conflicts, and debate sessions — everything the PowerShell module
        and Electron apps need to operate.
    .PARAMETER Update
        If the data repo already exists, pull latest changes.
    .PARAMETER DataPath
        Override the clone destination. Defaults to the path in .aitriad.json
        (typically ../ai-triad-data relative to the code repo).
    .PARAMETER RepoUrl
        Override the git clone URL.
    .EXAMPLE
        Install-AITriadData
        # Clones the data repo as a sibling directory
    .EXAMPLE
        Install-AITriadData -Update
        # Pulls latest changes if data repo already exists
    .EXAMPLE
        Install-AITriadData -DataPath ~/research-data
        # Clone to a custom location (also updates .aitriad.json)
    .LINK
        Show-AITriadHelp
    .LINK
        Install-AIDependencies
    .LINK
        Install-GraphDatabase
    .LINK
        Test-Dependencies
    .LINK
        Register-AITriadDrive
    #>
    [CmdletBinding()]
    param(
        [switch]$Update,

        [string]$DataPath = '',

        [string]$RepoUrl = 'https://github.com/AI-Rosetta-Stone/ai-triad-data.git'
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Resolve target path ──
    if ([string]::IsNullOrWhiteSpace($DataPath)) {
        $DataPath = Get-DataRoot
    }

    $DataPath = [System.IO.Path]::GetFullPath($DataPath)

    Write-Step 'AI Triad Data Setup'
    Write-Info "Data path: $DataPath"
    Write-Info "Repo URL:  $RepoUrl"

    # ── Check if data repo already exists ──
    $GitDir = Join-Path $DataPath '.git'
    if (Test-Path $GitDir) {
        Write-OK 'Data repository found'

        if ($Update) {
            Write-Step 'Pulling latest changes'
            try {
                Push-Location $DataPath
                $Output = git pull 2>&1
                Write-OK "git pull: $Output"
            }
            catch {
                Write-Fail "git pull failed: $_"
            }
            finally {
                Pop-Location
            }
        }
        else {
            Write-Info 'Use -Update to pull latest changes'
        }
    }
    elseif (Test-Path $DataPath) {
        # Directory exists but is not a git repo — try to init and pull
        Write-Warn "Directory exists at $DataPath but is not a git repository"
        Write-Step 'Initialising existing directory as data repo'
        try {
            Push-Location $DataPath
            git init 2>&1 | ForEach-Object { Write-Info $_ }
            git remote add origin $RepoUrl 2>&1 | ForEach-Object { Write-Info $_ }
            git fetch origin 2>&1 | ForEach-Object { Write-Info $_ }
            if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit code $LASTEXITCODE)" }
            git checkout -b main origin/main 2>&1 | ForEach-Object { Write-Info $_ }
            if ($LASTEXITCODE -ne 0) {
                # Branch may conflict with existing files — try reset
                git reset --hard origin/main 2>&1 | ForEach-Object { Write-Info $_ }
            }
            Write-OK "Initialised and synced to $DataPath"
        }
        catch {
            Write-Fail "Failed to initialise data repo: $_"
            Write-Info "Remove $DataPath manually and re-run Install-AITriadData"
            throw
        }
        finally {
            Pop-Location
        }
    }
    else {
        # ── Clone the data repo ──
        $ParentDir = Split-Path $DataPath -Parent
        if (-not (Test-Path $ParentDir)) {
            Write-Info "Creating parent directory: $ParentDir"
            New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
        }

        Write-Step "Cloning data repository"
        try {
            git clone $RepoUrl $DataPath 2>&1 | ForEach-Object { Write-Info $_ }
            if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit code $LASTEXITCODE)" }
            Write-OK "Cloned to $DataPath"
        }
        catch {
            Write-Fail "git clone failed: $_"
            throw
        }
    }

    # ── Update .aitriad.json if custom path was specified ──
    $ConfigPath = Join-Path $script:RepoRoot '.aitriad.json'
    if (Test-Path $ConfigPath) {
        $Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json

        # Compute relative path from code repo to data
        $RelativePath = [System.IO.Path]::GetRelativePath($script:RepoRoot, $DataPath)
        # Normalize to forward slashes for cross-platform
        $RelativePath = $RelativePath -replace '\\', '/'

        if ($Config.data_root -ne $RelativePath) {
            $Config.data_root = $RelativePath
            $Config | ConvertTo-Json -Depth 5 | Write-Utf8NoBom -Path $ConfigPath 
            Write-OK "Updated .aitriad.json: data_root = $RelativePath"
            # Reset cached config so next call picks up the change
            $script:DataConfig = $null
        }
    }

    # ── Verify ──
    if ($script:DataConfig) { $_cfgForTax = $script:DataConfig } else { $_cfgForTax = @{ taxonomy_dir = 'taxonomy/Origin' } }
    $TaxDir = Join-Path $DataPath $_cfgForTax.taxonomy_dir
    if (-not (Test-Path $TaxDir)) {
        $TaxDir = Join-Path (Join-Path $DataPath 'taxonomy') 'Origin'
    }

    if (Test-Path $TaxDir) {
        $FileCount = @(Get-ChildItem -Path $TaxDir -Filter '*.json' | Where-Object { $_.Name -notin 'embeddings.json', 'edges.json' }).Count
        Write-OK "Taxonomy directory found: $FileCount POV files"
    }
    else {
        Write-Warn "Taxonomy directory not found at $TaxDir"
        Write-Info 'The data repo may need to be set up or the path may be incorrect.'
    }

    $SourcesDir = Join-Path $DataPath 'sources'
    if (Test-Path $SourcesDir) {
        $SourceCount = @(Get-ChildItem -Path $SourcesDir -Directory | Where-Object { $_.Name -ne '_inbox' }).Count
        Write-OK "Sources: $SourceCount documents"
    }

    Write-Host ''
    Write-OK 'Data setup complete'
    Write-Host ''
}
