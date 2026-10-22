# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Show-TriadDialogue {
    <#
    .SYNOPSIS
        Simulates a structured three-agent debate grounded in the AI Triad taxonomy.
    .DESCRIPTION
        Runs a multi-round debate between Accelerationist (accelerationist), Safetyist (safetyist),
        and Skeptic (skeptic). Each agent's arguments are grounded in taxonomy nodes and edges.
        Produces opening statements, N debate rounds, and a synthesis. Output is compatible
        with the taxonomy-editor DebateTab.
    .PARAMETER Topic
        The debate topic (mandatory).
    .PARAMETER Rounds
        Number of debate rounds after opening statements (1-15, default 3).
    .PARAMETER OutputFile
        Optional path to write the debate JSON. If omitted, writes to debates/debate-<guid>.json.
    .PARAMETER Model
        AI model override. Defaults to 'gemini-3.5-flash-lite'.
    .PARAMETER ApiKey
        AI API key override.
    .PARAMETER RepoRoot
        Path to the repository root.
    .PARAMETER UseAdaptiveStaging
        Enable adaptive staging (delegates to CLI engine via Invoke-AITDebate).
        Phases advance based on debate health metrics instead of fixed round count.
    .PARAMETER Pacing
        Adaptive staging pace: 'tight' (fewer rounds), 'moderate' (default), 'thorough' (more rounds).
    .PARAMETER MaxTotalRounds
        Maximum rounds for adaptive staging (5-20, default 12). Ignored without -UseAdaptiveStaging.
    .PARAMETER AllowEarlyTermination
        Allow debate to end early if health metrics collapse. Default: true when adaptive staging is on.
    .EXAMPLE
        Show-TriadDialogue "Should AI be regulated like a public utility?" -Rounds 2
    .EXAMPLE
        Show-TriadDialogue "Is open-source AI safer than closed-source?" -OutputFile debate.json
    .EXAMPLE
        Show-TriadDialogue "Scaling limits of current AI" -UseAdaptiveStaging -Pacing thorough
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-AITDebate
    .LINK
        Get-AITDebate
    .LINK
        Resume-AITDebate
    .LINK
        Repair-DebateOutput
    .LINK
        Watch-DebateProgress
    .LINK
        Invoke-DebateBatch
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$Topic,

        [ValidateRange(1, 15)]
        [int]$Rounds = 3,

        [Alias('OutputPath')]
        [string]$OutputFile,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey,

        [ValidateSet('policymakers', 'technical_researchers', 'industry_leaders', 'academic_community', 'general_public')]
        [string]$Audience = 'policymakers',

        [string]$RepoRoot = $script:RepoRoot,

        [switch]$UseAdaptiveStaging,

        [ValidateSet('tight', 'moderate', 'thorough')]
        [string]$Pacing = 'moderate',

        [ValidateRange(5, 20)]
        [int]$MaxTotalRounds = 12,

        [switch]$AllowEarlyTermination
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Delegate to CLI engine for adaptive staging ───────────────────────────
    # Adaptive staging logic lives in lib/debate/phaseTransitions.ts — not
    # reimplemented in PS. Route through Invoke-AITDebate which calls the CLI.
    if ($UseAdaptiveStaging) {
        Write-Host 'Adaptive staging requested — delegating to Invoke-AITDebate (CLI engine)' -ForegroundColor Cyan
        $CliParams = @{
            Topic            = $Topic
            Rounds           = $MaxTotalRounds
            Model            = $Model
            AdaptiveStaging  = $true
        }
        if ($ApiKey) { $CliParams.ApiKey = $ApiKey }
        if ($OutputFile) { $CliParams.OutputDirectory = Split-Path $OutputFile -Parent }
        return Invoke-AITDebate @CliParams
    }

    # ── Step 1: Validate environment ──────────────────────────────────────────
    Write-Step 'Validating environment'

    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
        throw 'No API key configured'
    }

    # ── Step 2: Define agents ─────────────────────────────────────────────────
    $Agents = @(
        @{
            Name        = 'Accelerationist'
            Speaker     = 'Accelerationist'
            PovKey      = 'accelerationist'
            PovLabel    = 'Accelerationist'
            Description = 'You champion rapid AI development and deployment. You believe AI progress is essential for human flourishing, that open development is safer than restriction, and that the benefits vastly outweigh the risks. You distrust regulatory gatekeeping and favor empirical, results-oriented approaches.'
        }
        @{
            Name        = 'Safetyist'
            Speaker     = 'Safetyist'
            PovKey      = 'safetyist'
            PovLabel    = 'Safetyist'
            Description = 'You prioritize AI safety, alignment research, and careful risk mitigation. You believe powerful AI poses existential risks that demand precaution, that capability gains outpace safety understanding, and that deployment should wait until systems are proven safe. You favor regulation and mandatory safety testing.'
        }
        @{
            Name        = 'Skeptic'
            Speaker     = 'Skeptic'
            PovKey      = 'skeptic'
            PovLabel    = 'Skeptic'
            Description = 'You question AI hype and emphasize present-day harms. You believe current AI systems are less capable than claimed, that the real risks are economic displacement, bias, and power concentration, not sci-fi scenarios. You demand empirical evidence over speculation and focus on protecting workers and communities.'
        }
    )

    # ── Step 3: Build POV context per agent ───────────────────────────────────
    Write-Step 'Building POV context for agents'

    $TaxDir = Get-TaxonomyDir

    # Load all nodes
    $AllNodes = @{}
    foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }
        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        Set-TaxonomyDocumentSelectable -Document $FileData -Name $PovKey   # prompt only (t/4356)
        foreach ($Node in $FileData.nodes) {
            $AllNodes[$Node.id] = @{
                POV         = $PovKey
                Label       = $Node.label
                Description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
                Category    = if ($Node.PSObject.Properties['category']) { $Node.category } else { '' }
            }
        }
    }

    # Load edges
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    $AllEdges  = @()
    $NodeDegree = @{}
    if (Test-Path $EdgesPath) {
        $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json
        $AllEdges  = @($EdgesData.edges | Where-Object { $_.status -eq 'approved' })
        foreach ($Edge in $AllEdges) {
            if (-not $NodeDegree.ContainsKey($Edge.source)) { $NodeDegree[$Edge.source] = 0 }
            if (-not $NodeDegree.ContainsKey($Edge.target)) { $NodeDegree[$Edge.target] = 0 }
            $NodeDegree[$Edge.source]++
            $NodeDegree[$Edge.target]++
        }
    }

    # Build per-agent context: top 30 nodes by degree + their edges + relevant cc-nodes
    $AgentContexts = @{}
    foreach ($Agent in $Agents) {
        $PovKey = $Agent.PovKey
        $PovNodeIds = @($AllNodes.Keys | Where-Object { $AllNodes[$_].POV -eq $PovKey })

        # Sort by degree, take top 30
        $TopNodes = @($PovNodeIds |
            Sort-Object { if ($NodeDegree.ContainsKey($_)) { $NodeDegree[$_] } else { 0 } } -Descending |
            Select-Object -First 30)

        # Add relevant cc-nodes (connected to these top nodes)
        $TopNodeSet = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($NId in $TopNodes) { [void]$TopNodeSet.Add($NId) }

        $CcNodeIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($Edge in $AllEdges) {
            if ($TopNodeSet.Contains($Edge.source) -and $AllNodes.ContainsKey($Edge.target) -and $AllNodes[$Edge.target].POV -eq 'situations') {
                [void]$CcNodeIds.Add($Edge.target)
            }
            if ($TopNodeSet.Contains($Edge.target) -and $AllNodes.ContainsKey($Edge.source) -and $AllNodes[$Edge.source].POV -eq 'situations') {
                [void]$CcNodeIds.Add($Edge.source)
            }
        }

        # Build context string
        $ContextBuilder = [System.Text.StringBuilder]::new()
        [void]$ContextBuilder.AppendLine("Top $($TopNodes.Count) $PovKey nodes (by graph connectivity):")
        foreach ($NId in $TopNodes) {
            $N = $AllNodes[$NId]
            [void]$ContextBuilder.AppendLine("  - $NId [$($N.Category)]: $($N.Label) — $($N.Description)")
        }

        if ($CcNodeIds.Count -gt 0) {
            [void]$ContextBuilder.AppendLine("`nRelevant situations nodes:")
            foreach ($CcId in $CcNodeIds | Select-Object -First 10) {
                $N = $AllNodes[$CcId]
                [void]$ContextBuilder.AppendLine("  - ${CcId}: $($N.Label) — $($N.Description)")
            }
        }

        # Key edges involving these nodes
        $RelevantEdges = @($AllEdges | Where-Object {
            $TopNodeSet.Contains($_.source) -or $TopNodeSet.Contains($_.target)
        } | Select-Object -First 50)

        if ($RelevantEdges.Count -gt 0) {
            [void]$ContextBuilder.AppendLine("`nKey relationships:")
            foreach ($Edge in $RelevantEdges) {
                [void]$ContextBuilder.AppendLine("  $($Edge.source) --[$($Edge.type)]--> $($Edge.target)")
            }
        }

        # Load top 20 policies for this POV from the policy registry
        $PolicyRegistryPath = Join-Path $TaxDir 'policy_actions.json'
        if (Test-Path $PolicyRegistryPath) {
            $PolicyReg = Get-Content -Raw -Path $PolicyRegistryPath | ConvertFrom-Json
            if ($PolicyReg.policies) {
                $PovPolicies = @($PolicyReg.policies |
                    Where-Object { $_.source_povs -contains $PovKey } |
                    Sort-Object { $_.member_count } -Descending |
                    Select-Object -First 20)

                if ($PovPolicies.Count -gt 0) {
                    [void]$ContextBuilder.AppendLine("`nPOLICY CONTEXT (use these pol-NNN IDs when referencing policy actions):")
                    foreach ($Pol in $PovPolicies) {
                        [void]$ContextBuilder.AppendLine("  - $($Pol.id): $($Pol.action)")
                    }
                }
            }
        }

        $AgentContexts[$Agent.Speaker] = $ContextBuilder.ToString()
    }
    Write-OK "Built context for $($Agents.Count) agents"

    # ── Step 4: Generate debate ───────────────────────────────────────────────
    $DebateId   = [guid]::NewGuid().ToString()
    $Transcript = [System.Collections.Generic.List[PSObject]]::new()

    # Audience directives — matches lib/debate/prompts.ts AUDIENCE_DIRECTIVES
    $AudienceDirectives = @{
        policymakers = @{
            ReadingLevel = 'Write for a policy reporter or congressional staffer — someone smart and busy who needs to understand and quote you. Lead with your main claim in the first sentence. Use active voice with named actors. One idea per sentence. Prefer concrete examples and specific numbers over abstract categories.'
            DetailInstruction = 'Provide a thorough, in-depth response — 3-5 paragraphs. Include a steelman of the strongest opposing position, disclose 1-2 key assumptions your argument depends on, and frame arguments in terms of implementability, enforcement mechanisms, and political feasibility.'
            ModeratorBias = 'Steer toward actionable policy disagreements. Prefer questions about implementation feasibility, enforcement mechanisms, jurisdictional authority, and constituent impact.'
        }
        technical_researchers = @{
            ReadingLevel = 'Write for a senior ML researcher reviewing a position paper. Use precise technical vocabulary without hedging. Cite specific architectures, benchmarks, and failure modes by name. Quantify claims: parameter counts, compute budgets, error rates, confidence intervals.'
            DetailInstruction = 'Provide a rigorous, evidence-grounded response — 3-5 paragraphs. Separate empirical claims from normative positions. Identify the strongest technical counterargument and address it directly.'
            ModeratorBias = 'Steer toward empirical disputes and methodology. Probe evidence quality, reproducibility, and the validity of benchmarks or evaluations being cited.'
        }
        industry_leaders = @{
            ReadingLevel = 'Write for a technology executive making product and investment decisions. Lead with the business-relevant conclusion. Use concrete examples from deployed products, market dynamics, and competitive landscapes.'
            DetailInstruction = 'Provide a strategic, decision-oriented response — 3-5 paragraphs. Frame each argument around ROI, competitive advantage, or risk mitigation. Include at least one concrete case study or industry precedent.'
            ModeratorBias = 'Steer toward practical tradeoffs. Surface cost-benefit tensions, competitive dynamics, liability exposure, and talent considerations.'
        }
        academic_community = @{
            ReadingLevel = 'Write for a faculty seminar — scholars from multiple disciplines who value analytical rigor, theoretical grounding, and intellectual honesty. Trace arguments to their philosophical or theoretical roots. Name the scholarly traditions and key thinkers you draw on.'
            DetailInstruction = 'Provide a scholarly, well-structured response — 3-5 paragraphs. Engage with competing theoretical frameworks, not just competing conclusions. Cite intellectual lineage. Identify methodological limitations.'
            ModeratorBias = 'Steer toward conceptual precision and theoretical assumptions. Probe interdisciplinary tensions, methodological limitations, and the philosophical foundations of competing positions.'
        }
        general_public = @{
            ReadingLevel = 'Write for an informed citizen reading a quality newspaper — someone who follows the news but has no technical background. No acronyms without expansion. No jargon without a plain-English equivalent. Lead with why this matters to daily life.'
            DetailInstruction = 'Provide a clear, accessible response — 2-4 paragraphs. Use one concrete, relatable example per major claim. Avoid both fear-mongering and dismissiveness. End with what an ordinary person can actually do or watch for.'
            ModeratorBias = 'Steer toward stakes and consequences that affect ordinary people. Prefer questions about personal impact (jobs, privacy, safety), fairness, and democratic accountability.'
        }
    }
    $AudDir = $AudienceDirectives[$Audience]
    $AudienceBlock = @"
AUDIENCE: $Audience
READING LEVEL: $($AudDir.ReadingLevel)
DETAIL: $($AudDir.DetailInstruction)
"@

    # Helper: call LLM for a turn
    $InvokeTurn = {
        param([string]$AgentSpeaker, [string]$SystemPrompt, [string]$TranscriptSoFar, [string]$TurnType)

        $SchemaPrompt = Get-Prompt -Name 'triad-dialogue-schema'
        $TurnPrompt   = Get-Prompt -Name 'triad-dialogue-turn' -Replacements @{
            SYSTEM_PROMPT      = $SystemPrompt
            TOPIC              = $Topic
            AUDIENCE_DIRECTIVE = $AudienceBlock
            TRANSCRIPT         = $TranscriptSoFar
            SCHEMA             = $SchemaPrompt
        }

        $TurnResult = Invoke-AIApi `
            -Prompt     $TurnPrompt `
            -Model      $Model `
            -ApiKey     $ApiKey `
            -Temperature 0.7 `
            -MaxTokens  2048 `
            -JsonMode `
            -MaxRetries 3 `
            -RetryDelays @(5, 15, 45)

        if (-not $TurnResult -or -not $TurnResult.Text) {
            return $null
        }

        $ResponseText = $TurnResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
        try {
            return $ResponseText | ConvertFrom-Json
        }
        catch {
            Write-Warn "Failed to parse $AgentSpeaker response — attempting repair"
            try {
                $Repaired = Repair-TruncatedJson -Text $ResponseText
                return $Repaired | ConvertFrom-Json
            }
            catch {
                # t/3857: this used to fabricate a PSCustomObject carrying the raw unparsed text
                # instead of $null -- a TRUTHY value, so the call site's `if ($Response)` check
                # (which correctly treats a genuine $null from the sibling check above as failure)
                # instead added the raw/corrupted text to the debate transcript as if it were the
                # agent's real statement. Return $null, matching the sibling failure path, so the
                # existing `if ($Response) {...} else { Write-Warn "...failed..." }` call-site
                # logic -- not a new mechanism -- does its job. Write-Warning (a real stream) in
                # place of Write-Warn (Write-Host wrapper, not capturable) per the capturability axis.
                Write-Warning "Repair failed for $AgentSpeaker -- discarding unparseable response: $ResponseText"
                return $null
            }
        }
    }

    # Build system prompts per agent
    $SystemPrompts = @{}
    foreach ($Agent in $Agents) {
        $SystemPrompts[$Agent.Speaker] = Get-Prompt -Name 'triad-dialogue-system' -Replacements @{
            AGENT_NAME      = $Agent.Name
            POV_LABEL       = $Agent.PovLabel
            POV_DESCRIPTION = $Agent.Description
            POV_CONTEXT     = $AgentContexts[$Agent.Speaker]
        }
    }

    # Format transcript for prompt
    $FormatTranscript = {
        param($Trans)
        $Lines = [System.Text.StringBuilder]::new()
        foreach ($T in $Trans) {
            [void]$Lines.AppendLine("[$($T.speaker) — $($T.type)]")
            [void]$Lines.AppendLine($T.content)
            [void]$Lines.AppendLine()
        }
        return $Lines.ToString()
    }

    # Compress older rounds if transcript gets long
    $CompressTranscript = {
        param($Trans, [int]$MaxTokenEst)
        $FullText = (& $FormatTranscript $Trans)
        $EstTokens = [Math]::Round($FullText.Length / 4)
        if ($EstTokens -le $MaxTokenEst) {
            return $FullText
        }

        # Keep last 2 entries fully, summarize earlier ones
        $KeepFull = 6  # last 2 rounds × 3 agents
        if ($Trans.Count -le $KeepFull) {
            return $FullText
        }

        $Earlier = $Trans | Select-Object -First ($Trans.Count - $KeepFull)
        $Recent  = $Trans | Select-Object -Last $KeepFull

        $Summary = [System.Text.StringBuilder]::new()
        [void]$Summary.AppendLine("[Earlier discussion summary]")
        foreach ($T in $Earlier) {
            if ($T.content.Length -gt 100) { $Snippet = $T.content.Substring(0, 100) + '...' } else { $Snippet = $T.content }
            [void]$Summary.AppendLine("  $($T.speaker): $Snippet")
        }
        [void]$Summary.AppendLine()
        [void]$Summary.AppendLine("[Recent exchanges]")
        foreach ($T in $Recent) {
            [void]$Summary.AppendLine("[$($T.speaker) — $($T.type)]")
            [void]$Summary.AppendLine($T.content)
            [void]$Summary.AppendLine()
        }
        return $Summary.ToString()
    }

    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    Write-Host "  TRIAD DIALOGUE" -ForegroundColor White
    Write-Host "  Topic: $Topic" -ForegroundColor Gray
    Write-Host "  Agents: Accelerationist, Safetyist, Skeptic  |  Rounds: $Rounds" -ForegroundColor Gray
    Write-Host "$('═' * 72)" -ForegroundColor Cyan

    # ── Opening statements ────────────────────────────────────────────────────
    Write-Step 'Opening statements'

    foreach ($Agent in $Agents) {
        Write-Info "$($Agent.Name) is preparing opening statement..."
        $TranscriptText = & $FormatTranscript $Transcript
        $Response = & $InvokeTurn $Agent.Speaker $SystemPrompts[$Agent.Speaker] $TranscriptText 'opening'

        if ($Response) {
            if ($Response.PSObject.Properties['content']) { $Content = $Response.content } else { $Content = "$Response" }
            if ($Response.PSObject.Properties['taxonomy_refs']) { $TaxRefs = @($Response.taxonomy_refs) } else { $TaxRefs = @() }

            $Entry = [ordered]@{
                type          = 'opening'
                speaker       = $Agent.Speaker
                content       = $Content
                taxonomy_refs = $TaxRefs
                policy_refs   = @()
                id            = [guid]::NewGuid().ToString()
                timestamp     = (Get-Date -Format 'o')
            }
            $Transcript.Add([PSCustomObject]$Entry)

            # Display
            $NameColor = switch ($Agent.Speaker) {
                'Accelerationist' { 'Blue' }
                'Safetyist'   { 'Green' }
                'Skeptic'  { 'Yellow' }
            }
            Write-Host "`n  $($Agent.Name.ToUpper()) (Opening):" -ForegroundColor $NameColor
            Write-Host "  $Content" -ForegroundColor White
            if ($TaxRefs.Count -gt 0) {
                $RefIds = ($TaxRefs | ForEach-Object { $_.node_id }) -join ', '
                Write-Host "  Refs: $RefIds" -ForegroundColor DarkGray
            }
        }
        else {
            Write-Warn "$($Agent.Name) failed to produce an opening statement"
        }
    }

    # ── Debate rounds ─────────────────────────────────────────────────────────
    for ($Round = 1; $Round -le $Rounds; $Round++) {
        Write-Step "Round $Round of $Rounds"

        foreach ($Agent in $Agents) {
            Write-Info "$($Agent.Name) is formulating response..."
            $TranscriptText = & $CompressTranscript $Transcript 8000
            $Response = & $InvokeTurn $Agent.Speaker $SystemPrompts[$Agent.Speaker] $TranscriptText 'argument'

            if ($Response) {
                if ($Response.PSObject.Properties['content']) { $Content = $Response.content } else { $Content = "$Response" }
                if ($Response.PSObject.Properties['taxonomy_refs']) { $TaxRefs = @($Response.taxonomy_refs) } else { $TaxRefs = @() }

                $Entry = [ordered]@{
                    type          = 'statement'
                    speaker       = $Agent.Speaker
                    content       = $Content
                    taxonomy_refs = $TaxRefs
                    policy_refs   = @()
                    id            = [guid]::NewGuid().ToString()
                    timestamp     = (Get-Date -Format 'o')
                    metadata      = @{ round = $Round }
                }
                $Transcript.Add([PSCustomObject]$Entry)

                $NameColor = switch ($Agent.Speaker) {
                    'Accelerationist' { 'Blue' }
                    'Safetyist'   { 'Green' }
                    'Skeptic'  { 'Yellow' }
                }
                Write-Host "`n  $($Agent.Name.ToUpper()) (Round $Round):" -ForegroundColor $NameColor
                Write-Host "  $Content" -ForegroundColor White
                if ($TaxRefs.Count -gt 0) {
                    $RefIds = ($TaxRefs | ForEach-Object { $_.node_id }) -join ', '
                    Write-Host "  Refs: $RefIds" -ForegroundColor DarkGray
                }
            }
            else {
                Write-Warn "$($Agent.Name) failed to respond in round $Round"
            }
        }
    }

    # ── Synthesis ─────────────────────────────────────────────────────────────
    Write-Step 'Generating synthesis'

    $FullTranscriptText = & $FormatTranscript $Transcript
    $SynthesisPrompt = Get-Prompt -Name 'triad-dialogue-synthesis' -Replacements @{
        TOPIC      = $Topic
        TRANSCRIPT = $FullTranscriptText
    }

    $Synthesis = $null
    try {
        $SynthResult = Invoke-AIApi `
            -Prompt     $SynthesisPrompt `
            -Model      $Model `
            -ApiKey     $ApiKey `
            -Temperature 0.3 `
            -MaxTokens  4096 `
            -JsonMode `
            -MaxRetries 3 `
            -RetryDelays @(5, 15, 45)

        if ($SynthResult -and $SynthResult.Text) {
            $SynthText = $SynthResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
            $Synthesis = $SynthText | ConvertFrom-Json
            Write-OK 'Synthesis complete'
        }
    }
    catch {
        Write-Warn "Synthesis generation failed for topic '$Topic' using model '$Model': $($_.Exception.Message)"
        Write-Info 'The dialogue transcript was generated but synthesis could not be produced. Check your API key/quota and try running synthesis separately.'
    }

    # Display synthesis
    if ($Synthesis) {
        Write-Host "`n$('─' * 72)" -ForegroundColor Cyan
        Write-Host '  SYNTHESIS' -ForegroundColor White
        Write-Host "$('─' * 72)" -ForegroundColor Cyan

        if ($Synthesis.PSObject.Properties['summary']) {
            Write-Host "`n  $($Synthesis.summary)" -ForegroundColor White
        }

        if ($Synthesis.PSObject.Properties['areas_of_agreement'] -and $Synthesis.areas_of_agreement) {
            Write-Host "`n  Areas of Agreement:" -ForegroundColor Green
            foreach ($A in @($Synthesis.areas_of_agreement)) {
                Write-Host "    - $A" -ForegroundColor Gray
            }
        }

        if ($Synthesis.PSObject.Properties['areas_of_disagreement'] -and $Synthesis.areas_of_disagreement) {
            Write-Host "`n  Areas of Disagreement:" -ForegroundColor Red
            foreach ($D in @($Synthesis.areas_of_disagreement)) {
                Write-Host "    - $D" -ForegroundColor Gray
            }
        }

        if ($Synthesis.PSObject.Properties['unresolved_questions'] -and $Synthesis.unresolved_questions) {
            Write-Host "`n  Unresolved Questions:" -ForegroundColor Yellow
            foreach ($Q in @($Synthesis.unresolved_questions)) {
                Write-Host "    - $Q" -ForegroundColor Gray
            }
        }
    }

    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan

    # ── Build debate JSON (compatible with taxonomy-editor DebateTab) ─────────
    $DebateData = [ordered]@{
        id              = $DebateId
        title           = $Topic
        created_at      = (Get-Date -Format 'o')
        updated_at      = (Get-Date -Format 'o')
        phase           = 'complete'
        topic           = [ordered]@{
            original = $Topic
            refined  = $Topic
            final    = $Topic
        }
        active_povers   = @('Accelerationist', 'Safetyist', 'Skeptic')
        user_is_pover   = $false
        transcript      = @($Transcript)
        rounds          = $Rounds
        source          = 'Show-TriadDialogue'
    }

    if ($Synthesis) {
        $DebateData['synthesis'] = $Synthesis
    }

    # Write to file
    if ($OutputFile) { $TargetFile = $OutputFile }
    else {
        $DebatesDir = Get-DebatesDir
        if (-not (Test-Path $DebatesDir)) {
            $null = New-Item -ItemType Directory -Path $DebatesDir -Force
        }
        $TargetFile = Join-Path $DebatesDir "debate-$DebateId.json"
    }

    try {
        $Json = $DebateData | ConvertTo-Json -Depth 20
        Write-Utf8NoBom -Path $TargetFile -Value $Json 
        Write-OK "Debate saved to: $TargetFile"
    }
    catch {
        Write-Warn "Failed to save debate to '$TargetFile': $($_.Exception.Message)"
        Write-Info 'The debate completed but could not be persisted. Check file permissions and disk space, then re-run with -SaveTo to retry.'
    }

    return $DebateData
}
