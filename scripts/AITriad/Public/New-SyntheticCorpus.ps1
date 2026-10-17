# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function New-SyntheticCorpus {
    <#
    .SYNOPSIS
        Generates synthetic statements for taxonomy nodes using archetype templates.
    .DESCRIPTION
        Orchestrates API calls to generate synthetic debate statements using
        CL-provided PromptAssembler templates. Prompts are grouped by archetype
        for prompt cache efficiency. Models are randomized per archetype group.

        Requires CL prerequisite artifacts: _confusable_neighbors.json and
        _pov_profile_{acc,saf,skp}.json.
    .PARAMETER Pov
        Generate for nodes in this POV camp (default: all).
    .PARAMETER PilotNodes
        Generate only for these specific node IDs (pilot mode).
    .PARAMETER Full
        Generate for all nodes in the specified POV(s). Safety switch to
        prevent accidental 57K+ API call runs.
    .PARAMETER CandidatesPerNode
        Target candidates per node before pruning (default: 48).
    .PARAMETER Models
        AI models for generation. Randomized per archetype group.
    .PARAMETER Temperature
        Generation temperature (default: 1.0 for diversity).
    .PARAMETER Concurrency
        Number of archetype groups to process in parallel (default: 1).
        Requires PowerShell 7+. Each parallel runspace reimports the module.
        Rate limit safe up to ~4 with Gemini free tier (60 RPM).
    .PARAMETER ResetCheckpoint
        Clears the crash-recovery checkpoint before starting. Use this to
        force regeneration of prompts that were previously completed in an
        interrupted run but not yet saved to corpus files.
    .EXAMPLE
        New-SyntheticCorpus -PilotNodes 'acc-beliefs-003', 'saf-beliefs-023'
    .EXAMPLE
        New-SyntheticCorpus -Pov acc -Full
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-AIByUsage
    .LINK
        Invoke-BDIWeightAssignment
    .LINK
        Invoke-EdgeWeightEvaluation
    .LINK
        Invoke-VernacularBatch
    .LINK
        Invoke-AphorismBatch
    .LINK
        Sync-SyntheticCorpus
    #>
    [CmdletBinding(DefaultParameterSetName = 'Pilot')]
    param(
        [ValidateSet('acc', 'saf', 'skp', 'all')]
        [string]$Pov = 'all',

        [Parameter(ParameterSetName = 'Pilot')]
        [string[]]$PilotNodes,

        [Parameter(ParameterSetName = 'Full', Mandatory)]
        [switch]$Full,

        [int]$CandidatesPerNode = 48,

        [string[]]$Models = @('gemini-2.5-flash', 'claude-sonnet-4'),

        [ValidateRange(0.0, 2.0)]
        [double]$Temperature = 1.0,

        [ValidateRange(1, 16)]
        [int]$Concurrency = 1,

        [switch]$ResetCheckpoint
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Resolve paths ───────────────────────────────────────────────────
    $CorpusScript = Join-Path $script:RepoRoot 'scripts/generate_corpus.py'
    if (-not (Test-Path $CorpusScript)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Generate synthetic corpus' `
            -Problem "generate_corpus.py not found at $CorpusScript" `
            -Location 'New-SyntheticCorpus' `
            -NextSteps 'Ensure scripts/generate_corpus.py exists.')
    }

    $TaxDir = Get-TaxonomyDir
    $SyntheticDir = Join-Path $TaxDir 'synthetic'
    if (-not (Test-Path $SyntheticDir)) { New-Item -ItemType Directory -Path $SyntheticDir -Force | Out-Null }

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    # ── Get prompts from PromptAssembler ────────────────────────────────
    $PromptArgs = @('get-prompts', '--taxonomy-dir', $TaxDir)
    if ($PilotNodes) {
        $PromptArgs += @('--node-ids', ($PilotNodes -join ','))
        Write-Host "`nSynthetic Corpus — PILOT mode ($($PilotNodes.Count) nodes)" -ForegroundColor Cyan
    }
    elseif ($Full) {
        $PromptArgs += @('--pov', $Pov)
        Write-Host "`nSynthetic Corpus — FULL mode (pov=$Pov)" -ForegroundColor Cyan
    }
    else {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Generate synthetic corpus' `
            -Problem 'Must specify -PilotNodes or -Full' `
            -Location 'New-SyntheticCorpus' `
            -NextSteps 'Use -PilotNodes for pilot generation or -Full for all nodes.')
    }

    Write-Host "Models: $($Models -join ', ')  Temperature: $Temperature" -ForegroundColor DarkGray
    Write-Host "Fetching prompts from PromptAssembler..." -ForegroundColor DarkGray

    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $RawOutput = & $PythonCmd $CorpusScript @PromptArgs 2>&1 }
    finally { $ErrorActionPreference = $PrevEAP }

    $StdOut = @($RawOutput | Where-Object { $_ -is [string] }) -join ''
    $StdErr = @($RawOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) | ForEach-Object { $_.ToString() }
    if ($StdErr) { $StdErr | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Generate synthetic corpus' `
            -Problem "generate_corpus.py get-prompts failed (exit $LASTEXITCODE)" `
            -Location 'New-SyntheticCorpus' `
            -NextSteps "Check that _archetype_templates.py and prerequisite artifacts exist in research/comp-linguist/`n$StdErr")
    }

    $PromptData = $StdOut | ConvertFrom-Json
    $AllPrompts = @($PromptData.prompts)
    $TotalPrompts = $AllPrompts.Count

    if ($TotalPrompts -eq 0) {
        Write-Warning 'No prompts generated — check node IDs and prerequisite artifacts.'
        return
    }

    # ── Cost estimate + confirmation ────────────────────────────────────
    $EstStatements = ($AllPrompts | ForEach-Object { $_.count } | Measure-Object -Sum).Sum
    Write-Host "`n  Prompts: $TotalPrompts" -ForegroundColor White
    Write-Host "  Estimated statements: $EstStatements" -ForegroundColor White
    Write-Host "  API calls: $TotalPrompts" -ForegroundColor White

    if ($TotalPrompts -gt 100) {
        Write-Host "`n  This will make $TotalPrompts API calls. Proceeding..." -ForegroundColor Yellow
    }

    # ── Group by archetype for cache efficiency ─────────────────────────
    $ByArchetype = @{}
    foreach ($p in $AllPrompts) {
        $Key = "$($p.archetype)|$($p.audience)"
        if (-not $ByArchetype.ContainsKey($Key)) { $ByArchetype[$Key] = @() }
        $ByArchetype[$Key] += $p
    }

    Write-Host "`n  Archetype groups: $($ByArchetype.Count)" -ForegroundColor DarkGray

    # ── Build resume state ──────────────────────────────────────────────
    $AllEntries = @{}
    $CompletedHashes = [System.Collections.Generic.HashSet[string]]::new()

    if ($ResetCheckpoint) {
        @(Get-ChildItem $SyntheticDir -Filter '_checkpoint*.jsonl' -ErrorAction SilentlyContinue) |
            ForEach-Object { Remove-Item $_.FullName -Force }
        Write-Host "  Checkpoint reset." -ForegroundColor Yellow
    }

    foreach ($cf in @(Get-ChildItem $SyntheticDir -Filter 'corpus_*.json' -ErrorAction SilentlyContinue)) {
        try {
            $data = Get-Content -Raw -Path $cf.FullName | ConvertFrom-Json
            $beforeCount = $CompletedHashes.Count
            foreach ($e in @($data.entries)) {
                if ($e.prompt_hash) { [void]$CompletedHashes.Add($e.prompt_hash) }
            }
            Write-Verbose "  Corpus $($cf.Name): $($CompletedHashes.Count - $beforeCount) prompt hashes loaded"
        } catch { }
    }
    Write-Verbose "  Resume state: $($CompletedHashes.Count) total completed hashes from corpus files"

    $CheckpointFiles = @(Get-ChildItem $SyntheticDir -Filter '_checkpoint*.jsonl' -ErrorAction SilentlyContinue)
    if ($CheckpointFiles.Count -gt 0) {
        Write-Verbose "  Loading crash checkpoints: $($CheckpointFiles.Count) file(s)"
        $RecoveredCount = 0
        $RecoveredStmts = 0
        foreach ($cpFile in $CheckpointFiles) {
            foreach ($line in @(Get-Content -Path $cpFile.FullName -ErrorAction SilentlyContinue)) {
                if (-not $line.Trim()) { continue }
                try {
                    $cp = $line | ConvertFrom-Json
                    if ($cp.prompt_hash) { [void]$CompletedHashes.Add($cp.prompt_hash) }
                    $entryCount = 0
                    foreach ($entry in @($cp.entries)) {
                        $nid = $entry.node_id
                        if (-not $AllEntries.ContainsKey($nid)) { $AllEntries[$nid] = @() }
                        $AllEntries[$nid] += $entry
                        $entryCount++
                        $RecoveredStmts++
                    }
                    $RecoveredCount++
                    Write-Verbose "    Checkpoint: $($cp.node_id) [$($cp.prompt_hash.Substring(0, [Math]::Min(8, $cp.prompt_hash.Length)))] — $entryCount entries"
                } catch { }
            }
        }
        if ($RecoveredCount -gt 0) {
            Write-Host "  Recovered $RecoveredCount prompt results ($RecoveredStmts statements) from interrupted run" -ForegroundColor Yellow
        }
    }

    $SkippableCount = @($AllPrompts | Where-Object { $CompletedHashes.Contains($_.prompt_hash) }).Count
    $RemainingCount = $TotalPrompts - $SkippableCount

    if ($SkippableCount -gt 0) {
        Write-Host "  Resuming: $SkippableCount/$TotalPrompts prompts already done, $RemainingCount remaining" -ForegroundColor Green
    }

    # ── Generation ──────────────────────────────────────────────────────
    $CallCount = 0
    $FailCount = 0
    $SkipCount = 0
    $StatementCount = 0
    foreach ($vals in $AllEntries.Values) { $StatementCount += @($vals).Count }
    $StartTime = Get-Date

    if ($RemainingCount -eq 0) {
        $SkipCount = $TotalPrompts
        Write-Host "`n  All prompts already completed. Use -ResetCheckpoint to regenerate." -ForegroundColor Green
    }
    elseif ($Concurrency -gt 1 -and $PSVersionTable.PSVersion.Major -ge 7) {
        # ── Parallel archetype groups ───────────────────────────────────
        Write-Host "  Concurrency: $Concurrency parallel archetype groups" -ForegroundColor DarkGray

        $ModulePath = Join-Path $script:ModuleRoot 'AITriad.psm1'
        $AIEnrichPath = Join-Path (Join-Path $script:ModuleRoot '..') 'AIEnrich.psm1'
        $GroupKeys = @($ByArchetype.Keys | Sort-Object)

        $ParallelResults = $GroupKeys | ForEach-Object -Parallel {
            $GroupKey = $_
            $ByArchetype = $using:ByArchetype
            $Models = $using:Models
            $Temperature = $using:Temperature
            $CompletedHashes = $using:CompletedHashes
            $SyntheticDir = $using:SyntheticDir
            $VerbosePreference = $using:VerbosePreference
            $SafeGroupKey = ($GroupKey -replace '[^a-zA-Z0-9_-]', '_')
            $GroupCheckpointPath = Join-Path $SyntheticDir "_checkpoint_$SafeGroupKey.jsonl"

            Import-Module $using:ModulePath -Force
            Import-Module $using:AIEnrichPath -Force
            Write-Verbose "  [$GroupKey] Module loaded in parallel runspace"

            $GroupPrompts = @($ByArchetype[$GroupKey])
            $ModelIdx = Get-Random -Minimum 0 -Maximum $Models.Count
            $GroupModel = $Models[$ModelIdx]

            $Parts = $GroupKey -split '\|'
            $ArchLabel = $Parts[0]
            $AudLabel = if ($Parts[1] -and $Parts[1] -ne '') { " ($($Parts[1]))" } else { '' }

            Write-Host "`n  [$ArchLabel$AudLabel] → $GroupModel ($($GroupPrompts.Count) prompts)" -ForegroundColor Cyan

            $gCalls = 0; $gFails = 0; $gSkips = 0; $gStmts = 0
            $gEntries = [System.Collections.ArrayList]::new()

            foreach ($Prompt in $GroupPrompts) {
                if ($CompletedHashes.Contains($Prompt.prompt_hash)) {
                    $gSkips++
                    Write-Verbose "    $($Prompt.node_id) — skipped (already completed)"
                    continue
                }

                $gCalls++
                $NodeId = $Prompt.node_id

                try {
                    $AIResult = Invoke-AIApi `
                        -SystemInstruction $Prompt.system `
                        -Prompt $Prompt.user `
                        -Model $GroupModel `
                        -Temperature $Temperature `
                        -JsonMode `
                        -MaxTokens 4096

                    if (-not $AIResult -or -not $AIResult.Text) {
                        Write-Host "    ⚠ $NodeId — empty response" -ForegroundColor Yellow
                        $gFails++
                        continue
                    }

                    $Parsed = $null
                    try { $Parsed = $AIResult.Text | ConvertFrom-Json }
                    catch {
                        $Repaired = Repair-TruncatedJson -Text $AIResult.Text
                        if ($Repaired) { try { $Parsed = $Repaired | ConvertFrom-Json } catch { } }
                    }

                    if (-not $Parsed) {
                        Write-Host "    ⚠ $NodeId — JSON parse failed" -ForegroundColor Yellow
                        $gFails++
                        continue
                    }

                    $Statements = @($Parsed)
                    if ($Parsed.PSObject.Properties['statements']) { $Statements = @($Parsed.statements) }
                    elseif ($Parsed -is [array]) { $Statements = @($Parsed) }
                    elseif ($Parsed.PSObject.Properties['statement']) { $Statements = @($Parsed) }

                    $Now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    $promptEntries = @()
                    foreach ($s in $Statements) {
                        $StmtText = $null
                        if ($s.PSObject.Properties['statement']) { $StmtText = $s.statement }
                        elseif ($s -is [string]) { $StmtText = $s }
                        if (-not $StmtText) { continue }

                        $Entry = [ordered]@{
                            node_id              = $NodeId
                            statement            = $StmtText
                            archetype            = $Prompt.archetype
                            audience             = $Prompt.audience
                            model                = $GroupModel
                            generation_timestamp = $Now
                            prompt_hash          = $Prompt.prompt_hash
                            description_hash     = $Prompt.description_hash
                            rationale            = if ($s.PSObject.Properties['rationale']) { $s.rationale } else { $null }
                            pruned               = $false
                            prune_reason         = $null
                        }
                        $promptEntries += $Entry
                        [void]$gEntries.Add($Entry)
                        $gStmts++
                    }

                    if ($promptEntries.Count -gt 0) {
                        $cpLine = @{ prompt_hash = $Prompt.prompt_hash; node_id = $NodeId; entries = $promptEntries } |
                            ConvertTo-Json -Compress -Depth 5
                        Add-Content -Path $GroupCheckpointPath -Value $cpLine -Encoding UTF8
                        Write-Verbose "    $NodeId — checkpointed $($promptEntries.Count) entries ($($Prompt.prompt_hash.Substring(0, 8)))"
                    }

                    $Got = @($Statements).Count
                    $Color = if ($Got -ge $Prompt.count) { 'Green' } else { 'Yellow' }
                    Write-Host "    $NodeId — $Got statements" -ForegroundColor $Color
                }
                catch {
                    Write-Host "    ⚠ $NodeId — API error: $($_.Exception.Message)" -ForegroundColor Red
                    $gFails++
                }
            }

            Write-Host "  [$ArchLabel$AudLabel] done — $gCalls calls, $gStmts statements" -ForegroundColor DarkGray

            [PSCustomObject]@{
                Entries        = @($gEntries)
                CallCount      = $gCalls
                FailCount      = $gFails
                SkipCount      = $gSkips
                StatementCount = $gStmts
            }
        } -ThrottleLimit $Concurrency

        foreach ($result in @($ParallelResults)) {
            if (-not $result) { continue }
            $CallCount += $result.CallCount
            $FailCount += $result.FailCount
            $SkipCount += $result.SkipCount
            $StatementCount += $result.StatementCount
            foreach ($entry in @($result.Entries)) {
                $nid = $entry.node_id
                if (-not $AllEntries.ContainsKey($nid)) { $AllEntries[$nid] = @() }
                $AllEntries[$nid] += $entry
            }
        }
    }
    else {
        # ── Sequential archetype groups ─────────────────────────────────
        if ($Concurrency -gt 1) {
            Write-Warning "ForEach-Object -Parallel requires PowerShell 7+. Using sequential mode."
        }

        $SeqCheckpointPath = Join-Path $SyntheticDir '_checkpoint_seq.jsonl'
        foreach ($GroupKey in $ByArchetype.Keys | Sort-Object) {
            $GroupPrompts = @($ByArchetype[$GroupKey])
            $ModelIdx = Get-Random -Minimum 0 -Maximum $Models.Count
            $GroupModel = $Models[$ModelIdx]

            $Parts = $GroupKey -split '\|'
            $ArchLabel = $Parts[0]
            $AudLabel = if ($Parts[1] -and $Parts[1] -ne '') { " ($($Parts[1]))" } else { '' }

            Write-Host "`n  [$ArchLabel$AudLabel] → $GroupModel ($($GroupPrompts.Count) prompts)" -ForegroundColor Cyan

            foreach ($Prompt in $GroupPrompts) {
                if ($CompletedHashes.Contains($Prompt.prompt_hash)) {
                    $SkipCount++
                    Write-Verbose "    $($Prompt.node_id) — skipped (already completed)"
                    continue
                }

                $CallCount++
                $NodeId = $Prompt.node_id

                try {
                    $AIResult = Invoke-AIApi `
                        -SystemInstruction $Prompt.system `
                        -Prompt $Prompt.user `
                        -Model $GroupModel `
                        -Temperature $Temperature `
                        -JsonMode `
                        -MaxTokens 4096

                    if (-not $AIResult) {
                        Write-Host "    ⚠ $NodeId — null API response (missing key?)" -ForegroundColor Yellow
                        $FailCount++
                        continue
                    }
                    $ResponseText = $AIResult.Text
                    if (-not $ResponseText) {
                        Write-Host "    ⚠ $NodeId — empty response" -ForegroundColor Yellow
                        $FailCount++
                        continue
                    }

                    $Parsed = $null
                    try { $Parsed = $ResponseText | ConvertFrom-Json }
                    catch {
                        $Repaired = Repair-TruncatedJson -Text $ResponseText
                        if ($Repaired) { try { $Parsed = $Repaired | ConvertFrom-Json } catch { } }
                    }

                    if (-not $Parsed) {
                        Write-Host "    ⚠ $NodeId — JSON parse failed" -ForegroundColor Yellow
                        $FailCount++
                        continue
                    }

                    $Statements = @($Parsed)
                    if ($Parsed.PSObject.Properties['statements']) { $Statements = @($Parsed.statements) }
                    elseif ($Parsed -is [array]) { $Statements = @($Parsed) }
                    elseif ($Parsed.PSObject.Properties['statement']) { $Statements = @($Parsed) }

                    $Now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    $promptEntries = @()
                    foreach ($s in $Statements) {
                        $StmtText = $null
                        if ($s.PSObject.Properties['statement']) { $StmtText = $s.statement }
                        elseif ($s -is [string]) { $StmtText = $s }
                        if (-not $StmtText) { continue }

                        $Entry = [ordered]@{
                            node_id              = $NodeId
                            statement            = $StmtText
                            archetype            = $Prompt.archetype
                            audience             = $Prompt.audience
                            model                = $GroupModel
                            generation_timestamp = $Now
                            prompt_hash          = $Prompt.prompt_hash
                            description_hash     = $Prompt.description_hash
                            rationale            = if ($s.PSObject.Properties['rationale']) { $s.rationale } else { $null }
                            pruned               = $false
                            prune_reason         = $null
                        }
                        $promptEntries += $Entry

                        if (-not $AllEntries.ContainsKey($NodeId)) { $AllEntries[$NodeId] = @() }
                        $AllEntries[$NodeId] += $Entry
                        $StatementCount++
                    }

                    if ($promptEntries.Count -gt 0) {
                        $cpLine = @{ prompt_hash = $Prompt.prompt_hash; node_id = $NodeId; entries = $promptEntries } |
                            ConvertTo-Json -Compress -Depth 5
                        Add-Content -Path $SeqCheckpointPath -Value $cpLine -Encoding UTF8
                        Write-Verbose "    $NodeId — checkpointed $($promptEntries.Count) entries ($($Prompt.prompt_hash.Substring(0, 8)))"
                    }

                    $Got = @($Statements).Count
                    $Color = if ($Got -ge $Prompt.count) { 'Green' } else { 'Yellow' }
                    Write-Host "    $NodeId — $Got statements" -ForegroundColor $Color
                }
                catch {
                    Write-Host "    ⚠ $NodeId — API error: $($_.Exception.Message)" -ForegroundColor Red
                    $FailCount++
                }

                if ($CallCount % 20 -eq 0 -and $CallCount -gt 0) {
                    $Elapsed = ((Get-Date) - $StartTime).TotalSeconds
                    $Rate = [Math]::Round($CallCount / $Elapsed * 60, 1)
                    Write-Host "    ── $CallCount calls, $SkipCount skipped ($Rate/min) ──" -ForegroundColor DarkGray
                }
            }
        }
    }

    # ── Save per-POV corpus files ───────────────────────────────────────
    $Elapsed = [Math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    Write-Host " GENERATION COMPLETE" -ForegroundColor Cyan
    Write-Host "$('═' * 72)" -ForegroundColor Cyan
    Write-Host "  Calls: $CallCount  Skipped: $SkipCount  Failed: $FailCount  Statements: $StatementCount  ($($Elapsed)s)" -ForegroundColor White

    $PovGroups = @{}
    foreach ($NodeId in $AllEntries.Keys) {
        $PovKey = $NodeId.Split('-')[0]
        if (-not $PovGroups.ContainsKey($PovKey)) { $PovGroups[$PovKey] = @() }
        $PovGroups[$PovKey] += $AllEntries[$NodeId]
    }

    foreach ($PovKey in $PovGroups.Keys | Sort-Object) {
        $Entries = @($PovGroups[$PovKey])
        $CorpusPath = Join-Path $SyntheticDir "corpus_$PovKey.json"

        $ExistingEntries = @()
        if (Test-Path $CorpusPath) {
            try {
                $Existing = Get-Content -Raw -Path $CorpusPath | ConvertFrom-Json
                if ($Existing.PSObject.Properties['entries']) {
                    $ExistingEntries = @($Existing.entries)
                }
            }
            catch { Write-Warning "Could not read existing corpus: $CorpusPath" }
        }

        $NewHashes = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($e in $Entries) {
            if ($e.prompt_hash) { [void]$NewHashes.Add($e.prompt_hash) }
        }

        $Preserved = @($ExistingEntries | Where-Object {
            -not $_.prompt_hash -or -not $NewHashes.Contains($_.prompt_hash)
        })
        $MergedEntries = @($Preserved) + @($Entries)
        Write-Verbose "  $PovKey merge: $($Preserved.Count) preserved + $($Entries.Count) new = $($MergedEntries.Count) total"

        $UniqueNodes = @($MergedEntries | ForEach-Object { $_.node_id } | Select-Object -Unique)

        $Corpus = [ordered]@{
            pov         = $PovKey
            generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            node_count  = $UniqueNodes.Count
            entry_count = $MergedEntries.Count
            models      = $Models
            temperature = $Temperature
            entries     = $MergedEntries
        }

        $Corpus | ConvertTo-Json -Depth 10 -Compress |
            Set-Content -Path $CorpusPath -Encoding UTF8

        Write-Host "  $PovKey — $($Entries.Count) new entries ($($UniqueNodes.Count) nodes) → $CorpusPath" -ForegroundColor Green
    }

    @(Get-ChildItem $SyntheticDir -Filter '_checkpoint*.jsonl' -ErrorAction SilentlyContinue) |
        ForEach-Object {
            Write-Verbose "  Removing checkpoint: $($_.Name)"
            Remove-Item $_.FullName -Force
        }

    # ── Save metadata ───────────────────────────────────────────────────
    $MetadataPath = Join-Path $SyntheticDir 'metadata.json'
    $Metadata = [ordered]@{
        last_generation  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        models           = $Models
        temperature      = $Temperature
        concurrency      = $Concurrency
        mode             = if ($PilotNodes) { 'pilot' } else { 'full' }
        nodes_generated  = $AllEntries.Keys.Count
        total_statements = $StatementCount
        api_calls        = $CallCount
        skipped_calls    = $SkipCount
        failed_calls     = $FailCount
        elapsed_seconds  = $Elapsed
    }
    $Metadata | ConvertTo-Json -Depth 5 | Set-Content -Path $MetadataPath -Encoding UTF8

    Write-Host "`n  Metadata: $MetadataPath" -ForegroundColor DarkGray
    Write-Host ""

    return [PSCustomObject]@{
        NodesGenerated  = $AllEntries.Keys.Count
        TotalStatements = $StatementCount
        ApiCalls        = $CallCount
        FailedCalls     = $FailCount
        ElapsedSeconds  = $Elapsed
        CorpusDir       = $SyntheticDir
    }
}
