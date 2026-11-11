# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# The steps of New-OpEd, extracted for t/3910 (cyclomatic complexity under 20). Pure refactor: every
# message, prompt replacement, AI-call argument and output field is unchanged, so errors keep
# Location 'New-OpEd' (the cmdlet the caller ran). Pinned by tests/New-OpEd.Characterization.Tests.ps1.
# Strict mode is inherited from New-OpEd's scope.

function Read-OpEdSoul {
    # The camp's Soul document (lives in the code repo, not the data repo).
    # $script:ModuleRoot is scripts/AITriad; soul docs live at
    # <repo-root>/lib/debate/soul-docs/<pov>.soul.json.
    param([Parameter(Mandatory)][string]$PovKey)
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $script:ModuleRoot)
    $SoulPath = Join-Path $RepoRoot (Join-Path 'lib/debate/soul-docs' "$PovKey.soul.json")
    if (-not (Test-Path $SoulPath)) {
        throw (New-ActionableError -PassThru `
            -Goal 'Generate an op-ed in a POV voice' `
            -Problem "Soul document not found for POV '$PovKey': $SoulPath" `
            -Location 'New-OpEd' `
            -NextSteps @(
                "Confirm lib/debate/soul-docs/$PovKey.soul.json exists in the repo",
                'Run from a full checkout; Soul documents ship with the code repo, not the data repo'
            ))
    }
    try {
        return (Get-Content -Path $SoulPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        throw (New-ActionableError -PassThru `
            -Goal 'Generate an op-ed in a POV voice' `
            -Problem "Soul document at $SoulPath is not valid JSON: $($_.Exception.Message)" `
            -Location 'New-OpEd' `
            -NextSteps 'Validate the Soul document JSON and retry.')
    }
}

function Get-OpEdVoiceBlock {
    # The voice block built from the Soul document.
    param([Parameter(Mandatory)]$Soul)
    $v = $Soul.voice
    $VoiceLines = [System.Collections.Generic.List[string]]::new()
    $VoiceLines.Add("PERSONALITY: $($Soul.personality)")
    $VoiceLines.Add("DISPOSITION: $($v.disposition)")
    $VoiceLines.Add("RHETORICAL STYLE: $($v.style)")
    $VoiceLines.Add("REASONING MODE: $($v.reasoning)")
    $VoiceLines.Add("PREFERRED EVIDENCE: $($v.evidence)")
    $VoiceLines.Add("SIGNATURE MOVE: $($v.signature)")
    $VoiceLines.Add('')
    $VoiceLines.Add([string]$v.prose_style)
    $VoiceLines.Add('')
    $VoiceLines.Add([string]$v.voice_hygiene)
    $VoiceLines.Add('')
    $VoiceLines.Add('VALUE HIERARCHY (in priority order):')
    $rank = 1
    foreach ($val in @($Soul.value_hierarchy)) { $VoiceLines.Add("  $rank. $val"); $rank++ }
    $VoiceLines.Add('')
    $VoiceLines.Add('EPISTEMIC STANCE:')
    foreach ($e in @($Soul.epistemic_stance)) { $VoiceLines.Add("  - $e") }
    $VoiceLines.Add('')
    $VoiceLines.Add('ANTI-PATTERNS (never do these):')
    foreach ($a in @($Soul.anti_patterns)) { $VoiceLines.Add("  - $a") }
    $VoiceLines -join "`n"
}

function Resolve-OpEdOutlet {
    # The outlet entry and target word count, read from the lib/oped/outlets.json SSOT (t/3863).
    # Get-OpEdOutletsData throws (fail-closed) on a missing/malformed SSOT; the ValidateSet generator
    # already refused an invalid -Outlet at binding, but this is a second, independent read (no caching
    # either layer, t/3863#1), so guard the key too.
    param([Parameter(Mandatory)][string]$Outlet, [int]$WordCount, [switch]$HasWordCount)
    $OutletsData = Get-OpEdOutletsData
    if (-not $OutletsData.outlets.PSObject.Properties[$Outlet]) {
        throw (New-ActionableError -PassThru `
                -Goal 'Generate an op-ed in a POV voice' `
                -Problem "Outlet '$Outlet' passed binding but is no longer present in outlets.json — the SSOT changed between binding and this read." `
                -Location 'New-OpEd' `
                -NextSteps 'Re-run the command.')
    }
    $OutletEntry = $OutletsData.outlets.$Outlet
    $TargetWords = if ($HasWordCount) { $WordCount } else { $OutletEntry.words }
    [pscustomobject]@{ Data = $OutletsData; Entry = $OutletEntry; TargetWords = $TargetWords }
}

function Resolve-OpEdSourcePrep {
    # -Url builds a SourcePrep internally (single-voice path); -SourcePrep accepts one from the
    # ElectronMain orchestrator (3-POV path). Both then follow the identical draft path.
    param([string]$ParameterSetName, $SourcePrep, [string]$Url)
    if ($ParameterSetName -eq 'FromPrep') { return $SourcePrep }
    if ($ParameterSetName -ne 'FromUrl') { return $null }
    Write-Verbose "Fetching + converting source material from $Url"
    # Get-OpEdSource is convert-only (t/3307); the CLI's best-effort fetch lives in the localized
    # Private helper Get-OpEdSourceFromUrl (WAF-limited interim, migrates to the shared Node
    # fetch-CLI under t/3312 — one entry point for the migration + any WAF-fetch prevention guard).
    return (Get-OpEdSourceFromUrl -Url $Url -Verbose:($VerbosePreference -ne 'SilentlyContinue'))
}

function Get-OpEdSourceContext {
    # The source material for the prompt, and the topic (derived from the source when none was given).
    param($Prep, [string]$Topic, [switch]$TopicBound)
    $SourceMaterial = '(no external source supplied — argue from the topic and general knowledge)'
    if ($null -ne $Prep) {
        $SourceMaterial = [string]$Prep.SourceMarkdown
        if (-not $TopicBound -or [string]::IsNullOrWhiteSpace($Topic)) {
            $Topic = "Write an op-ed responding to the source material below (from $($Prep.SourceUrl)). Choose the sharpest angle consistent with your camp's convictions."
        }
    }
    [pscustomobject]@{ SourceMaterial = $SourceMaterial; Topic = $Topic }
}

function Get-OpEdGrounding {
    # Retrieve the POV's most topic-relevant BDI nodes (its actual beliefs / desires / intentions) and
    # situation-library stress cases via the same embedding relevance the debate engine uses, and
    # inject them as the substance the essay must argue from. This is what makes the op-ed reflect
    # THIS project's taxonomy rather than the model's generic priors. Grounded by default; -VoiceOnly
    # (or zeroed counts) skips it. Retrieval failure (data repo / embeddings.json / Python unavailable)
    # degrades to voice-only with a warning rather than failing the whole generation.
    param(
        [string]$PovKey, [string]$Topic, [string]$NewsHook, [string]$Thesis, [string]$SourceMaterial,
        [string]$ParameterSetName, [int]$MaxGroundingNodes, [int]$MaxSituations, [switch]$VoiceOnly
    )
    $Grounding = [System.Collections.Generic.List[PSObject]]::new()
    $Result = [pscustomobject]@{
        Grounding      = $Grounding
        NodesText      = '(none — argue from your camp voice and general knowledge)'
        SituationsText = '(none supplied)'
    }
    if ($VoiceOnly -or ($MaxGroundingNodes -le 0 -and $MaxSituations -le 0)) { return $Result }

    # Query = the topic signal, plus the hook/thesis and a slice of any source.
    # @() keeps a single surviving part an array, so += appends and -join applies (t/4069).
    $QueryParts = @(@($Topic, $NewsHook, $Thesis) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($ParameterSetName -eq 'FromUrl' -and $SourceMaterial.Length -gt 0) {
        $QueryParts += $SourceMaterial.Substring(0, [Math]::Min(1500, $SourceMaterial.Length))
    }
    $RetrievalQuery = $QueryParts -join '. '

    try {
        $WantSituations = $MaxSituations -gt 0
        $PovArg = if ($WantSituations) { @($PovKey, 'situations') } else { @($PovKey) }
        $Relevant = Get-RelevantTaxonomyNodes -Query $RetrievalQuery -POV $PovArg `
            -IncludeSituations:$WantSituations -MaxTotal 50 -MinPerCategory 2

        $BdiNodes = @($Relevant | Where-Object { $_.POV -eq $PovKey } |
            Sort-Object Score -Descending | Select-Object -First $MaxGroundingNodes)
        $SitNodes = @($Relevant | Where-Object { $_.POV -eq 'situations' } |
            Sort-Object Score -Descending | Select-Object -First $MaxSituations)

        if (@($BdiNodes).Count -gt 0) { $Result.NodesText = Format-OpEdBdiGrounding -Nodes $BdiNodes -Grounding $Grounding }
        if (@($SitNodes).Count -gt 0) { $Result.SituationsText = Format-OpEdSituationGrounding -Nodes $SitNodes -Grounding $Grounding }

        Write-Verbose "Grounding: $(@($BdiNodes).Count) BDI nodes + $(@($SitNodes).Count) situations retrieved"
    } catch {
        Write-Warning "Taxonomy grounding unavailable — writing voice-only. ($($_.Exception.Message))"
    }
    $Result
}

function Format-OpEdBdiGrounding {
    # Prompt lines for the BDI nodes; adds each node to $Grounding.
    param([object[]]$Nodes, [System.Collections.Generic.List[PSObject]]$Grounding)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($n in $Nodes) {
        # t/3834: mirror lib/oped/generate.ts's parseNodeScope/formatGroundingNodes
        # (PR #2649) exactly -- split Encompasses:/Excludes: out of the description
        # BEFORE capping, so the scope carve-outs that reconcile a camp's positions
        # survive truncation instead of being severed mid-description.
        $scope = Get-GroundingNodeScope -Description ([string]$n.Description)

        $cappedCore = $scope.Core
        if ($cappedCore.Length -gt 240) { $cappedCore = $cappedCore.Substring(0, 240) + '…' }

        # Prefix the node id so the model can reference it back in grounding_usage.
        [void]$sb.AppendLine("- [$($n.Id)] [$($n.Category)] $($n.Label): $cappedCore")
        if ($scope.Encompasses) { [void]$sb.AppendLine("    • Applies to: $($scope.Encompasses)") }
        if ($scope.Excludes)    { [void]$sb.AppendLine("    • Does NOT extend to: $($scope.Excludes)") }
        $Grounding.Add([PSCustomObject]@{
            Id = $n.Id; Type = 'bdi'; POV = $n.POV; Category = $n.Category
            Label = $n.Label; RelevanceScore = $n.Score; Reflection = ''
        })
    }
    # AppendLine writes the platform newline; prompts are LF on every OS, as in lib/oped/generate.ts (t/4081).
    $sb.ToString().Replace("`r`n", "`n").TrimEnd()
}

function Format-OpEdSituationGrounding {
    # Prompt lines for the situation nodes; adds each node to $Grounding.
    param([object[]]$Nodes, [System.Collections.Generic.List[PSObject]]$Grounding)
    $sb2 = [System.Text.StringBuilder]::new()
    foreach ($s in $Nodes) {
        $desc = [string]$s.Description
        if ($desc.Length -gt 300) { $desc = $desc.Substring(0, 300) + '…' }
        [void]$sb2.AppendLine("- [$($s.Id)] $($s.Label): $desc")
        $Grounding.Add([PSCustomObject]@{
            Id = $s.Id; Type = 'situation'; POV = $s.POV; Category = 'Situation'
            Label = $s.Label; RelevanceScore = $s.Score; Reflection = ''
        })
    }
    $sb2.ToString().Replace("`r`n", "`n").TrimEnd()
}

function Get-OpEdSourceBrief {
    # Source comprehension pass (best-effort). Populates SOURCE_* prompt placeholders from the CL-owned
    # op-ed-source-brief prompt. If the orchestrator pre-populated SourceBrief on the prep object, use
    # it directly (saves a second AI call). If the prompt file is not yet deployed (CL lands it
    # separately), silently degrades — SOURCE_* will be empty strings, which the prompt treats as
    # "(not supplied)".
    param($Prep, [string]$Model, [string]$PromptsDir)
    if ($null -eq $Prep -or [string]::IsNullOrWhiteSpace($Prep.SourceMarkdown)) { return $null }
    if ($Prep.PSObject.Properties.Name -contains 'SourceBrief' -and $null -ne $Prep.SourceBrief) { return $Prep.SourceBrief }
    $SBrief = $null
    try {
        $BriefSchema = @{
            type       = 'object'
            properties = @{
                author                  = @{ type = 'string' }
                actor_type              = @{ type = 'string' }
                thesis                  = @{ type = 'string' }
                stance                  = @{ type = 'string' }
                primary_recommendations = @{ type = 'array'; items = @{ type = 'string' } }
                key_claims              = @{ type = 'array'; items = @{ type = 'string' } }
                readable                = @{ type = 'string' }
            }
            required   = @('thesis', 'readable')
        }
        $BriefPrompt = Get-Prompt -Name 'op-ed-source-brief' -PromptsDir $PromptsDir -Replacements @{
            SOURCE_MATERIAL = [string]$Prep.SourceMarkdown
        }
        $BriefResult = Invoke-AIApi -Prompt $BriefPrompt -Model $Model -Temperature 0.2 `
            -MaxTokens 4000 -JsonMode -ResponseSchema $BriefSchema
        if ($null -ne $BriefResult -and -not [string]::IsNullOrWhiteSpace($BriefResult.Text)) {
            $SBrief = $BriefResult.Text | ConvertFrom-Json
            # A hand-built prep may lack the property; assigning it would throw under StrictMode (t/4069).
            $Prep | Add-Member -NotePropertyName 'SourceBrief' -NotePropertyValue $SBrief -Force
        }
    } catch {
        Write-Warning "Source comprehension pass skipped — SOURCE_* placeholders will be empty. ($($_.Exception.Message))"
    }
    return $SBrief
}

function Test-OpEdBriefHas {
    param($SBrief, [string]$Name)
    $null -ne $SBrief -and $SBrief.PSObject.Properties.Name -contains $Name
}

function Format-OpEdKeyClaimList {
    # Mirror promptLoader.ts SOURCE_KEY_CLAIMS: numbered list "  {i+1}. {claim}" joined by LF, falling
    # back to $Empty when absent (t/2721 parity). Also the reflection pass's SOURCE_CLAIMS (t/2911).
    param($SBrief, [string]$Empty)
    if ((Test-OpEdBriefHas $SBrief 'key_claims') -and $null -ne $SBrief.key_claims -and @($SBrief.key_claims).Count -gt 0) {
        $Claims = @($SBrief.key_claims)
        return ((0..($Claims.Count - 1) | ForEach-Object { "  $($_ + 1). $($Claims[$_])" }) -join "`n")
    }
    $Empty
}

function Get-OpEdBriefPromptValue {
    # The SOURCE_* user-prompt replacements from the source brief ('' when absent).
    param($SBrief)
    $Values = @{}
    $Fields = [ordered]@{ SOURCE_AUTHOR = 'author'; SOURCE_ACTOR_TYPE = 'actor_type'; SOURCE_THESIS = 'thesis'; SOURCE_STANCE = 'stance' }
    foreach ($Key in $Fields.Keys) {
        $Values[$Key] = if (Test-OpEdBriefHas $SBrief $Fields[$Key]) { [string]$SBrief.($Fields[$Key]) } else { '' }
    }
    $Values.SOURCE_RECOMMENDATIONS = if (Test-OpEdBriefHas $SBrief 'primary_recommendations') {
        (@($SBrief.primary_recommendations) -join '; ')
    } else { '' }
    $Values.SOURCE_KEY_CLAIMS = Format-OpEdKeyClaimList -SBrief $SBrief -Empty '(none extracted)'
    $Values
}

function Get-OpEdPromptPair {
    # The system and user prompts for the draft call.
    param(
        $Soul, [string]$VoiceBlock, $OutletInfo, [string]$Topic, [string]$NewsHook, [string]$Thesis,
        [string]$AuthorBio, [string]$SourceMaterial, $Grounding, $SBrief, [string]$PromptsDir
    )
    $NewsHookText = if ([string]::IsNullOrWhiteSpace($NewsHook)) {
        '(none supplied — invent a plausible current news hook and make clear in the lede what timely event it assumes, so the author can verify it against real events before submitting)'
    } else { $NewsHook }

    $ThesisText = if ([string]::IsNullOrWhiteSpace($Thesis)) {
        '(none supplied — derive a clear, arguable thesis that follows from your camp value hierarchy)'
    } else { $Thesis }

    $AuthorBioText = if ([string]::IsNullOrWhiteSpace($AuthorBio)) {
        '(none supplied — write a generic authority line the author can replace, e.g. "[Author], [affiliation]")'
    } else { $AuthorBio }

    # Per-outlet style vars from the SSOT (t/3863). $OutletsData.styleDefaults is the SSOT's explicit
    # third table (t/3819#3 Condition 1), applied to the outlets that carry no per-outlet `style` block.
    $OutletEntry = $OutletInfo.Entry
    $StyleSource = if ($OutletEntry.PSObject.Properties['style']) { $OutletEntry.style } else { $OutletInfo.Data.styleDefaults }

    $System = Get-Prompt -Name 'op-ed-generation-system' -PromptsDir $PromptsDir -Replacements @{
        POV_LABEL           = $Soul.label
        VOICE_BLOCK         = $VoiceBlock
        WORD_COUNT          = "$($OutletInfo.TargetWords)"
        OUTLET_GUIDANCE     = $OutletEntry.guidance
        STYLE_AUDIENCE      = $StyleSource.audience
        STYLE_READING_LEVEL = $StyleSource.readingLevel
        STYLE_SENTENCE      = $StyleSource.sentenceMechanics
        STYLE_PARAGRAPH     = $StyleSource.paragraphMechanics
        STYLE_JARGON        = $StyleSource.jargonGuidance
    }
    $UserValues = Get-OpEdBriefPromptValue -SBrief $SBrief
    $UserValues.TOPIC             = $Topic
    $UserValues.WORD_COUNT        = "$($OutletInfo.TargetWords)"
    $UserValues.OUTLET_GUIDANCE   = $OutletEntry.guidance
    $UserValues.NEWS_HOOK         = $NewsHookText
    $UserValues.THESIS            = $ThesisText
    $UserValues.AUTHOR_BIO        = $AuthorBioText
    $UserValues.SOURCE_MATERIAL   = $SourceMaterial
    $UserValues.GROUNDING_NODES   = $Grounding.NodesText
    $UserValues.SITUATIONS        = $Grounding.SituationsText
    $UserValues.STYLE_BODY_FORMAT = $StyleSource.bodyFormat
    $User = Get-Prompt -Name 'op-ed-generation-user' -PromptsDir $PromptsDir -Replacements $UserValues
    [pscustomobject]@{ System = $System; User = $User }
}

function Invoke-OpEdDraft {
    # The essay call, with structured output for clean field extraction. Throws when the backend
    # returns no text.
    param([string]$UserPrompt, [string]$SystemPrompt, [string]$Model, [double]$Temperature, [int]$MaxTokens)
    $Schema = @{
        type       = 'object'
        properties = @{
            headline      = @{ type = 'string' }
            subtitle      = @{ type = 'string' }
            body_markdown = @{ type = 'string' }
            word_count    = @{ type = 'integer' }
            stance        = @{ type = 'string'; description = 'How the camp engages the source: agree/extend/rebut (or empty if no source)' }
        }
        required   = @('headline', 'body_markdown', 'word_count')
    }
    $Result = Invoke-AIApi `
        -Prompt $UserPrompt `
        -SystemInstruction $SystemPrompt `
        -Model $Model `
        -Temperature $Temperature `
        -MaxTokens $MaxTokens `
        -JsonMode `
        -ResponseSchema $Schema

    if ($null -eq $Result -or [string]::IsNullOrWhiteSpace($Result.Text)) {
        throw (New-ActionableError -PassThru `
            -Goal 'Generate an op-ed in a POV voice' `
            -Problem 'The AI backend returned no text.' `
            -Location 'New-OpEd' `
            -NextSteps @(
                'Confirm an API key is registered for the selected model backend',
                'Retry, or try a different -Model'
            ))
    }
    $Result
}

function ConvertFrom-OpEdDraftResponse {
    # Parse the structured response, degrading gracefully to raw text.
    param([string]$Text)
    $Draft = [pscustomobject]@{ Headline = ''; Subtitle = ''; Body = ''; StanceRelationship = ''; ReportedWords = 0 }
    try {
        $Parsed = $Text | ConvertFrom-Json
        $Draft.Headline = [string]$Parsed.headline
        if ($Parsed.PSObject.Properties.Name -contains 'subtitle')    { $Draft.Subtitle = [string]$Parsed.subtitle }
        $Draft.Body = [string]$Parsed.body_markdown
        if ($Parsed.PSObject.Properties.Name -contains 'word_count')  { $Draft.ReportedWords = [int]$Parsed.word_count }
        if ($Parsed.PSObject.Properties.Name -contains 'stance')      { $Draft.StanceRelationship = [string]$Parsed.stance }
    } catch {
        Write-Warning "Response was not valid JSON; returning raw text as the body. ($($_.Exception.Message))"
        $Draft.Body = $Text
    }
    $Draft
}

function Get-OpEdReadabilityLimit {
    # Outlet-aware readability targets read from the SSOT (t/3863); styleDefaults.readability
    # (t/3819#3 Condition 1) applies to outlets without a per-outlet readability block.
    param($OutletInfo)
    $ReadTarget = if ($OutletInfo.Entry.PSObject.Properties['readability']) { $OutletInfo.Entry.readability } else { $OutletInfo.Data.styleDefaults.readability }
    [pscustomobject]@{ FkMax = [double]$ReadTarget.fkMax; SentWords = [int]$ReadTarget.maxSentWords; ParaWords = [int]$ReadTarget.maxParaWords }
}

function Get-OpEdEditStyle {
    # The house-style strings the readability-edit prompt quotes (t/202): the outlet's own `style`
    # field, else styleDefaults, field by field, the same as lib/oped assembleReadabilityEditPrompt.
    param($OutletInfo)
    $Own = if ($OutletInfo.Entry.PSObject.Properties['style']) { $OutletInfo.Entry.style } else { $null }
    $Defaults = $OutletInfo.Data.styleDefaults
    $Pick = {
        param([string]$Field)
        $Value = if ($Own -and $Own.PSObject.Properties[$Field]) { [string]$Own.$Field } else { '' }
        if ([string]::IsNullOrWhiteSpace($Value) -and $Defaults.PSObject.Properties[$Field]) { $Value = [string]$Defaults.$Field }
        if ([string]::IsNullOrWhiteSpace($Value)) {
            throw (New-ActionableError -PassThru `
                -Goal 'Build the op-ed readability-edit prompt' `
                -Problem "outlets.json has no '$Field' for this outlet or in styleDefaults." `
                -Location 'Get-OpEdEditStyle' `
                -NextSteps "Add styleDefaults.$Field to lib/oped/outlets.json.")
        }
        $Value
    }
    [pscustomobject]@{
        Sentence  = & $Pick 'sentenceMechanics'
        Paragraph = & $Pick 'paragraphMechanics'
        Jargon    = & $Pick 'jargonGuidance'
    }
}

function Get-OpEdSyllableCount {
    param([string]$Word)
    $c = $Word.ToLower() -replace '[^a-z]', ''
    if (-not $c) { return 0 }
    $g = ([regex]::Matches($c, '[aeiouy]+')).Count
    if ($c.EndsWith('e') -and $g -gt 1) { $g-- }
    [Math]::Max(1, $g)
}

function Measure-OpEdReadability {
    # Readability: FK grade, max-sentence words, max-paragraph words.
    param([string]$Text)
    $words = [regex]::Matches($Text, "\b[a-zA-Z'-]+\b")
    $sents = @($Text -split '[.!?]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '[a-zA-Z]' })
    $paras = @($Text -split '\n\n+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '[a-zA-Z]' })
    $fk    = if ($words.Count -gt 0 -and @($sents).Count -gt 0) {
        $syl = ($words | ForEach-Object { Get-OpEdSyllableCount $_.Value } | Measure-Object -Sum).Sum
        0.39 * ($words.Count / @($sents).Count) + 11.8 * ($syl / $words.Count) - 15.59
    } else { 0.0 }
    $maxSW = if (@($sents).Count -gt 0) { ($sents | ForEach-Object { ([regex]::Matches($_, '\b\S+\b')).Count } | Measure-Object -Maximum).Maximum } else { 0 }
    $maxPW = if (@($paras).Count -gt 0) { ($paras | ForEach-Object { ([regex]::Matches($_, '\b\S+\b')).Count } | Measure-Object -Maximum).Maximum } else { 0 }
    [PSCustomObject]@{ FkGrade = $fk; MaxSentWords = $maxSW; MaxParaWords = $maxPW }
}

function Get-OpEdReadabilityViolation {
    # The violation lines handed to the edit prompt.
    param($Checks, $Limits)
    $ViolParts = [System.Collections.Generic.List[string]]::new()
    if ($Checks.FkGrade     -gt $Limits.FkMax)     { [void]$ViolParts.Add("Flesch-Kincaid grade: $([Math]::Round($Checks.FkGrade,1)) (target: no higher than $($Limits.FkMax))") }
    if ($Checks.MaxParaWords -gt $Limits.ParaWords) { [void]$ViolParts.Add("Longest paragraph: $($Checks.MaxParaWords) words (target: at most ~$($Limits.ParaWords) words)") }
    if ($Checks.MaxSentWords  -gt $Limits.SentWords) { [void]$ViolParts.Add("Longest sentence: $($Checks.MaxSentWords) words (target: no sentence over $($Limits.SentWords) words)") }
    $ViolParts -join "`n"
}

function Get-OpEdFailedCheck {
    # The checks an edited body still fails, as "name=value" strings.
    param($Checks, $Limits)
    if ($Checks.FkGrade     -gt $Limits.FkMax)     { "fk_grade=$([Math]::Round($Checks.FkGrade,1))" }
    if ($Checks.MaxParaWords -gt $Limits.ParaWords) { "max_para_words=$($Checks.MaxParaWords)" }
    if ($Checks.MaxSentWords  -gt $Limits.SentWords) { "max_sent_words=$($Checks.MaxSentWords)" }
}

function Get-OpEdIntroducedTell {
    # Banned AI tells the candidate introduced (present in it, absent from the original).
    param([string]$BodyLower, [string]$Candidate)
    $BannedTells = @('in conclusion','furthermore','moreover','ultimately',
        'it is important to note','mitigate','robust','leverage','utilize','ensure')
    $CandidateLower = $Candidate.ToLower()
    @($BannedTells | Where-Object { $BodyLower -notlike "*$_*" -and $CandidateLower -like "*$_*" })
}

function Get-OpEdRevertedMeta {
    param($Checks, [string]$Reason)
    [PSCustomObject]@{ edited = $false; fk_before = $Checks.FkGrade; fk_after = $Checks.FkGrade; checks_failed_after = @(); reverted_reason = $Reason }
}

function Get-OpEdEditPrompt {
    # The readability-edit prompt, with its rules filled from the SAME targets that triggered the edit
    # and built its violations line (t/202; lib/oped assembleReadabilityEditPrompt is the TS twin).
    # Numbers render culture-invariant, as JS String(n) does: 16, 10.5, never "16,0".
    param($Ctx)
    $Inv = [cultureinfo]::InvariantCulture
    Get-Prompt -Name 'op-ed-readability-edit' -PromptsDir $Ctx.PromptsDir -Replacements @{
        BODY            = $Ctx.Body
        VIOLATIONS      = $Ctx.Violations
        FK_MAX          = ([double]$Ctx.Limits.FkMax).ToString($Inv)
        MAX_SENT_WORDS  = ([int]$Ctx.Limits.SentWords).ToString($Inv)
        MAX_PARA_WORDS  = ([int]$Ctx.Limits.ParaWords).ToString($Inv)
        STYLE_SENTENCE  = $Ctx.Style.Sentence
        STYLE_PARAGRAPH = $Ctx.Style.Paragraph
        STYLE_JARGON    = $Ctx.Style.Jargon
    }
}

function Invoke-OpEdEditAttempt {
    # One readability-edit call. Returns the candidate body, or $null when the reply is empty or
    # collapses below 60% of the original word count.
    param($Ctx, [double]$Temperature)
    $EditSchema = @{
        type = 'object'
        properties = @{
            body_markdown = @{ type = 'string' }
            changed       = @{ type = 'boolean' }
            edit_notes    = @{ type = 'string' }
        }
        required = @('body_markdown', 'changed', 'edit_notes')
    }
    $EP = Get-OpEdEditPrompt -Ctx $Ctx
    $ER = Invoke-AIApi -Prompt $EP -Model $Ctx.Model -Temperature $Temperature `
        -MaxTokens $Ctx.MaxTokens -JsonMode -ResponseSchema $EditSchema
    if (-not $ER -or [string]::IsNullOrWhiteSpace($ER.Text)) { return $null }
    $Ep = $ER.Text | ConvertFrom-Json
    $Cand = [string]$Ep.body_markdown
    if (-not $Cand.Trim()) { return $null }
    $CW = @($Cand -split '\s+' | Where-Object { $_ -ne '' }).Count
    if ($CW -lt ($Ctx.OrigWordCount * 0.6)) { return $null }  # collapse guard
    return $Cand
}

function Get-OpEdRetryCandidate {
    # The first candidate raised the FK grade: try once more, and keep the retry only when it adds no
    # banned tells and is no worse than the first.
    param($Ctx, [string]$First, $FirstChecks)
    try {
        $RetryCand = Invoke-OpEdEditAttempt -Ctx $Ctx -Temperature 0.2
        if ($null -ne $RetryCand) {
            $RetryTells  = @(Get-OpEdIntroducedTell -BodyLower $Ctx.BodyLower -Candidate $RetryCand)
            $RetryChecks = Measure-OpEdReadability -Text $RetryCand
            if ($RetryTells.Count -eq 0 -and $RetryChecks.FkGrade -le $FirstChecks.FkGrade) {
                return $RetryCand
            }
        }
    } catch { <# retry failed — keep first attempt #> }
    return $First
}

function Split-OpEdLongParagraph {
    # Deterministic para-split backstop (t/3710): split any paragraph over the word cap at sentence
    # boundaries.
    param([string]$Text, [int]$MaxParaWords)
    $SplitResult = ($Text -split '\n\n+') | ForEach-Object {
        $Para = $_
        if (([regex]::Matches($Para, '\b\S+\b')).Count -le $MaxParaWords) {
            $Para
        } else {
            $Sents  = @($Para -split '(?<=[.!?])\s+' | Where-Object { $_.Trim() })
            $Chunks = [System.Collections.Generic.List[string]]::new()
            $Chunk  = ''; $CW2 = 0
            foreach ($S in $Sents) {
                $SW2 = ([regex]::Matches($S, '\b\S+\b')).Count
                if ($Chunk -and ($CW2 + $SW2) -gt $MaxParaWords) {
                    $Chunks.Add($Chunk.Trim()); $Chunk = $S; $CW2 = $SW2
                } else {
                    $Chunk = if ($Chunk) { "$Chunk $S" } else { $S }; $CW2 += $SW2
                }
            }
            if ($Chunk.Trim()) { $Chunks.Add($Chunk.Trim()) }
            if ($Chunks.Count -gt 0) { $Chunks } else { $Para }
        }
    }
    $SplitResult -join "`n`n"
}

function Invoke-OpEdEditSelection {
    # The edit attempt and its guards. Mutates $State (FinalBody, EditingMeta) at the same points the
    # original inline code assigned them, so a throw part-way leaves the same partial state.
    param($State, $Ctx, $Checks, $Limits)
    $FirstCand = Invoke-OpEdEditAttempt -Ctx $Ctx -Temperature 0.3
    if ($null -eq $FirstCand) {
        Write-Warning 'Op-ed edit pass discarded (word-count collapse) — using original body'
        $State.EditingMeta = Get-OpEdRevertedMeta -Checks $Checks -Reason 'word-count-collapse'
        return
    }
    $IntrTells = @(Get-OpEdIntroducedTell -BodyLower $Ctx.BodyLower -Candidate $FirstCand)
    if ($IntrTells.Count -gt 0) {
        Write-Warning "Op-ed edit pass introduced banned tells [$($IntrTells -join ', ')] — reverting"
        $State.EditingMeta = Get-OpEdRevertedMeta -Checks $Checks -Reason "introduced-banned-tells: $($IntrTells -join ', ')"
        return
    }

    $ChosenBody  = $FirstCand
    $FirstChecks = Measure-OpEdReadability -Text $FirstCand
    if ($FirstChecks.FkGrade -gt $Checks.FkGrade) {
        $ChosenBody = Get-OpEdRetryCandidate -Ctx $Ctx -First $FirstCand -FirstChecks $FirstChecks
    }

    $State.FinalBody = $ChosenBody
    $AfterChecks  = Measure-OpEdReadability -Text $ChosenBody
    $FailedChecks = [string[]]@(Get-OpEdFailedCheck -Checks $AfterChecks -Limits $Limits)

    if ($AfterChecks.MaxParaWords -gt $Limits.ParaWords) {
        $State.FinalBody = Split-OpEdLongParagraph -Text $State.FinalBody -MaxParaWords $Limits.ParaWords
        $AfterChecks  = Measure-OpEdReadability -Text $State.FinalBody
        $FailedChecks = [string[]]@(Get-OpEdFailedCheck -Checks $AfterChecks -Limits $Limits)
    }

    if ($FailedChecks.Count -gt 0) {
        Write-Warning "Op-ed edit pass still misses target: $($FailedChecks -join ', ') (FK before=$([Math]::Round($Checks.FkGrade,1)) after=$([Math]::Round($AfterChecks.FkGrade,1)))"
    }
    $State.EditingMeta = [PSCustomObject]@{
        edited              = $true
        fk_before           = [Math]::Round($Checks.FkGrade, 2)
        fk_after            = [Math]::Round($AfterChecks.FkGrade, 2)
        checks_failed_after = $FailedChecks
    }
}

function Invoke-OpEdReadabilityEdit {
    # Readability edit pass. Returns { FinalBody; EditingMeta } ($null EditingMeta when no edit ran).
    param([string]$Body, $Limits, $Style, [string]$Model, [int]$MaxTokens, [string]$PromptsDir)
    $State = [pscustomobject]@{ FinalBody = $Body; EditingMeta = $null }
    if ([string]::IsNullOrWhiteSpace($Body)) { return $State }

    $Checks = Measure-OpEdReadability -Text $Body
    if (-not ($Checks.FkGrade -gt $Limits.FkMax -or $Checks.MaxSentWords -gt $Limits.SentWords -or $Checks.MaxParaWords -gt $Limits.ParaWords)) {
        return $State
    }

    $Ctx = [pscustomobject]@{
        Body          = $Body
        BodyLower     = $Body.ToLower()
        Violations    = Get-OpEdReadabilityViolation -Checks $Checks -Limits $Limits
        OrigWordCount = @($Body -split '\s+' | Where-Object { $_ -ne '' }).Count
        Limits        = $Limits
        Style         = $Style
        Model         = $Model
        MaxTokens     = $MaxTokens
        PromptsDir    = $PromptsDir
    }
    try {
        Invoke-OpEdEditSelection -State $State -Ctx $Ctx -Checks $Checks -Limits $Limits
    } catch {
        Write-Warning "Op-ed edit pass failed — using original body. ($($_.Exception.Message))"
        $State.EditingMeta = Get-OpEdRevertedMeta -Checks $Checks -Reason "error: $($_.Exception.Message.Substring(0, [Math]::Min(120, $_.Exception.Message.Length)))"
    }
    $State
}

function Measure-OpEdWordCount {
    # Prefer an actual count over the model's self-report.
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return 0 }
    @($Text -split '\s+' | Where-Object { $_ -ne '' }).Count
}

function Get-OpEdReflectionUsageMap {
    # id -> reflection from the reflection reply, or $null when it has no grounding_usage.
    param([string]$Text)
    $ReflParsed = $Text | ConvertFrom-Json
    if ($ReflParsed.PSObject.Properties.Name -notcontains 'grounding_usage') { return $null }
    $UsageMap = @{}
    foreach ($u in @($ReflParsed.grounding_usage)) {
        if ($null -ne $u -and $u.PSObject.Properties.Name -contains 'id') {
            $UsageMap[[string]$u.id] = [string]$u.reflection
        }
    }
    return $UsageMap
}

function Add-OpEdGroundingReflection {
    # Reflection pass: map each grounding element to how/where it's reflected. A separate lightweight
    # call that reads the FINISHED essay. Deliberately NOT folded into the main call: asking for the
    # essay AND per-element usage in one JSON response makes the metadata contend with the body for
    # the output token budget and truncates the essay (observed). Judging against the real text also
    # yields truthful placements rather than mid-write predictions. Best-effort — any failure leaves
    # Reflection as '(not reported)'.
    param([System.Collections.Generic.List[PSObject]]$Grounding, [string]$FinalBody, $SBrief, [string]$Model, [string]$PromptsDir)
    if (@($Grounding).Count -eq 0 -or [string]::IsNullOrWhiteSpace($FinalBody)) { return }
    foreach ($g in $Grounding) { $g.Reflection = '(not reported)' }
    try {
        $glb = [System.Text.StringBuilder]::new()
        foreach ($g in $Grounding) {
            [void]$glb.AppendLine("- [$($g.Id)] ($($g.Type)/$($g.Category)) $($g.Label)")
        }
        $ReflPrompt = Get-Prompt -Name 'op-ed-grounding-reflection' -PromptsDir $PromptsDir -Replacements @{
            OPED_BODY      = $FinalBody
            GROUNDING_LIST = $glb.ToString().Replace("`r`n", "`n").TrimEnd()
            # Mirror generate.ts:291-293 reflection pass: numbered key_claims list, "(none)" fallback
            # when absent. Without this the shared prompt's {{SOURCE_CLAIMS}} slot (t/2890) rendered
            # literally on the PS path (t/2911).
            SOURCE_CLAIMS  = Format-OpEdKeyClaimList -SBrief $SBrief -Empty '(none)'
        }
        $ReflSchema = @{
            type       = 'object'
            properties = @{
                grounding_usage = @{
                    type  = 'array'
                    items = @{
                        type       = 'object'
                        properties = @{ id = @{ type = 'string' }; reflection = @{ type = 'string' } }
                        required   = @('id', 'reflection')
                    }
                }
            }
            required   = @('grounding_usage')
        }
        $ReflMax = [Math]::Max(4000, (@($Grounding).Count * 150) + 3000)
        $ReflResult = Invoke-AIApi -Prompt $ReflPrompt -Model $Model -Temperature 0.2 `
            -MaxTokens $ReflMax -JsonMode -ResponseSchema $ReflSchema
        if ($ReflResult -and -not [string]::IsNullOrWhiteSpace($ReflResult.Text)) {
            $UsageMap = Get-OpEdReflectionUsageMap -Text $ReflResult.Text
            if ($null -ne $UsageMap) {
                foreach ($g in $Grounding) {
                    if ($UsageMap.ContainsKey($g.Id)) { $g.Reflection = $UsageMap[$g.Id] }
                }
            }
        }
    } catch {
        Write-Warning "Grounding-reflection pass failed; Grounding.Reflection left as '(not reported)'. ($($_.Exception.Message))"
    }
}

function Get-OpEdPrepField {
    # The source-format fields of the output object ($null when no source was supplied).
    param($Prep)
    if ($null -eq $Prep) { return @{ SourceFormat = $null; SourceExtractionTool = $null; ReadableWords = $null; ReadableRatio = $null } }
    @{ SourceFormat = $Prep.SourceFormat; SourceExtractionTool = $Prep.SourceExtractionTool; ReadableWords = $Prep.ReadableWords; ReadableRatio = $Prep.ReadableRatio }
}

function Format-OpEdMarkdown {
    # The -OutputPath Markdown: headline, subtitle, body, and the grounding table.
    param([string]$Headline, [string]$Subtitle, [string]$Body, $Grounding)
    $md = [System.Text.StringBuilder]::new()
    if ($Headline) { [void]$md.AppendLine("# $Headline"); [void]$md.AppendLine() }
    if ($Subtitle) { [void]$md.AppendLine("*$Subtitle*"); [void]$md.AppendLine() }
    [void]$md.AppendLine($Body)
    if (@($Grounding).Count -gt 0) {
        [void]$md.AppendLine()
        [void]$md.AppendLine('---')
        [void]$md.AppendLine()
        [void]$md.AppendLine('## Taxonomy grounding (relevance + how it is reflected)')
        [void]$md.AppendLine()
        [void]$md.AppendLine('| Element | Type | Category | Relevance | Reflected in the op-ed |')
        [void]$md.AppendLine('|---|---|---|---|---|')
        foreach ($g in $Grounding) {
            $refl = ([string]$g.Reflection) -replace '\|', '\|'
            [void]$md.AppendLine("| $($g.Id) — $($g.Label) | $($g.Type) | $($g.Category) | $([Math]::Round([double]$g.RelevanceScore, 4)) | $refl |")
        }
    }
    # The written .md is LF on every OS (repo convention: *.md eol=lf); AppendLine would emit CRLF on Windows (t/4081).
    $md.ToString().Replace("`r`n", "`n")
}
