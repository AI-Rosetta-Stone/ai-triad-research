# Tag: taxonomy (t/4836)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Set-IssueTypeTags (t/4836; TL conditions at t/4836#7/#8), the corpus-wide
    issue_types / issue_types_provenance batch writer. In-process validation (no external CLI,
    unlike Set-PovNodeTags) -- the enum + shape check is small enough to live in the cmdlet.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:StubDir = Join-Path ([System.IO.Path]::GetTempPath()) "issuetypes-stub-$(New-Guid)"
    New-Item -ItemType Directory -Path $script:StubDir -Force | Out-Null
}

AfterAll {
    Remove-Item -LiteralPath $script:StubDir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Set-IssueTypeTags (t/4836)' -Tag 'taxonomy' {

    BeforeEach {
        $script:TaxDir = Join-Path $script:StubDir "tax-$(New-Guid)"
        New-Item -ItemType Directory -Path $script:TaxDir -Force | Out-Null
        @'
{
  "nodes": [
    { "id": "skp-001", "label": "no tags yet", "graph_attributes": {} },
    { "id": "skp-002", "label": "already has other fields", "graph_attributes": { "epistemic_type": "x" } }
  ]
}
'@ | Set-Content -LiteralPath (Join-Path $script:TaxDir 'skeptic.json')
        '{ "nodes": [ { "id": "sit-001", "label": "a situation", "graph_attributes": {} } ] }' |
            Set-Content -LiteralPath (Join-Path $script:TaxDir 'situations.json')
        '{ "nodes": [] }' | Set-Content -LiteralPath (Join-Path $script:TaxDir 'accelerationist.json')
        '{ "nodes": [] }' | Set-Content -LiteralPath (Join-Path $script:TaxDir 'safetyist.json')

        # Describe/Context bodies run at Pester's DISCOVERY phase, not the RUN phase the It
        # blocks execute in -- a bare assignment here would be gone by the time any It runs
        # (same class of bug hit earlier this session with a bare `function` statement in a
        # Context body). BeforeEach runs in Run phase, so this stays visible to every It below.
        $script:SampleProvenance = @{
            Method = 'llm'; Model = 'gemini-3.5-flash-lite'; PromptVersion = 'issue-types-v1'
            RunId = 'issue-types-full-2026-11-04'; ClassifiedAt = '2026-11-04T13:02:12Z'
            Confidence = @{ political = 0.8; misuse = 0.7 }; Rationale = 'rationale text'
        }
    }

    Context 'happy path' {
        It 'writes a flat issue_types array and a fully-populated issue_types_provenance object' {
            $result = Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @('political', 'misuse'); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false
            $result.Checked | Should -Be 1
            $result.Applied | Should -Be 1

            $doc = Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json') | ConvertFrom-Json
            $node = @($doc.nodes | Where-Object { $_.id -eq 'skp-001' })[0]
            @($node.graph_attributes.issue_types) | Should -Be @('political', 'misuse')
            $node.graph_attributes.issue_types[0] | Should -BeOfType [string] -Because 'must be flat, never nested (the exact t/4835#10 bug class)'
            $node.graph_attributes.issue_types_provenance.method | Should -Be 'llm'
            $node.graph_attributes.issue_types_provenance.model | Should -Be 'gemini-3.5-flash-lite'
            $node.graph_attributes.issue_types_provenance.confidence.political | Should -Be 0.8
            $node.graph_attributes.issue_types_provenance.confidence.misuse | Should -Be 0.7
            $node.graph_attributes.issue_types_provenance.rationale | Should -Be 'rationale text'
            # ConvertFrom-Json auto-detects the written ISO-8601 string and hands this back as a
            # [DateTime], not a string -- confirmed empirically, and exactly the behavior that
            # caused the original bug (see the next test). Assert on the parsed value directly
            # rather than via string-matching the written text, which Pester's own -Match
            # operator handled inconsistently for this specific pattern during development.
            $classifiedAt = $node.graph_attributes.issue_types_provenance.classified_at
            $classifiedAt | Should -BeOfType [DateTime] -Because 'must be a valid parseable timestamp'
            $classifiedAt.Kind | Should -Be 'Utc' -Because 'must be UTC, not Local or Unspecified'
        }

        It 'writes classified_at as ISO 8601 UTC even when the caller passes a [DateTime] (SO finding, e/421#2 C1)' {
            # ConvertFrom-Json auto-detects an ISO-8601-shaped string and parses it into a
            # [DateTime] -- exactly what happens when a real caller (the frozen-list runner)
            # reads ClassifiedAt back out of a JSON file. A naive [string] cast on that DateTime
            # formats using the CURRENT CULTURE's default (e.g. "11/04/2026 13:02:12" on
            # en-US) -- ambiguous, no timezone, inconsistent with the rest of the corpus. This
            # test passes a real [DateTime] object directly (not a string) to prove the cmdlet
            # normalizes it correctly regardless of input shape.
            $dtProvenance = $script:SampleProvenance.Clone()
            $dtProvenance['ClassifiedAt'] = [DateTime]::Parse('2026-11-04T13:02:12.2458023-05:00', [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
            $result = Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $dtProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false
            $result.Applied | Should -Be 1
            $doc = Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json') | ConvertFrom-Json
            $node = @($doc.nodes | Where-Object { $_.id -eq 'skp-001' })[0]
            # Read back as a [DateTime] (ConvertFrom-Json's own auto-detection, confirmed above) --
            # assert on the parsed value rather than raw text, which was the whole source of the
            # original bug (a [string] cast on this exact shape produced a culture-formatted,
            # ambiguous, timezone-less string like "11/04/2026 13:02:12").
            $written = $node.graph_attributes.issue_types_provenance.classified_at
            $written | Should -BeOfType [DateTime]
            $written.Kind | Should -Be 'Utc' -Because 'must be UTC, never Local or Unspecified'
            $written.ToString('yyyy-MM-ddTHH:mm:ss') | Should -Be '2026-11-04T18:02:12' -Because 'must be the SAME instant as the input (-05:00), converted to UTC'
        }

        It 'writes issue_types: [] for a 0-tag node (distinct from field absence)' {
            $result = Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @(); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false
            $result.Applied | Should -Be 1
            $doc = Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json') | ConvertFrom-Json
            $node = @($doc.nodes | Where-Object { $_.id -eq 'skp-001' })[0]
            $node.graph_attributes.PSObject.Properties['issue_types'] | Should -Not -BeNullOrEmpty
            @($node.graph_attributes.issue_types).Count | Should -Be 0
        }

        It 'routes a situation id (sit-) to situations.json' {
            $result = Set-IssueTypeTags -Assignment @{ NodeId = 'sit-001'; Types = @('social'); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false
            $result.Applied | Should -Be 1
            $doc = Get-Content -Raw (Join-Path $script:TaxDir 'situations.json') | ConvertFrom-Json
            @($doc.nodes[0].graph_attributes.issue_types) | Should -Be @('social')
        }

        It 'preserves pre-existing graph_attributes fields untouched (zero collateral)' {
            $null = Set-IssueTypeTags -Assignment @{ NodeId = 'skp-002'; Types = @('economic'); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false
            $doc = Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json') | ConvertFrom-Json
            $node = @($doc.nodes | Where-Object { $_.id -eq 'skp-002' })[0]
            $node.graph_attributes.epistemic_type | Should -Be 'x'
        }

        It 'validates the batch once and writes in a single pass across multiple nodes/files' {
            $result = Set-IssueTypeTags -Assignment @(
                @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $SampleProvenance },
                @{ NodeId = 'sit-001'; Types = @('social'); Provenance = $SampleProvenance }
            ) -TargetPath $script:TaxDir -Confirm:$false
            $result.Checked | Should -Be 2
            $result.Applied | Should -Be 2
        }

        It 'surfaces a not-found node in NotFound without failing the rest of the batch' {
            $result = Set-IssueTypeTags -Assignment @(
                @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $SampleProvenance },
                @{ NodeId = 'skp-404'; Types = @('political'); Provenance = $SampleProvenance }
            ) -TargetPath $script:TaxDir -Confirm:$false -WarningAction SilentlyContinue
            $result.Applied | Should -Be 1
            $result.NotFound | Should -Contain 'skp-404'
        }

        It 'does not write anything under -WhatIf, but still validates' {
            Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $SampleProvenance } -TargetPath $script:TaxDir -WhatIf
            (Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json')) | Should -Not -Match 'issue_types' -Because 'the file must be untouched under -WhatIf'
        }
    }

    Context 'the validate-all-or-abort guard (t/4836#7 TL condition — negative-tested)' {
        It 'ABORTS THE WHOLE BATCH when one entry carries a nested-array-shaped Types value -- no partial write' {
            # [IssueTypeAssignment]'s Types property is typed [string[]]: PowerShell's own
            # scalar/array binding coercion stringifies a nested array element via .ToString()
            # (confirmed empirically: [string[]]@(@('a','b'),'c') -> @('a b','c')) BEFORE this
            # cmdlet's validation ever runs. The t/4835#10 bug class (final:[["a","b"]] instead
            # of final:["a","b"]) therefore cannot reach this cmdlet's write path at all -- the
            # type system itself is the guard here, a stronger guarantee than a runtime check.
            # This test proves the observable consequence: the stringified garbage value fails
            # the enum check and the whole batch still aborts with nothing written, exactly as
            # a genuinely-reachable nested value would need to.
            { Set-IssueTypeTags -Assignment @(
                @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $SampleProvenance },
                @{ NodeId = 'sit-001'; Types = @(@('nested_array_hazard'), 'misuse'); Provenance = $SampleProvenance }
            ) -TargetPath $script:TaxDir -Confirm:$false } | Should -Throw '*unknown id*'
            (Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json')) | Should -Not -Match 'issue_types' -Because 'the WHOLE batch refuses, including the otherwise-valid skp-001 entry'
            (Get-Content -Raw (Join-Path $script:TaxDir 'situations.json')) | Should -Not -Match 'issue_types'
        }

        It 'ABORTS THE WHOLE BATCH when one entry has an unknown enum id -- no partial write' {
            { Set-IssueTypeTags -Assignment @(
                @{ NodeId = 'skp-001'; Types = @('political'); Provenance = $SampleProvenance },
                @{ NodeId = 'sit-001'; Types = @('not_a_real_issue_type'); Provenance = $SampleProvenance }
            ) -TargetPath $script:TaxDir -Confirm:$false } | Should -Throw '*unknown id*'
            (Get-Content -Raw (Join-Path $script:TaxDir 'skeptic.json')) | Should -Not -Match 'issue_types'
            (Get-Content -Raw (Join-Path $script:TaxDir 'situations.json')) | Should -Not -Match 'issue_types'
        }

        It 'ABORTS on more than 3 types' {
            { Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @('political', 'misuse', 'economic', 'social'); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false } | Should -Throw '*more than the allowed 0-3*'
        }

        It 'ABORTS on duplicate types' {
            { Set-IssueTypeTags -Assignment @{ NodeId = 'skp-001'; Types = @('political', 'political'); Provenance = $SampleProvenance } `
                -TargetPath $script:TaxDir -Confirm:$false } | Should -Throw '*duplicate*'
        }
    }
}
