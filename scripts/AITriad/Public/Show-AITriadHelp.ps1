# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-AITriadHelp {
    <#
    .SYNOPSIS
        Generates a self-contained, searchable HTML reference for every public
        AITriad cmdlet and opens it in the default browser.
    .DESCRIPTION
        Introspects the loaded AITriad module (Get-Command + Get-Help) and builds
        a single-page HTML reference covering EVERY exported public cmdlet. The
        page is auto-generated from each cmdlet's comment-based help (synopsis,
        syntax, parameters, examples, and RELATED LINKS), so it never drifts out
        of sync with the module — adding a new cmdlet with proper help requires no
        edit to this function.

        Layout (per the Design spec in docs/ux/aitriad-help-redesign.md):
        a sticky category sidebar on the left and a searchable cmdlet list on the
        right. All cmdlet data is embedded as a JSON blob and filtered client-side
        — no network calls, no external CSS/JS. Each row collapses to name +
        synopsis and expands in place to show parameters, examples, and SEE ALSO
        jump links.

        The file is written to the system temp directory with a fixed name so
        repeated calls overwrite instead of accumulating temp files.
    .PARAMETER PassThru
        Return the generated file path instead of opening the browser.
    .EXAMPLE
        Show-AITriadHelp
        # Opens the searchable help page in the default browser.
    .EXAMPLE
        Show-AITriadHelp -PassThru
        # Returns the temp file path without opening a browser.
    .LINK
        Show-POViewer
    .LINK
        Show-SummaryViewer
    .LINK
        Show-TaxonomyEditor
    .LINK
        Show-WorkflowRunner
    #>
    [CmdletBinding()]
    param(
        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ------------------------------------------------------------------ #
    # Module version (from manifest)                                     #
    # ------------------------------------------------------------------ #
    $ManifestPath = Join-Path (Join-Path $PSScriptRoot '..') 'AITriad.psd1'
    $ManifestData = Import-PowerShellDataFile -Path $ManifestPath
    $Version      = $ManifestData.ModuleVersion
    $Generated    = Get-Date -Format 'yyyy-MM-dd HH:mm'

    $ModuleName = 'AITriad'
    if ($MyInvocation.MyCommand.Module -and $MyInvocation.MyCommand.Module.Name) {
        $ModuleName = $MyInvocation.MyCommand.Module.Name
    }

    # ------------------------------------------------------------------ #
    # Category taxonomy — sidebar order + per-cmdlet assignment.         #
    # Cmdlets absent from the map fall into 'Uncategorized' (never       #
    # silently dropped). Seeded from the AGENTS.md cmdlet catalog and    #
    # the RELATED LINKS family map (commit df0583f8).                    #
    # ------------------------------------------------------------------ #
    $CategoryOrder = @(
        'Taxonomy Data'
        'Edges'
        'Graph & Conflict'
        'Organizations'
        'Entities'
        'Debate Engine'
        'Sources & Ingestion'
        'AI Enrichment'
        'Health & Diagnostics'
        'Deployment & TaxEditor'
        'Config & Setup'
        'Data Repair & Migration'
        'Apps & Utilities'
    )

    $CategoryMap = @{
        # Taxonomy Data
        'Get-Tax' = 'Taxonomy Data'; 'Get-GraphNode' = 'Taxonomy Data'
        'Get-Policy' = 'Taxonomy Data'; 'Find-PolicyAction' = 'Taxonomy Data'
        'Update-PolicyRegistry' = 'Taxonomy Data'; 'Invoke-PolicyRefinement' = 'Taxonomy Data'
        'Get-TaxonomyHealth' = 'Taxonomy Data'; 'Compare-Taxonomy' = 'Taxonomy Data'
        'Test-TaxonomyIntegrity' = 'Taxonomy Data'; 'Test-OntologyCompliance' = 'Taxonomy Data'
        'Test-TaxonomyDir' = 'Taxonomy Data'
        'Get-RelevantTaxonomyNodes' = 'Taxonomy Data'; 'Measure-TaxonomyBaseline' = 'Taxonomy Data'
        'Get-TaxonomyProcess' = 'Taxonomy Data'; 'Update-TaxEmbeddings' = 'Taxonomy Data'
        'Set-TaxonomyHierarchy' = 'Taxonomy Data'; 'Approve-TaxonomyProposal' = 'Taxonomy Data'
        'Invoke-TaxonomyProposal' = 'Taxonomy Data'; 'Invoke-HierarchyProposal' = 'Taxonomy Data'
        'Find-SituationCandidates' = 'Taxonomy Data'

        # Edges
        'Approve-Edge' = 'Edges'; 'Get-Edge' = 'Edges'; 'Set-Edge' = 'Edges'
        'Test-EdgeDirection' = 'Edges'; 'Invoke-EdgeDiscovery' = 'Edges'
        'Invoke-EdgeWeightEvaluation' = 'Edges'

        # Graph & Conflict
        'Find-GraphPath' = 'Graph & Conflict'; 'Find-Conflict' = 'Graph & Conflict'
        'Invoke-GraphQuery' = 'Graph & Conflict'; 'Invoke-CypherQuery' = 'Graph & Conflict'
        'Invoke-QbafConflictAnalysis' = 'Graph & Conflict'; 'Show-GraphOverview' = 'Graph & Conflict'
        'Export-TaxonomyToGraph' = 'Graph & Conflict'; 'Get-ConflictEvolution' = 'Graph & Conflict'

        # Organizations
        'Get-Organization' = 'Organizations'; 'Find-OrganizationByPOV' = 'Organizations'
        'Find-OrganizationByTopic' = 'Organizations'; 'Get-OrganizationStakeholders' = 'Organizations'
        'Import-Organization' = 'Organizations'; 'Compare-OrganizationPositions' = 'Organizations'
        'Get-OrganizationEdge' = 'Organizations'; 'Import-OrganizationEdge' = 'Organizations'
        'Invoke-OrgClaimMatching' = 'Organizations'; 'Invoke-OrgDerivedCampScores' = 'Organizations'
        'Invoke-OrgPublishedSeeding' = 'Organizations'; 'Invoke-OrgStanceExtraction' = 'Organizations'

        # Entities (t/1804/t/1806)
        'Get-Entity' = 'Entities'; 'Import-Entity' = 'Entities'
        'Invoke-EntityExtraction' = 'Entities'; 'Get-EntityReport' = 'Entities'

        # Debate Engine
        'Show-TriadDialogue' = 'Debate Engine'; 'Invoke-AITDebate' = 'Debate Engine'
        'Resume-AITDebate' = 'Debate Engine'; 'Get-AITDebate' = 'Debate Engine'
        'Compare-DebateRuns' = 'Debate Engine'; 'Compare-DebateQuality' = 'Debate Engine'
        'Measure-DebateQuality' = 'Debate Engine'; 'Invoke-DebateBatch' = 'Debate Engine'
        'Invoke-DebateAB' = 'Debate Engine'; 'Watch-DebateProgress' = 'Debate Engine'
        'Show-DebateDiagnostics' = 'Debate Engine'; 'Show-DebateHarvest' = 'Debate Engine'
        'Repair-DebateOutput' = 'Debate Engine'; 'Convert-DebateToAudio' = 'Debate Engine'
        'Get-AITClaim' = 'Debate Engine'; 'Get-CriticalInteraction' = 'Debate Engine'
        'Test-CriticalInteractions' = 'Debate Engine'; 'Get-CalibrationTrend' = 'Debate Engine'
        'Test-AITJudgeModel' = 'Debate Engine'; 'Test-SynthesisCompleteness' = 'Debate Engine'
        'Get-TopicFrequency' = 'Debate Engine'; 'Export-AggregatedCruxes' = 'Debate Engine'
        'Find-PossibleFallacy' = 'Debate Engine'; 'Show-FallacyInfo' = 'Debate Engine'

        # Sources & Ingestion
        'Import-AITriadDocument' = 'Sources & Ingestion'; 'Save-AITSource' = 'Sources & Ingestion'
        'Find-AITSource' = 'Sources & Ingestion'; 'Get-AITSource' = 'Sources & Ingestion'
        'Update-AITSourceIndex' = 'Sources & Ingestion'; 'Get-IntellectualLineage' = 'Sources & Ingestion'
        'Get-PovLineage' = 'Sources & Ingestion'; 'Get-IngestionPriority' = 'Sources & Ingestion'
        'Invoke-AttributeExtraction' = 'Sources & Ingestion'; 'Save-WaybackUrl' = 'Sources & Ingestion'
        'Update-Snapshot' = 'Sources & Ingestion'; 'Get-ImportReport' = 'Sources & Ingestion'
        'Get-Summary' = 'Sources & Ingestion'

        # AI Enrichment
        'Invoke-AIByUsage' = 'AI Enrichment'; 'Invoke-BatchSummary' = 'AI Enrichment'
        'Invoke-POVSummary' = 'AI Enrichment'; 'Invoke-BDIWeightAssignment' = 'AI Enrichment'
        'Invoke-VernacularBatch' = 'AI Enrichment'; 'Invoke-AphorismBatch' = 'AI Enrichment'
        'New-SyntheticCorpus' = 'AI Enrichment'; 'Sync-SyntheticCorpus' = 'AI Enrichment'
        'Update-SyntheticCorpus' = 'AI Enrichment'; 'Export-SyntheticEmbeddings' = 'AI Enrichment'
        'Compare-EmbeddingModel' = 'AI Enrichment'; 'Test-RerankerBaseline' = 'AI Enrichment'
        'Test-ExtractionQuality' = 'AI Enrichment'

        # Health & Diagnostics
        'Test-TaxEditorHealth' = 'Health & Diagnostics'; 'Test-TaxEditorEndpoints' = 'Health & Diagnostics'
        'Test-AnonymousDebateFlow' = 'Health & Diagnostics'; 'Test-PersonaEndpoints' = 'Health & Diagnostics'
        'Test-ServiceWorkerHealth' = 'Health & Diagnostics'; 'Get-FreeTierStatus' = 'Health & Diagnostics'
        'Test-AzureHealth' = 'Health & Diagnostics'; 'Test-GitHubHealth' = 'Health & Diagnostics'
        'Get-ContainerAppRevision' = 'Health & Diagnostics'; 'Get-GitHubWorkflowRun' = 'Health & Diagnostics'
        'Remove-StaleContainerImages' = 'Health & Diagnostics'; 'Get-TaxonomySnapshot' = 'Health & Diagnostics'
        'Get-AICostReport' = 'Health & Diagnostics'; 'Invoke-TaxEditorSmokeTest' = 'Health & Diagnostics'
        'Test-TaxEditorInfra' = 'Health & Diagnostics'; 'Get-AzureFlightRecorder' = 'Health & Diagnostics'
        'Get-FlightRecorderDump' = 'Health & Diagnostics'; 'Get-FlightRecorderReport' = 'Health & Diagnostics'
        'Merge-FlightRecorderDumps' = 'Health & Diagnostics'; 'Request-FlightRecorderDump' = 'Health & Diagnostics'
        'Show-FlightRecorder' = 'Health & Diagnostics'; 'Get-LatestFlightRecorderDump' = 'Health & Diagnostics'

        # Deployment & TaxEditor
        'Deploy-TaxEditorImage' = 'Deployment & TaxEditor'; 'Deploy-TaxEditorInfra' = 'Deployment & TaxEditor'
        'Get-TaxEditorImage' = 'Deployment & TaxEditor'; 'Get-TaxEditorRevision' = 'Deployment & TaxEditor'
        'Switch-TaxEditorRevision' = 'Deployment & TaxEditor'; 'Get-TaxEditorBlob' = 'Deployment & TaxEditor'
        'Get-TaxEditorDataCommit' = 'Deployment & TaxEditor'; 'Restore-TaxEditorBlob' = 'Deployment & TaxEditor'
        'Restore-TaxEditorKnownGood' = 'Deployment & TaxEditor'; 'Set-TaxEditorKnownGood' = 'Deployment & TaxEditor'
        'Set-TaxEditorPinnedTag' = 'Deployment & TaxEditor'
        'Sync-TaxEditorData' = 'Deployment & TaxEditor'; 'Undo-TaxEditorDataCommit' = 'Deployment & TaxEditor'
        'Reset-TaxEditorSession' = 'Deployment & TaxEditor'

        # Config & Setup
        'Get-TriadConfig' = 'Config & Setup'; 'Set-TriadConfig' = 'Config & Setup'
        'Invoke-TriadConfigReload' = 'Config & Setup'; 'Register-AIBackend' = 'Config & Setup'
        'Test-AIApiKey' = 'Config & Setup'; 'Install-AIDependencies' = 'Config & Setup'
        'Test-AIModelsConfig' = 'Config & Setup'
        'Install-AITriadData' = 'Config & Setup'; 'Install-GraphDatabase' = 'Config & Setup'
        'Test-Dependencies' = 'Config & Setup'; 'Register-AITriadDrive' = 'Config & Setup'

        # Data Repair & Migration
        'Repair-PovAttributes' = 'Data Repair & Migration'; 'Repair-PovDescriptions' = 'Data Repair & Migration'
        'Repair-PovLineage' = 'Data Repair & Migration'; 'Repair-ResolvedBackfill' = 'Data Repair & Migration'
        'Repair-UnmappedConcepts' = 'Data Repair & Migration'; 'Repair-AITSummaryMappings' = 'Data Repair & Migration'
        'Invoke-CcToSitMigration' = 'Data Repair & Migration'; 'Invoke-SchemaMigration' = 'Data Repair & Migration'

        # Apps & Utilities
        'Show-AITriadHelp' = 'Apps & Utilities'; 'Show-POViewer' = 'Apps & Utilities'
        'Show-SummaryViewer' = 'Apps & Utilities'; 'Show-TaxonomyEditor' = 'Apps & Utilities'
        'Show-WorkflowRunner' = 'Apps & Utilities'; 'Convert-MD2PDF' = 'Apps & Utilities'
        'Repair-Markdown' = 'Apps & Utilities'; 'Show-Markdown' = 'Apps & Utilities'
        'Show-OSSLicenses' = 'Apps & Utilities'; 'Get-AITSBOM' = 'Apps & Utilities'
        'Invoke-PIIAudit' = 'Apps & Utilities'
    }

    # ------------------------------------------------------------------ #
    # Introspect every public cmdlet via Get-Help.                       #
    # Source of truth = the Public/ directory (this file lives in it).   #
    # Get-Command -Module returns private helpers too (they are          #
    # dot-sourced into the module scope), so enumerate Public/*.ps1.     #
    # ------------------------------------------------------------------ #
    $Commands = @(
        Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' |
            Sort-Object Name |
            ForEach-Object { Get-Command -Name $_.BaseName -ErrorAction SilentlyContinue } |
            Where-Object { $_ -and $_.CommandType -eq 'Function' }
    )

    $CmdletData = [ordered]@{}
    $CategoryBuckets = [ordered]@{}

    foreach ($cmd in $Commands) {
        $name = $cmd.Name

        $category = 'Uncategorized'
        if ($CategoryMap.ContainsKey($name)) { $category = $CategoryMap[$name] }

        $synopsis  = ''
        $parameters = [System.Collections.Generic.List[object]]::new()
        $examples   = [System.Collections.Generic.List[object]]::new()
        $links      = [System.Collections.Generic.List[string]]::new()

        try {
            $help = Get-Help $name -Full -ErrorAction Stop

            if ($help.PSObject.Properties['Synopsis'] -and $help.Synopsis) {
                $synopsis = ([string]$help.Synopsis).Trim()
            }

            # Parameters (Get-Help already excludes CommonParameters)
            if ($help.PSObject.Properties['parameters'] -and $help.parameters -and
                $help.parameters.PSObject.Properties['parameter']) {
                foreach ($p in @($help.parameters.parameter)) {
                    $pType = ''
                    if ($p.PSObject.Properties['type'] -and $p.type -and $p.type.PSObject.Properties['name']) {
                        $pType = [string]$p.type.name
                    }
                    $pDesc = ''
                    if ($p.PSObject.Properties['description'] -and $p.description) {
                        $pDesc = (@($p.description) | ForEach-Object {
                            if ($_.PSObject.Properties['text']) { $_.text }
                        }) -join ' '
                        $pDesc = $pDesc.Trim()
                    }
                    $pReq = $false
                    if ($p.PSObject.Properties['required']) { $pReq = ([string]$p.required -eq 'true') }

                    $parameters.Add([ordered]@{
                        name        = [string]$p.name
                        type        = $pType
                        required    = $pReq
                        description = $pDesc
                    })
                }
            }

            # Examples
            if ($help.PSObject.Properties['examples'] -and $help.examples -and
                $help.examples.PSObject.Properties['example']) {
                foreach ($ex in @($help.examples.example)) {
                    $code = ''
                    if ($ex.PSObject.Properties['code'] -and $ex.code) { $code = [string]$ex.code }
                    $remarks = ''
                    if ($ex.PSObject.Properties['remarks'] -and $ex.remarks) {
                        $remarks = (@($ex.remarks) | ForEach-Object {
                            if ($_.PSObject.Properties['text']) { $_.text }
                        }) -join ' '
                        $remarks = $remarks.Trim()
                    }
                    $examples.Add([ordered]@{ code = $code.Trim(); description = $remarks })
                }
            }

            # RELATED LINKS (.LINK entries)
            if ($help.PSObject.Properties['relatedLinks'] -and $help.relatedLinks -and
                $help.relatedLinks.PSObject.Properties['navigationLink']) {
                foreach ($nl in @($help.relatedLinks.navigationLink)) {
                    if ($nl.PSObject.Properties['linkText'] -and $nl.linkText) {
                        $links.Add(([string]$nl.linkText).Trim())
                    }
                }
            }
        }
        catch {
            Write-Warning "Show-AITriadHelp: could not read help for $name — $($_.Exception.Message)"
        }

        # Syntax line(s) — reliable via Get-Command -Syntax
        $syntax = ''
        try {
            $syntax = ((Get-Command $name -Syntax) | Out-String).Trim()
        }
        catch { $syntax = '' }

        $supportsShouldProcess = $cmd.Parameters.ContainsKey('WhatIf')

        $CmdletData[$name] = [ordered]@{
            name                  = $name
            category              = $category
            synopsis              = $synopsis
            syntax                = $syntax
            supportsShouldProcess = $supportsShouldProcess
            parameters            = $parameters
            examples              = $examples
            links                 = $links
        }

        if (-not $CategoryBuckets.Contains($category)) {
            $CategoryBuckets[$category] = [System.Collections.Generic.List[string]]::new()
        }
        $CategoryBuckets[$category].Add($name)
    }

    # Final category order: declared order first, then any extras (e.g. Uncategorized).
    $orderedCategories = [System.Collections.Generic.List[string]]::new()
    foreach ($c in $CategoryOrder) {
        if ($CategoryBuckets.Contains($c)) { $orderedCategories.Add($c) }
    }
    foreach ($c in $CategoryBuckets.Keys) {
        if (-not $orderedCategories.Contains($c)) { $orderedCategories.Add($c) }
    }

    $categoriesObj = [ordered]@{}
    foreach ($c in $orderedCategories) { $categoriesObj[$c] = @($CategoryBuckets[$c]) }

    $payload = [ordered]@{
        version       = $Version
        generated     = $Generated
        categoryOrder = @($orderedCategories)
        categories    = $categoriesObj
        cmdlets       = $CmdletData
    }

    $DataJson = $payload | ConvertTo-Json -Depth 8 -Compress
    # Neutralize any accidental </script> so the blob can't break out of the tag.
    $DataJson = $DataJson.Replace('</', '<\/')

    $CmdletCount   = $Commands.Count
    $CategoryCount = $orderedCategories.Count

    # ------------------------------------------------------------------ #
    # HTML shell (single-quoted here-string — no PowerShell interpolation) #
    # Placeholders are substituted with String.Replace (literal, so the   #
    # JSON blob's $ characters are not treated as regex backreferences).   #
    # ------------------------------------------------------------------ #
    $Html = @'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AITriad Module Reference</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --bg: #f8fafc; --panel: #ffffff; --border: #e2e8f0;
    --text: #0f172a; --muted: #64748b; --accent: #3b82f6; --accent-text: #1e40af;
    --code-bg: #f1f5f9; --hover: #f1f5f9; --mark: #fef9c3;
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--text); background: var(--bg); margin: 0; line-height: 1.55;
    font-size: 14px;
  }
  code, pre, .mono { font-family: ui-monospace, 'Cascadia Code', 'Fira Code', Consolas, monospace; }

  /* Sticky header */
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 1rem;
    background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 0.6rem 1.25rem;
  }
  header.scrolled { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  header .title { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  header .version { font-size: 0.75rem; color: var(--muted); }
  header .spacer { flex: 1; }
  header .search-wrap { position: relative; }
  #search {
    min-width: 240px; font-size: 0.85rem; padding: 0.4rem 0.6rem;
    border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
    color: var(--text);
  }
  #search:focus { outline: 2px solid var(--accent); outline-offset: 0; }
  #result-count { font-size: 0.72rem; color: var(--muted); position: absolute; right: 2px; top: 100%; margin-top: 2px; }

  /* Layout */
  .layout { display: grid; grid-template-columns: 220px 1fr; align-items: start; }
  nav#sidebar {
    position: sticky; top: 49px; align-self: start;
    height: calc(100vh - 49px); overflow-y: auto;
    background: var(--panel); border-right: 1px solid var(--border);
    padding: 0.75rem 0;
  }
  .cat-link {
    display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    padding: 0.35rem 1rem 0.35rem 0.85rem; text-decoration: none; color: var(--text);
    border-left: 2px solid transparent; cursor: pointer; font-size: 0.82rem;
  }
  .cat-link:hover { background: var(--hover); }
  .cat-link.active { border-left-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  .cat-link.empty { color: #cbd5e1; }
  .cat-link .cat-count { color: var(--muted); font-size: 0.72rem; font-variant-numeric: tabular-nums; }
  .sidebar-total { padding: 0.6rem 1rem 0.2rem; margin-top: 0.4rem; border-top: 1px solid var(--border);
    color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }

  main { padding: 1rem 1.5rem 4rem; max-width: 960px; }
  .cat-section { scroll-margin-top: 60px; }
  .cat-section.flash > .cat-header { background: var(--hover); }
  .cat-header {
    display: flex; align-items: baseline; justify-content: space-between;
    font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text); margin: 1.4rem 0 0.4rem; padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--border);
  }
  .cat-header .cat-header-count { color: var(--muted); font-weight: 500; letter-spacing: 0; text-transform: none; }
  .cat-section:first-of-type .cat-header { margin-top: 0.4rem; }

  /* Rows */
  .row { border-bottom: 1px solid var(--border); }
  .row-head {
    display: flex; align-items: baseline; gap: 0.55rem; padding: 0.5rem 0.25rem;
    cursor: pointer; outline: none;
  }
  .row-head:hover { background: var(--hover); }
  .row-head:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); border-radius: 4px; }
  .tri { color: var(--muted); font-size: 0.7rem; width: 0.8rem; flex: none; transition: transform 0.12s; }
  .row.open .tri { transform: rotate(90deg); }
  .row-name { font-weight: 600; font-size: 0.86rem; white-space: nowrap; }
  .row-syn { color: var(--muted); font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-detail { display: none; padding: 0.4rem 0.25rem 1.1rem 1.35rem; background: var(--bg); }
  .row.open .row-detail { display: block; }

  .field-label { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--muted); margin: 0.9rem 0 0.35rem; }
  .field-label:first-child { margin-top: 0.3rem; }
  .synopsis-full { margin: 0.1rem 0; }
  pre { background: var(--code-bg); border-radius: 4px; padding: 0.6rem 0.8rem; overflow-x: auto;
    font-size: 0.8rem; margin: 0.2rem 0; white-space: pre-wrap; word-break: break-word; }
  table.params { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  table.params th, table.params td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border);
    vertical-align: top; }
  table.params th { color: var(--muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  table.params td.pname { font-family: ui-monospace, 'Cascadia Code', monospace; white-space: nowrap; }
  table.params td.ptype { color: var(--muted); white-space: nowrap; }
  .req-star { color: #dc2626; font-weight: 700; }
  .example { margin-bottom: 0.6rem; }
  .example .ex-desc { color: var(--muted); font-size: 0.8rem; margin: 0.15rem 0 0; }
  .seealso a { color: var(--accent-text); text-decoration: none; }
  .seealso a:hover { text-decoration: underline; }
  .seealso .sep { color: var(--muted); margin: 0 0.35rem; }
  .sp-note { color: var(--muted); font-size: 0.75rem; margin-top: 0.3rem; }
  mark { background: var(--mark); color: inherit; padding: 0 1px; border-radius: 2px; }
  .no-results { color: var(--muted); padding: 2rem 0.25rem; }

  footer { color: var(--muted); font-size: 0.72rem; padding: 1.5rem; text-align: center; }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --panel: #111827; --border: #1f2937;
      --text: #e5e7eb; --muted: #94a3b8; --accent: #60a5fa; --accent-text: #93c5fd;
      --code-bg: #0b1220; --hover: #172033; --mark: #78350f;
    }
    .cat-link.empty { color: #475569; }
    .req-star { color: #f87171; }
  }
</style>
</head>
<body>
<header id="header">
  <span class="title">AITriad Module Reference</span>
  <span class="version mono">v{{VERSION}}</span>
  <span class="spacer"></span>
  <span class="search-wrap">
    <input id="search" type="search" placeholder="filter cmdlets&hellip;" autocomplete="off" spellcheck="false" aria-label="Filter cmdlets">
    <span id="result-count"></span>
  </span>
</header>

<div class="layout">
  <nav id="sidebar" aria-label="Categories"></nav>
  <main>
    <div id="list"></div>
    <div id="no-results" class="no-results" hidden>No cmdlets match your search.</div>
  </main>
</div>

<footer>
  {{COUNT}} cmdlets in {{CATCOUNT}} categories &middot; AITriad v{{VERSION}} &middot; generated {{GENERATED}} &middot;
  auto-built by <span class="mono">Show-AITriadHelp</span>
</footer>

<script type="application/json" id="aitriad-data">{{DATA_JSON}}</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('aitriad-data').textContent);
  var CMD = DATA.cmdlets, ORDER = DATA.categoryOrder, CATS = DATA.categories;
  var TOTAL = Object.keys(CMD).length;

  var sidebar = document.getElementById('sidebar');
  var list = document.getElementById('list');
  var search = document.getElementById('search');
  var resultCount = document.getElementById('result-count');
  var noResults = document.getElementById('no-results');
  var header = document.getElementById('header');

  var rowEls = {};        // name -> row element
  var nameSpanEls = {};   // name -> row-name span
  var synSpanEls = {};    // name -> row-syn span
  var secEls = {};        // category -> section element
  var sideEls = {};       // category -> sidebar link
  var sideCountEls = {};  // category -> count span
  var headCountEls = {};  // category -> header count span

  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
  function esc(s) { s = (s == null) ? '' : String(s);
    return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function hl(s, term) {
    s = (s == null) ? '' : String(s);
    if (!term) return esc(s);
    var i = s.toLowerCase().indexOf(term);
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + term.length)) + '</mark>' + esc(s.slice(i + term.length));
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function buildDetail(c) {
    var d = el('div', 'row-detail');

    d.appendChild(el('div', 'field-label', 'Synopsis'));
    d.appendChild(el('p', 'synopsis-full', c.synopsis || '(no synopsis)'));

    if (c.syntax) {
      d.appendChild(el('div', 'field-label', 'Syntax'));
      d.appendChild(el('pre', 'mono', c.syntax));
    }

    var params = c.parameters || [];
    if (params.length) {
      d.appendChild(el('div', 'field-label', 'Parameters'));
      var tbl = el('table', 'params');
      var thead = el('tr');
      thead.appendChild(el('th', null, 'Name'));
      thead.appendChild(el('th', null, 'Type'));
      thead.appendChild(el('th', null, 'Description'));
      tbl.appendChild(thead);
      params.forEach(function (p) {
        var tr = el('tr');
        var nameCell = el('td', 'pname');
        nameCell.textContent = '-' + p.name;
        if (p.required) { var star = el('span', 'req-star', ' *'); nameCell.appendChild(star); }
        tr.appendChild(nameCell);
        tr.appendChild(el('td', 'ptype', p.type || ''));
        tr.appendChild(el('td', null, p.description || ''));
        tbl.appendChild(tr);
      });
      d.appendChild(tbl);
      if (c.supportsShouldProcess) d.appendChild(el('div', 'sp-note', 'Supports -WhatIf and -Confirm.'));
    } else if (c.supportsShouldProcess) {
      d.appendChild(el('div', 'sp-note', 'Supports -WhatIf and -Confirm.'));
    }

    var ex = c.examples || [];
    if (ex.length) {
      d.appendChild(el('div', 'field-label', 'Examples'));
      ex.forEach(function (e) {
        var wrap = el('div', 'example');
        wrap.appendChild(el('pre', 'mono', e.code || ''));
        if (e.description) wrap.appendChild(el('p', 'ex-desc', e.description));
        d.appendChild(wrap);
      });
    }

    var links = c.links || [];
    if (links.length) {
      d.appendChild(el('div', 'field-label', 'See also'));
      var sa = el('div', 'seealso');
      links.forEach(function (lk, idx) {
        if (idx > 0) sa.appendChild(el('span', 'sep', '·'));
        if (CMD[lk]) {
          var a = el('a', null, lk);
          a.href = '#';
          a.addEventListener('click', function (ev) { ev.preventDefault(); jumpTo(lk); });
          sa.appendChild(a);
        } else if (/^https?:\/\//i.test(lk)) {
          var ext = el('a', null, lk); ext.href = lk; ext.target = '_blank'; ext.rel = 'noopener';
          sa.appendChild(ext);
        } else {
          sa.appendChild(el('span', null, lk));
        }
      });
      d.appendChild(sa);
    }
    return d;
  }

  function buildRow(name) {
    var c = CMD[name];
    var row = el('div', 'row'); row.id = 'cmd-' + name;
    var head = el('div', 'row-head'); head.tabIndex = 0;
    head.appendChild(el('span', 'tri', '▸'));
    var nm = el('span', 'row-name'); nm.textContent = name;
    var syn = el('span', 'row-syn'); syn.textContent = c.synopsis || '';
    head.appendChild(nm); head.appendChild(syn);
    row.appendChild(head);
    row.appendChild(buildDetail(c));

    function toggle() {
      var willOpen = !row.classList.contains('open');
      if (willOpen) {
        // one open at a time within the same category
        var sec = secEls[c.category];
        if (sec) sec.querySelectorAll('.row.open').forEach(function (r) { r.classList.remove('open'); });
      }
      row.classList.toggle('open', willOpen);
    }
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });

    rowEls[name] = row; nameSpanEls[name] = nm; synSpanEls[name] = syn;
    return row;
  }

  function jumpTo(name) {
    var row = rowEls[name];
    if (!row) return;
    var c = CMD[name];
    var sec = secEls[c.category];
    if (sec) sec.querySelectorAll('.row.open').forEach(function (r) { if (r !== row) r.classList.remove('open'); });
    row.classList.add('open');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function flash(sec) {
    sec.classList.add('flash');
    setTimeout(function () { sec.classList.remove('flash'); }, 220);
  }

  // Build sidebar + sections
  ORDER.forEach(function (cat) {
    var names = CATS[cat] || [];

    var link = el('a', 'cat-link'); link.href = '#'; link.dataset.cat = cat;
    link.appendChild(el('span', 'cat-name', cat));
    var cnt = el('span', 'cat-count', String(names.length));
    link.appendChild(cnt);
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var sec = secEls[cat];
      if (sec) { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); flash(sec); }
    });
    sidebar.appendChild(link);
    sideEls[cat] = link; sideCountEls[cat] = cnt;

    var sec = el('section', 'cat-section'); sec.id = 'sec-' + slug(cat); sec.dataset.cat = cat;
    var h = el('h2', 'cat-header');
    h.appendChild(el('span', null, cat));
    var hc = el('span', 'cat-header-count', names.length + (names.length === 1 ? ' cmdlet' : ' cmdlets'));
    h.appendChild(hc);
    sec.appendChild(h);
    names.forEach(function (n) { sec.appendChild(buildRow(n)); });
    list.appendChild(sec);
    secEls[cat] = sec; headCountEls[cat] = hc;
  });

  var totalNote = el('div', 'sidebar-total', TOTAL + ' cmdlets total');
  sidebar.appendChild(totalNote);

  // Search
  function applyFilter(raw) {
    var term = raw.trim().toLowerCase();
    var shownTotal = 0;

    ORDER.forEach(function (cat) {
      var names = CATS[cat] || [];
      var catShown = 0;
      names.forEach(function (name) {
        var c = CMD[name];
        var hay = (name + ' ' + (c.synopsis || '') + ' ' +
          (c.parameters || []).map(function (p) { return p.name; }).join(' ')).toLowerCase();
        var match = !term || hay.indexOf(term) >= 0;
        rowEls[name].hidden = !match;
        if (match) {
          catShown++; shownTotal++;
          nameSpanEls[name].innerHTML = hl(name, term);
          synSpanEls[name].innerHTML = hl(c.synopsis || '', term);
        }
      });
      secEls[cat].hidden = (catShown === 0);
      sideCountEls[cat].textContent = term ? String(catShown) : String(names.length);
      sideEls[cat].classList.toggle('empty', term !== '' && catShown === 0);
      headCountEls[cat].textContent = catShown + (catShown === 1 ? ' cmdlet' : ' cmdlets');
    });

    if (term) { resultCount.textContent = shownTotal + ' of ' + TOTAL; }
    else { resultCount.textContent = ''; }
    noResults.hidden = shownTotal !== 0;
  }

  search.addEventListener('input', function () { applyFilter(search.value); });
  search.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { search.value = ''; applyFilter(''); }
  });

  // Active-category tracking via IntersectionObserver on section headers.
  var headers = ORDER.map(function (cat) { return secEls[cat].querySelector('.cat-header'); });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          var cat = en.target.closest('.cat-section').dataset.cat;
          Object.keys(sideEls).forEach(function (k) { sideEls[k].classList.toggle('active', k === cat); });
        }
      });
    }, { rootMargin: '-49px 0px -70% 0px', threshold: 0 });
    headers.forEach(function (h) { if (h) io.observe(h); });
  }

  // Header shadow on scroll
  window.addEventListener('scroll', function () {
    header.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  // Focus search on '/'
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });
})();
</script>
</body>
</html>
'@

    # Literal substitutions (String.Replace, not -replace: the JSON blob and
    # syntax lines contain '$' which -replace would treat as backreferences).
    $Html = $Html.Replace('{{DATA_JSON}}', $DataJson)
    $Html = $Html.Replace('{{VERSION}}',   $Version)
    $Html = $Html.Replace('{{GENERATED}}', $Generated)
    $Html = $Html.Replace('{{COUNT}}',     [string]$CmdletCount)
    $Html = $Html.Replace('{{CATCOUNT}}',  [string]$CategoryCount)

    # Unpredictable name — a fixed temp filename lets a local attacker pre-create
    # the path (e.g. as a symlink) to redirect this write (t/2530 L2).
    $TempPath = New-SecureTempPath -Prefix 'AITriad-Help' -Extension 'html'
    Set-Content -Path $TempPath -Value $Html -Encoding utf8

    if ($PassThru) {
        return $TempPath
    }

    # Open in default browser (cross-platform, PS 7+)
    if ($IsWindows) {
        Start-Process $TempPath
    }
    elseif ($IsMacOS) {
        Start-Process 'open' -ArgumentList $TempPath
    }
    elseif ($IsLinux) {
        Start-Process 'xdg-open' -ArgumentList $TempPath
    }
}
