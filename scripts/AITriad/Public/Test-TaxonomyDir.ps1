# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-TaxonomyDir {
    <#
    .SYNOPSIS
        Pre-validate the taxonomy directory against the embed_taxonomy.py loader
        contract before running Update-TaxEmbeddings.
    .DESCRIPTION
        Predicts exactly which files embed_taxonomy.py's _load_taxonomy_nodes()
        would ingest, and flags any ingested file that would crash the embedding
        run. This answers the question "which taxonomy file is malformed?" in
        seconds instead of a bespoke diagnostic script (motivating incident: t/2875,
        where a stray entity_extraction_log.json with nodes keyed 'node_id' instead
        of 'id' crashed all three embed subcommands with KeyError: 'id').

        For each *.json file in the taxonomy directory it reports one of:
          - Skip    — in SKIP_FILES or an 'embeddings-*' index artifact (never ingested)
          - Ingest  — would be loaded as POV nodes; OK when every 'nodes' entry is a
                      dict containing an 'id'
          - Error   — would be ingested but is malformed (invalid JSON, 'nodes' is not
                      an array, or 'nodes' entries lack 'id') — this is the shape that
                      crashes the loader downstream

        The SKIP_FILES set is parsed from embed_taxonomy.py at runtime so this check
        stays in sync with the loader (the single source of truth) rather than
        drifting from a hardcoded copy. If the source cannot be parsed it falls back
        to a documented default and warns.
    .PARAMETER Path
        Taxonomy directory to scan. Defaults to Get-TaxonomyDir (the configured
        taxonomy/Origin directory).
    .PARAMETER PassThru
        Return a summary object (Ok, FileCount, IngestCount, SkipCount, Problems,
        Details) instead of only writing the human-readable report.
    .EXAMPLE
        Test-TaxonomyDir
        Scan the configured taxonomy directory and print a per-file report.
    .EXAMPLE
        if (-not (Test-TaxonomyDir -PassThru).Ok) { throw 'Fix taxonomy before embedding' }
        Gate a pipeline on a clean taxonomy directory.
    .LINK
        Show-AITriadHelp
    .LINK
        Update-TaxEmbeddings
    .LINK
        Test-TaxonomyIntegrity
    .LINK
        Get-TaxonomyHealth
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$Path,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $Path) { $Path = Get-TaxonomyDir }
    if (-not (Test-Path -LiteralPath $Path)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Pre-validate the taxonomy directory before embedding' `
            -Problem "Taxonomy directory not found: $Path" `
            -Location 'Test-TaxonomyDir' `
            -NextSteps @(
                'Verify the data root is configured (.aitriad.json or $env:AI_TRIAD_DATA_ROOT).',
                'Pass an explicit -Path to the taxonomy directory.'
            ))
    }

    # ── Resolve the loader's SKIP_FILES from embed_taxonomy.py (single source of truth) ──
    # Parsing keeps this check in sync with the loader instead of drifting from a
    # hardcoded copy — the exact drift that let entity_extraction_log.json through (t/2875).
    $DefaultSkip = @(
        'embeddings.json', 'edges.json', 'policy_actions.json', 'lineage_categories.json',
        '_archived_edges.json', 'interpretation_embeddings.json'
    )
    $EmbedScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'embed_taxonomy.py'
    if (-not (Test-Path -LiteralPath $EmbedScript)) { $EmbedScript = Join-Path $script:ModuleRoot 'embed_taxonomy.py' }

    $SkipFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $ParsedSkip = $false
    if (Test-Path -LiteralPath $EmbedScript) {
        $Match = Select-String -LiteralPath $EmbedScript -Pattern '^\s*SKIP_FILES\s*=\s*\{(.+)\}' | Select-Object -First 1
        if ($Match) {
            foreach ($Q in [regex]::Matches($Match.Matches[0].Groups[1].Value, '"([^"]+)"')) {
                [void]$SkipFiles.Add($Q.Groups[1].Value)
            }
            if ($SkipFiles.Count -gt 0) { $ParsedSkip = $true }
        }
    }
    if (-not $ParsedSkip) {
        Write-Warning "Test-TaxonomyDir: could not parse SKIP_FILES from '$EmbedScript' — using the built-in default. If the loader's skip list has changed, results may be stale."
        foreach ($S in $DefaultSkip) { [void]$SkipFiles.Add($S) }
    }

    # ── Scan every *.json file, classifying against the loader contract ──
    $Details  = [System.Collections.Generic.List[PSCustomObject]]::new()
    $Problems = 0
    $IngestCount = 0
    $SkipCount = 0

    foreach ($File in (Get-ChildItem -LiteralPath $Path -Filter '*.json' -File | Sort-Object Name)) {
        $Name = $File.Name
        $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Name)

        # Loader skip rules (embed_taxonomy.py:_load_taxonomy_nodes) ────────────
        if ($SkipFiles.Contains($Name)) {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Skip'; Severity = 'Info'; NodeCount = $null; Reason = 'in SKIP_FILES' })
            $SkipCount++
            continue
        }
        if ($Stem.StartsWith('embeddings-', [System.StringComparison]::OrdinalIgnoreCase)) {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Skip'; Severity = 'Info'; NodeCount = $null; Reason = "embedding-index artifact ('embeddings-*')" })
            $SkipCount++
            continue
        }

        # File would be ingested — validate the node shape the loader requires ──
        try {
            $Raw = Get-Content -Raw -LiteralPath $File.FullName -Encoding UTF8
            $Data = $Raw | ConvertFrom-Json
        }
        catch {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Ingest'; Severity = 'Error'; NodeCount = $null; Reason = "invalid JSON: $($_.Exception.Message)" })
            $Problems++
            $IngestCount++
            continue
        }

        # No 'nodes' array → loader's data.get('nodes', []) yields nothing; harmless
        # but unexpected for a file the loader treats as POV data.
        if (-not ($Data.PSObject.Properties['nodes'])) {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Ingest'; Severity = 'Warning'; NodeCount = 0; Reason = "no 'nodes' array (ingested but contributes 0 nodes)" })
            $IngestCount++
            continue
        }

        $Nodes = $Data.nodes
        # 'nodes' present but not an array of node objects (e.g. a dict keyed by ID,
        # as in embedding-index files). Iterating this crashes the loader.
        if ($Nodes -is [System.Management.Automation.PSCustomObject]) {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Ingest'; Severity = 'Error'; NodeCount = $null; Reason = "'nodes' is an object, not an array of node dicts" })
            $Problems++
            $IngestCount++
            continue
        }

        $NodeList = @($Nodes)
        $BadCount = 0
        $AltKeys = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($Node in $NodeList) {
            if ($Node -isnot [System.Management.Automation.PSCustomObject] -or -not $Node.PSObject.Properties['id']) {
                $BadCount++
                if ($Node -is [System.Management.Automation.PSCustomObject]) {
                    foreach ($Prop in $Node.PSObject.Properties) {
                        if ($Prop.Name -match 'id') { [void]$AltKeys.Add($Prop.Name) }
                    }
                }
            }
        }

        if ($BadCount -gt 0) {
            $Hint = if ($AltKeys.Count -gt 0) { " (entries carry '$([string]::Join("', '", $AltKeys))' instead of 'id')" } else { '' }
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Ingest'; Severity = 'Error'; NodeCount = $NodeList.Count; Reason = "$BadCount of $($NodeList.Count) 'nodes' entries lack an 'id' field$Hint — this crashes the embedding run" })
            $Problems++
        }
        else {
            $Details.Add([PSCustomObject]@{ File = $Name; Action = 'Ingest'; Severity = 'Ok'; NodeCount = $NodeList.Count; Reason = 'valid POV nodes' })
        }
        $IngestCount++
    }

    $FileCount = $Details.Count
    $Ok = ($Problems -eq 0)

    # ── Report ──
    Write-Host ''
    Write-Host '=== Taxonomy Directory Pre-Validation ===' -ForegroundColor Cyan
    Write-Host "  Directory:   $Path" -ForegroundColor White
    Write-Host "  JSON files:  $FileCount" -ForegroundColor White
    Write-Host "  Would ingest: $IngestCount    Would skip: $SkipCount" -ForegroundColor White
    Write-Host "  Problems:    $Problems" -ForegroundColor $(if ($Problems -gt 0) { 'Red' } else { 'Green' })
    Write-Host ''

    foreach ($D in $Details) {
        $Color = switch ($D.Severity) {
            'Error'   { 'Red' }
            'Warning' { 'Yellow' }
            'Ok'      { 'Green' }
            default   { 'DarkGray' }
        }
        $Label = if ($D.Action -eq 'Skip') { 'SKIP  ' } else { 'INGEST' }
        Write-Host "  [$Label] $($D.File): $($D.Reason)" -ForegroundColor $Color
    }
    Write-Host ''
    if ($Ok) {
        Write-Host '  No ingest-blocking problems found — safe to run Update-TaxEmbeddings.' -ForegroundColor Green
    }
    else {
        Write-Host "  $Problems file(s) would crash or degrade the embedding run. Fix or add to SKIP_FILES in embed_taxonomy.py before embedding." -ForegroundColor Red
    }
    Write-Host ''

    if ($PassThru) {
        [PSCustomObject]@{
            Ok          = $Ok
            Directory   = $Path
            FileCount   = $FileCount
            IngestCount = $IngestCount
            SkipCount   = $SkipCount
            Problems    = $Problems
            Details     = @($Details)
        }
    }
}
