# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Entry-point characterization test for Invoke-SummaryPipeline (t/3834 complexity refactor).
# Unlike the helper-level suite, this drives the public entry point end to end on the single-shot
# path, so it guards the stage wiring the refactor touched. Passes on the pre-refactor code too.
# Race-safe: dot-sources ONLY this Private file; -TaxonomyJsonOverride bypasses the RAG stage, and
# every external AITriad dependency is stubbed deterministically in script scope.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-SummaryPipeline.ps1')

    # --- external AITriad deps (all stubbed; RAG path not reached via -TaxonomyJsonOverride) ---
    $script:AITriadPovCamps = @('acc', 'saf', 'skp', 'cc')   # module-scope constant the node-count helper reads
    $script:AiResponse = $null
    function Invoke-AIApi { param($Prompt, $SystemInstruction, $Model, $ApiKey, $Temperature, $MaxTokens, [switch]$JsonMode, $ResponseSchema, $TimeoutSec) $script:AiResponse }
    function Add-StageTiming { param($Name, $Milliseconds) }
    function Build-DensityScaledPrompt { param($WordCount, $Template) $Template }
    function Build-VocabularyBlock { '' }
    function Get-TaxonomyDir { $TestDrive }          # no policy_actions.json there -> policy block ''
    function Get-SummariesDir { $TestDrive }
    function Get-SummaryProp { param($Object, $Name) if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null } }
    function Test-SummaryField { param($Object, $Name) ($null -ne $Object -and $Object.PSObject.Properties[$Name]) }
    function Test-SummaryDensity { param($SummaryObject, $PovTags) [PSCustomObject]@{ Pass = $true; Reason = '' } }
    function Test-FireRequired { param($SummaryObject) [PSCustomObject]@{ ShouldFire = $false; Reason = '' } }
    function Remove-DuplicateClaims { param($SummaryObject, $SimilarityThreshold) [PSCustomObject]@{ Summary = $SummaryObject; Metrics = [PSCustomObject]@{ points_removed = 0; claims_removed = 0 } } }
    function Resolve-UnmappedConcepts { param($Concepts, $DocId) @() }
    function New-ContextRotStage { param($Stage, $InUnits, $InCount, $OutUnits, $OutCount, $Flags) [PSCustomObject]@{ stage = $Stage } }
    function Repair-TruncatedJson { param($Text) $null }
    function Invoke-BatchEmbeddings { @() }
    function Write-Utf8NoBom { param($Path, $Value) }

    $script:CommonArgs = @{
        DocId                = 'doc-entry'
        Metadata             = [pscustomobject]@{ title = 'T'; pov_tags = @('acc'); topic_tags = @('x') }
        ApiKey               = ''
        Model                = 'gemini-3.5-flash-lite'
        TaxonomyVersion      = 'v1'
        SystemPromptTemplate = 'SYS {{density}}'
        OutputSchema         = '{}'
        TaxonomyJsonOverride = '{"nodes":[]}'
    }

    function script:RunPipeline([string]$Snapshot, $AiResponse) {
        $script:AiResponse = $AiResponse
        Invoke-SummaryPipeline @script:CommonArgs -SnapshotText $Snapshot -WarningAction SilentlyContinue 3>$null
    }
}

Describe 'Invoke-SummaryPipeline entry point (single-shot)' -Tag 'data-mutation' {
    It 'returns the null-API failure contract when the extraction call returns null' {
        $r = RunPipeline 'a short document' $null
        $r.Success | Should -BeFalse
        $r.DocId   | Should -BeExactly 'doc-entry'
        $r.Error   | Should -BeExactly 'API call returned null'
    }

    It 'returns the invalid-JSON failure contract when the model text does not parse' {
        $r = RunPipeline 'a short document' ([pscustomobject]@{ Text = '{not json'; Backend = 'stub' })
        $r.Success | Should -BeFalse
        $r.Error   | Should -BeExactly 'InvalidJson'
    }

    It 'flows a valid single-shot summary through every stage to a Success result' {
        $json = '{"pov_summaries":{},"factual_claims":[],"unmapped_concepts":[]}'
        $r = RunPipeline 'a short document' ([pscustomobject]@{ Text = $json; Backend = 'stub-backend' })
        $r.Success | Should -BeTrue
        $r.DocId   | Should -BeExactly 'doc-entry'
        $r.Backend | Should -BeExactly 'stub-backend'
        $r.Summary | Should -Not -BeNullOrEmpty
    }
}
