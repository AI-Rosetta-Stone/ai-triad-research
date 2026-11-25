# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Characterization tests pinning the CURRENT behavior of Add-SummaryUnmappedConcepts.
# Race-safe: dot-source ONLY this Private file, never Import-Module the batch worktree module.

BeforeAll {
    . "$PSScriptRoot\..\scripts\AITriad\Private\Add-SummaryUnmappedConcepts.ps1"

    function New-Concept {
        param([string]$Concept, [string]$SuggestedPov, [string]$SuggestedCategory, [string]$Reason, [switch]$Plain)
        if ($Plain) { return $Concept }
        $h = [ordered]@{}
        if ($PSBoundParameters.ContainsKey('Concept'))           { $h['concept'] = $Concept }
        if ($PSBoundParameters.ContainsKey('SuggestedPov'))       { $h['suggested_pov'] = $SuggestedPov }
        if ($PSBoundParameters.ContainsKey('SuggestedCategory'))  { $h['suggested_category'] = $SuggestedCategory }
        if ($PSBoundParameters.ContainsKey('Reason'))            { $h['reason'] = $Reason }
        return [pscustomobject]$h
    }

    function New-Summary {
        param($Concepts)
        return [pscustomobject]@{ unmapped_concepts = $Concepts }
    }
}

Describe 'Add-SummaryUnmappedConcepts' {

    It 'returns 0 and does not mutate when summary has no unmapped_concepts property' {
        $agg = @{}
        $result = Add-SummaryUnmappedConcepts -Summary ([pscustomobject]@{ other = 1 }) -DocId 'd1' -UnmappedAgg $agg
        $result | Should -Be 0
        $agg.Count | Should -Be 0
    }

    It 'returns 0 when unmapped_concepts is empty/null' {
        $agg = @{}
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @()) -DocId 'd1' -UnmappedAgg $agg
        $result | Should -Be 0
        $agg.Count | Should -Be 0
    }

    It 'aggregates a single concept with all fields' {
        $agg = @{}
        $c = New-Concept -Concept 'Model  Welfare' -SuggestedPov 'saf' -SuggestedCategory 'beliefs' -Reason 'r1'
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'd1' -UnmappedAgg $agg
        $result | Should -Be 1
        $key = 'model welfare'
        $agg.ContainsKey($key) | Should -BeTrue
        $agg[$key].Concept | Should -Be 'Model  Welfare'
        $agg[$key].NormalizedKey | Should -Be $key
        $agg[$key].Frequency | Should -Be 1
        $agg[$key].SuggestedPov | Should -Be 'saf'
        $agg[$key].SuggestedCategory | Should -Be 'beliefs'
        @($agg[$key].ContributingDocs) | Should -Be @('d1')
        @($agg[$key].Reasons) | Should -Be @('r1')
    }

    It 'counts null concepts in DocUnmapped return but skips aggregation' {
        $agg = @{}
        $c = New-Concept -Concept 'alpha'
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($null, $c)) -DocId 'd1' -UnmappedAgg $agg
        # null is filtered by @() expansion before the loop in PS; verify current behavior
        $result | Should -Be 1
        $agg.ContainsKey('alpha') | Should -BeTrue
    }

    It 'DocUnmapped increments even when NormKey is empty (whitespace concept)' {
        $agg = @{}
        $c = New-Concept -Concept '   '
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'd1' -UnmappedAgg $agg
        $result | Should -Be 1
        $agg.Count | Should -Be 0
    }

    It 'handles plain string concepts (no concept property)' {
        $agg = @{}
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @('Plain Text')) -DocId 'd1' -UnmappedAgg $agg
        $result | Should -Be 1
        $agg['plain text'].Concept | Should -Be 'Plain Text'
    }

    It 'increments Frequency across docs and tracks contributing docs and reasons uniquely' {
        $agg = @{}
        $c1 = New-Concept -Concept 'shared' -Reason 'ra'
        $c2 = New-Concept -Concept 'shared' -Reason 'rb'
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c1)) -DocId 'd1' -UnmappedAgg $agg | Out-Null
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c2)) -DocId 'd2' -UnmappedAgg $agg | Out-Null
        $agg['shared'].Frequency | Should -Be 2
        @($agg['shared'].ContributingDocs) | Should -Be @('d1', 'd2')
        @($agg['shared'].Reasons) | Should -Be @('ra', 'rb')
    }

    It 'does not duplicate contributing doc when same doc contributes same concept twice' {
        $agg = @{}
        $c1 = New-Concept -Concept 'dup' -Reason 'r'
        $c2 = New-Concept -Concept 'dup' -Reason 'r'
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c1, $c2)) -DocId 'd1' -UnmappedAgg $agg | Out-Null
        $agg['dup'].Frequency | Should -Be 2
        @($agg['dup'].ContributingDocs) | Should -Be @('d1')
        @($agg['dup'].Reasons) | Should -Be @('r')
    }

    It 'OncePerDoc skips when DocId already among ContributingDocs' {
        $agg = @{}
        $c = New-Concept -Concept 'once'
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'canonical' -UnmappedAgg $agg | Out-Null
        $before = $agg['once'].Frequency
        $result = Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'canonical' -UnmappedAgg $agg -OncePerDoc
        $result | Should -Be 1
        $agg['once'].Frequency | Should -Be $before
    }

    It 'OncePerDoc still counts when DocId not yet among ContributingDocs' {
        $agg = @{}
        $c = New-Concept -Concept 'onceb'
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'd1' -UnmappedAgg $agg | Out-Null
        Add-SummaryUnmappedConcepts -Summary (New-Summary -Concepts @($c)) -DocId 'd2' -UnmappedAgg $agg -OncePerDoc | Out-Null
        $agg['onceb'].Frequency | Should -Be 2
        @($agg['onceb'].ContributingDocs) | Should -Be @('d1', 'd2')
    }
}

Describe 'Get-SummaryConceptProp' {
    It 'preserves an array property value (suggested_pov stays an array, not a scalar)' {
        # Regression guard: a bare `return $Concept.$Name` enumerates, so ["safetyist"] arrived
        # as a scalar string and [] as $null. The unary-comma return keeps them intact.
        $c = [pscustomobject]@{ suggested_pov = @('safetyist') }
        $r = Get-SummaryConceptProp -Concept $c -Name 'suggested_pov' -Default $null
        , $r | Should -BeOfType [object[]]
        @($r).Count | Should -Be 1
        $r[0] | Should -BeExactly 'safetyist'
    }

    It 'preserves an empty array property value (stays @(), not $null)' {
        $c = [pscustomobject]@{ suggested_pov = @() }
        $r = Get-SummaryConceptProp -Concept $c -Name 'suggested_pov' -Default $null
        , $r | Should -BeOfType [object[]]
        @($r).Count | Should -Be 0
    }

    It 'returns a scalar property value unchanged' {
        $c = [pscustomobject]@{ concept = 'a plain concept' }
        Get-SummaryConceptProp -Concept $c -Name 'concept' -Default '' | Should -BeExactly 'a plain concept'
    }

    It 'returns the default when the property is absent' {
        $c = [pscustomobject]@{ other = 1 }
        Get-SummaryConceptProp -Concept $c -Name 'suggested_pov' -Default 'fallback' | Should -BeExactly 'fallback'
    }
}
