# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# t/4366: the bulk metadata.json writers (Set-BatchDocCurrent, Finalize-Summary's
# Update-SummaryMetadata) read with a bare `ConvertFrom-Json -AsHashtable`, which coerces ISO-8601
# strings to [datetime]; the whole-object rewrite then re-emits them in the running machine's offset
# (`…+02:00` became `…-04:00` on 28 real files) and drops trailing-zero milliseconds. They now read
# with ConvertFrom-JsonPreserveShape -AsOrderedHashtable. The offsets used here (+05:45, and a
# trailing-zero Z) are not this or any CI machine's local offset, so today's code fails these tests.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:ImportTime = '2026-06-02T06:35:18.2831215+05:45'
    $script:EditedAt   = '2026-07-22T19:54:12.440Z'

    function script:New-MetaFile([string]$Dir) {
        $meta = [ordered]@{
            id              = 'shape-test-2026'
            title           = 'Shape test'
            import_time     = $script:ImportTime
            topic_tags      = @('only-one-tag')
            edit_meta       = [ordered]@{ last_edited_at = $script:EditedAt }
            summary_version = 'v-old'
            summary_status  = 'current'
            summary_updated = '2026-01-01T00:00:00Z'
        }
        $path = Join-Path $Dir 'metadata.json'
        InModuleScope AITriad -Parameters @{ P = $path; J = ($meta | ConvertTo-Json -Depth 10) } {
            param($P, $J) Write-Utf8NoBom -Path $P -Value $J
        }
        $path
    }
}

Describe 'metadata.json whole-object rewrites preserve ISO strings (t/4366)' -Tag 'data-integrity' {

    BeforeEach {
        $script:Dir = Join-Path ([System.IO.Path]::GetTempPath()) "ait-meta-shape-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path $script:Dir -Force | Out-Null
        $script:MetaFile = New-MetaFile $script:Dir
        $script:Original = [System.IO.File]::ReadAllText($script:MetaFile)
    }
    AfterEach { if (Test-Path $script:Dir) { Remove-Item $script:Dir -Recurse -Force } }

    It 'Set-BatchDocCurrent re-stamping the same values is byte-identical' {
        InModuleScope AITriad -Parameters @{ F = $script:MetaFile } {
            param($F)
            $docs = [System.Collections.Generic.List[hashtable]]::new()
            $docs.Add(@{ MetaFile = $F; DocId = 'shape-test-2026' })
            Set-BatchDocCurrent -Doc $docs -TaxonomyVersion 'v-old' -Now '2026-01-01T00:00:00Z' 6>$null
        }
        [System.IO.File]::ReadAllText($script:MetaFile) | Should -BeExactly $script:Original
    }

    It 'Set-BatchDocCurrent with new values changes only the three summary fields' {
        InModuleScope AITriad -Parameters @{ F = $script:MetaFile } {
            param($F)
            $docs = [System.Collections.Generic.List[hashtable]]::new()
            $docs.Add(@{ MetaFile = $F; DocId = 'shape-test-2026' })
            Set-BatchDocCurrent -Doc $docs -TaxonomyVersion 'v-new' -Now '2026-10-20T12:00:00Z' 6>$null
        }
        $after = [System.IO.File]::ReadAllText($script:MetaFile)
        $after | Should -Match ([regex]::Escape('"import_time": "' + $script:ImportTime + '"'))
        $after | Should -Match ([regex]::Escape('"last_edited_at": "' + $script:EditedAt + '"'))
        $after | Should -Match '"summary_version": "v-new"'
        $expected = $script:Original.Replace('"v-old"', '"v-new"').Replace('"2026-01-01T00:00:00Z"', '"2026-10-20T12:00:00Z"')
        $after | Should -BeExactly $expected
    }

    It 'Finalize-Summary metadata update keeps import_time and nested timestamps verbatim' {
        InModuleScope AITriad -Parameters @{ F = $script:MetaFile } {
            param($F)
            Update-SummaryMetadata -Doc @{ MetaFile = $F } -TaxonomyVersion 'v-new' -Now '2026-10-20T12:00:00Z' `
                -FactualClaims @() -FactualCount 0 -TotalPoints 3 -UnmappedCount 0 -ContextRot $null -ContextRotStages @() 3>$null
        }
        $after = [System.IO.File]::ReadAllText($script:MetaFile)
        $after | Should -Match ([regex]::Escape('"import_time": "' + $script:ImportTime + '"'))
        $after | Should -Match ([regex]::Escape('"last_edited_at": "' + $script:EditedAt + '"'))
        $after | Should -Match '"summary_status": "current"'
        $after | Should -Match '"total_facts": 3'
    }

    It 'ConvertFrom-JsonPreserveShape -AsOrderedHashtable keeps key order, strings and single-element arrays' {
        InModuleScope AITriad -Parameters @{ J = $script:Original; T = $script:ImportTime } {
            param($J, $T)
            $h = ConvertFrom-JsonPreserveShape -Json $J -AsOrderedHashtable
            $h | Should -BeOfType [System.Collections.Specialized.OrderedDictionary]
            @($h.Keys)[0..2] | Should -Be @('id', 'title', 'import_time')
            $h['import_time'] | Should -BeOfType [string]
            $h['import_time'] | Should -BeExactly $T
            , $h['topic_tags'] | Should -BeOfType [object[]]
        }
    }
}
