# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Characterization tests for the pure helpers extracted from Invoke-SummaryPipeline during the
# CC<15 refactor (file max was 75). These PIN the current behavior of the dependency-free helpers.
# Race-safe: dot-sources ONLY the Private file under test (a pure set of function definitions),
# never Import-Module of the batch-worktree module.

BeforeAll {
    $script:PipelineFile = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-SummaryPipeline.ps1'
    . $script:PipelineFile
}

Describe 'Get-PipelineDerivedConfidence' -Tag 'ingestion' {
    It 'returns 0.5 when the claim has no evidence_criteria' {
        $claim = [pscustomobject]@{ text = 'c' }
        Get-PipelineDerivedConfidence -Claim $claim | Should -Be 0.5
    }

    It 'returns 0.3 baseline when evidence_criteria is present but empty of bonuses' {
        $claim = [pscustomobject]@{ evidence_criteria = [pscustomobject]@{} }
        Get-PipelineDerivedConfidence -Claim $claim | Should -Be 0.3
    }

    It 'adds specificity/warrant/consistency bonuses (0.3 + 0.2 + 0.2 + 0.1 = 0.8)' {
        $claim = [pscustomobject]@{ evidence_criteria = [pscustomobject]@{
            specificity           = 'precise'
            has_warrant           = $true
            internally_consistent = $true
        } }
        [math]::Round((Get-PipelineDerivedConfidence -Claim $claim), 4) | Should -Be 0.8
    }

    It 'only credits specificity when it equals precise' {
        $claim = [pscustomobject]@{ evidence_criteria = [pscustomobject]@{ specificity = 'vague' } }
        Get-PipelineDerivedConfidence -Claim $claim | Should -Be 0.3
    }
}

Describe 'Add-PipelineDerivedConfidence' -Tag 'ingestion' {
    It 'is a no-op under FIRE (IterativeExtraction)' {
        $summary = [pscustomobject]@{ factual_claims = @([pscustomobject]@{ text = 'c' }) }
        Add-PipelineDerivedConfidence -SummaryObject $summary -IterativeExtraction
        $summary.factual_claims[0].PSObject.Properties['extraction_confidence'] | Should -BeNullOrEmpty
    }

    It 'backfills missing extraction_confidence on single-shot claims' {
        $summary = [pscustomobject]@{ factual_claims = @([pscustomobject]@{ text = 'c' }) }
        Add-PipelineDerivedConfidence -SummaryObject $summary
        $summary.factual_claims[0].extraction_confidence | Should -Be 0.5
    }

    It 'leaves an existing non-null extraction_confidence untouched' {
        $summary = [pscustomobject]@{ factual_claims = @([pscustomobject]@{ extraction_confidence = 0.9 }) }
        Add-PipelineDerivedConfidence -SummaryObject $summary
        $summary.factual_claims[0].extraction_confidence | Should -Be 0.9
    }

    It 'is a no-op when there are no factual_claims' {
        $summary = [pscustomobject]@{ other = 1 }
        { Add-PipelineDerivedConfidence -SummaryObject $summary } | Should -Not -Throw
    }
}

Describe 'Get-PipelineClaimCounts' -Tag 'ingestion' {
    It 'counts factual_claims and unmapped_concepts' {
        $summary = [pscustomobject]@{
            factual_claims    = @(1, 2, 3)
            unmapped_concepts = @('a', 'b')
        }
        $r = Get-PipelineClaimCounts -SummaryObject $summary
        $r.FactualCount | Should -Be 3
        $r.UnmappedCount | Should -Be 2
    }

    It 'returns zero counts when the fields are absent' {
        $summary = [pscustomobject]@{ other = 1 }
        $r = Get-PipelineClaimCounts -SummaryObject $summary
        $r.FactualCount | Should -Be 0
        $r.UnmappedCount | Should -Be 0
    }
}

Describe 'Get-PipelineDocumentFields' -Tag 'ingestion' {
    It 'reads pov/topic tags and title from metadata' {
        $meta = [pscustomobject]@{
            pov_tags   = @('accelerationist', 'skeptic')
            topic_tags = @('x', 'y')
            title      = 'My Title'
        }
        $r = Get-PipelineDocumentFields -Metadata $meta -DocId 'doc-1'
        @($r.PovTagsArray).Count | Should -Be 2
        $r.PovTagLine | Should -Be 'accelerationist, skeptic'
        $r.TopicTagLine | Should -Be 'x, y'
        $r.TitleLine | Should -Be 'My Title'
    }

    It 'falls back to DocId for the title and empties for absent tags' {
        $meta = [pscustomobject]@{ other = 1 }
        $r = Get-PipelineDocumentFields -Metadata $meta -DocId 'doc-2'
        @($r.PovTagsArray).Count | Should -Be 0
        $r.PovTagLine | Should -Be ''
        $r.TopicTagLine | Should -Be ''
        $r.TitleLine | Should -Be 'doc-2'
    }
}

Describe 'Invoke-PipelineAutoFireStage2' -Tag 'ingestion' {
    It 'returns current values unchanged under FIRE (no re-run)' {
        $summary = [pscustomobject]@{ k = 1 }
        $r = Invoke-PipelineAutoFireStage2 -IterativeExtraction -SummaryObject $summary `
            -FullPrompt 'p' -SysInstruction 's' -Model 'm' -ApiKey 'k' -Temperature 0.1 `
            -ExtractionMaxTokens 100 -CurrentBackend 'be' -CurrentFireStats 'fs'
        $r.Summary | Should -Be $summary
        $r.Backend | Should -Be 'be'
        $r.FireStats | Should -Be 'fs'
    }

    It 'returns current values when Stage-2 sniff says do not fire' {
        $summary = [pscustomobject]@{ k = 1 }
        # Define a local stub so the dependency-free helper can resolve the call without the module.
        function Test-FireRequired { param($SummaryObject) @{ ShouldFire = $false } }
        $r = Invoke-PipelineAutoFireStage2 -SummaryObject $summary `
            -FullPrompt 'p' -SysInstruction 's' -Model 'm' -ApiKey 'k' -Temperature 0.1 `
            -ExtractionMaxTokens 100 -CurrentBackend 'be' -CurrentFireStats 'fs'
        $r.Backend | Should -Be 'be'
    }
}
