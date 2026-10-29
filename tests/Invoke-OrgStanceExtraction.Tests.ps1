# Tag: taxonomy (t/1553 Stage 1)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-OrgStanceExtraction — Stage 1 of t/1553.
.DESCRIPTION
    Focus is filter + skip logic + persistence shape. AI is mocked so tests
    run offline. End-to-end AI path was validated against the real corpus
    (3 docs → 17 valid claims) before this suite landed.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:sourcesDir = Join-Path ([System.IO.Path]::GetTempPath()) "orgstance-t1553-src-$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $script:sourcesDir -Force
    foreach ($id in 'src-a', 'src-b') {
        $dir = Join-Path $script:sourcesDir $id
        $null = New-Item -ItemType Directory -Path $dir -Force
        "Body of $id — plausible policy paragraph." | Set-Content -Path (Join-Path $dir 'snapshot.md') -Encoding utf8NoBOM
    }

    $script:tmpClaims = Join-Path ([System.IO.Path]::GetTempPath()) "orgstance-t1553-claims-$(Get-Random).json"
}

AfterAll {
    if ($script:sourcesDir -and (Test-Path $script:sourcesDir)) {
        Remove-Item -Recurse -Force $script:sourcesDir -ErrorAction SilentlyContinue
    }
    if ($script:tmpClaims -and (Test-Path $script:tmpClaims)) {
        Remove-Item -Force $script:tmpClaims -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-OrgStanceExtraction (t/1553 Stage 1)' -Tag 'taxonomy' {

    BeforeEach {
        InModuleScope AITriad -Parameters @{ Dir = $script:sourcesDir; ClaimsPath = $script:tmpClaims } {
            param($Dir, $ClaimsPath)
            if (Test-Path $ClaimsPath) { Remove-Item $ClaimsPath -Force }

            # Local variables — GetNewClosure() captures locals, not $script: vars.
            $srcDirLocal    = $Dir
            $claimsPathLocal = $ClaimsPath
            $orgs = @(
                [PSCustomObject]@{ id = 'org-014'; name = 'NIST'; type = 'regulatory' }
                [PSCustomObject]@{ id = 'org-999'; name = 'Ghost';  type = 'academic'  }
            )
            $edges = @(
                [PSCustomObject]@{ source='org-014'; target='src-a'; type='PUBLISHED'; status='approved' }
                [PSCustomObject]@{ source='org-014'; target='src-b'; type='PUBLISHED'; status='approved' }
                [PSCustomObject]@{ source='org-014'; target='src-missing'; type='PUBLISHED'; status='approved' }
                [PSCustomObject]@{ source='org-014'; target='src-a'; type='PUBLISHED'; status='proposed' }
                [PSCustomObject]@{ source='org-unknown'; target='src-a'; type='PUBLISHED'; status='approved' }
                [PSCustomObject]@{ source='org-014'; target='src-a'; type='ADVOCATES_FOR'; status='approved' }
                [PSCustomObject]@{ source='org-014'; target='org-999'; type='PUBLISHED'; status='approved' }
            )

            Mock Get-SourcesDir -MockWith ({ $srcDirLocal }.GetNewClosure())
            $taxDirLocal = Split-Path -Parent $claimsPathLocal
            Mock Get-TaxonomyDir -MockWith ({ $taxDirLocal }.GetNewClosure())
            Mock Get-OrganizationsStore -MockWith ({ [PSCustomObject]@{ organizations = $orgs } }.GetNewClosure())
            Mock Get-OrganizationEdgesStore -MockWith ({ [PSCustomObject]@{ edges = $edges } }.GetNewClosure())
            Mock Get-Prompt -MockWith { 'RENDERED PROMPT' }
        }
    }

    It 'Extracts only from approved PUBLISHED edges with on-disk sources' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[{"text":"stub","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":0.9}]}'
                    Model = 'stub'
                }
            }
            $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null

            $r.Extracted           | Should -Be 2  -Because 'src-a and src-b are the only approved-on-disk pairs'
            $r.ClaimsWritten       | Should -Be 2
            $r.Failed              | Should -Be 0
            $r.SkippedNoDoc        | Should -Be 1  -Because 'src-missing is approved but not on disk'
        }
    }

    It 'Persists anchors when the model returns it, and defaults to [] when absent (t/4482)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[' +
                        '{"text":"a","canonical_proposition":"X ought Y","anchors":["EU AI Act Article 62"],"polarity":"asserts","extraction_confidence":0.9},' +
                        '{"text":"b","canonical_proposition":"Z ought W","polarity":"asserts","extraction_confidence":0.9}' +
                    ']}'
                    Model = 'stub'
                }
            }
            $null = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null

            $store = Get-Content $ClaimsPath -Raw | ConvertFrom-Json
            # The fixture has 2 approved on-disk sources (src-a, src-b), and the mocked AI response is
            # the same for both, so each stub claim is written once per source — select one of each.
            $withAnchor = @($store.claims | Where-Object { $_.text -eq 'a' })[0]
            $withoutAnchor = @($store.claims | Where-Object { $_.text -eq 'b' })[0]
            @($withAnchor.anchors) | Should -Be @('EU AI Act Article 62')
            @($withoutAnchor.anchors).Count | Should -Be 0 -Because 'a claim the model returns with no anchors field defaults to an empty array, not null or a dropped field'
        }
    }

    It 'Idempotence: re-run against the same set writes zero new claims' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[{"text":"stub","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":0.9}]}'
                    Model = 'stub'
                }
            }
            $null = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null
            $r2 = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null

            $r2.ClaimsWritten      | Should -Be 0
            $r2.SkippedAlreadyDone | Should -Be 2
        }
    }

    It '-Force re-extracts and replaces prior claims for the same (org, source)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            $script:callCount = 0
            Mock Invoke-AIByUsage -MockWith {
                $script:callCount++
                [PSCustomObject]@{
                    Text = "{`"claims`":[{`"text`":`"stub $($script:callCount)`",`"canonical_proposition`":`"v$($script:callCount)`",`"polarity`":`"asserts`",`"extraction_confidence`":0.9}]}"
                    Model = 'stub'
                }
            }
            $null = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null
            $r2 = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Force -Confirm:$false 3>$null 6>$null

            $r2.ClaimsWritten      | Should -Be 2
            $store = Get-Content $ClaimsPath -Raw | ConvertFrom-Json
            @($store.claims).Count | Should -Be 2 -Because 'prior claims for these (org, source) were replaced, not appended'
        }
    }

    It 'Drops invalid claims (bad polarity, out-of-range confidence) and logs them (t/1553#12)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            # Mixed batch: 1 valid + 3 invalid (bad polarity, conf > 1, empty proposition).
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[' +
                           '{"text":"good","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":0.9},' +
                           '{"text":"bad-pol","canonical_proposition":"X ought Y","polarity":"maybe","extraction_confidence":0.9},' +
                           '{"text":"bad-conf","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":1.7},' +
                           '{"text":"empty-prop","canonical_proposition":"","polarity":"asserts","extraction_confidence":0.9}' +
                           ']}'
                    Model = 'stub'
                }
            }
            $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null

            # 2 eligible sources × 1 valid claim each = 2 written
            $r.ClaimsWritten  | Should -Be 2
            # 2 sources × 3 invalid = 6 dropped
            $r.InvalidDropped | Should -Be 6
            ($r.InvalidItems -join '|') | Should -Match 'polarity.*maybe'
            ($r.InvalidItems -join '|') | Should -Match 'extraction_confidence 1\.7'
            ($r.InvalidItems -join '|') | Should -Match 'canonical_proposition empty'
        }
    }

    It 'Flags double-marked opposes claims but does not drop them (t/1553#14 + #16 lint)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            # Mix: 1 clean opposes + 1 direct-oppose double-mark + 1 negated-deontic double-mark.
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[' +
                           '{"text":"clean","canonical_proposition":"Mandatory pre-deployment evals","polarity":"opposes","extraction_confidence":0.9},' +
                           '{"text":"double-direct","canonical_proposition":"The org ought to oppose foreign regulations","polarity":"opposes","extraction_confidence":0.9},' +
                           '{"text":"double-neg-deontic","canonical_proposition":"Foreign governments ought not to impose regulations","polarity":"opposes","extraction_confidence":0.9}' +
                           ']}'
                    Model = 'stub'
                }
            }
            $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null

            $r.ClaimsWritten     | Should -Be 6  -Because '2 sources × 3 claims each; nothing dropped by the lint'
            $r.FlaggedDoubleMark | Should -Be 4  -Because 'both direct-oppose and negated-deontic double-marks trigger the lint per source'
            $joined = $r.FlaggedItems.canonical_proposition -join '|'
            $joined | Should -Match 'oppose foreign regulations'
            $joined | Should -Match 'ought not to impose'
        }
    }

    It 'Strips markdown fences from AI response before parsing' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            $fenced = @'
```json
{"claims":[{"text":"stub","canonical_proposition":"X","polarity":"asserts","extraction_confidence":0.9}]}
```
'@
            Mock Invoke-AIByUsage -MockWith ({
                [PSCustomObject]@{ Text = $fenced; Model = 'stub' }
            }.GetNewClosure())
            $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false 3>$null 6>$null
            $r.ClaimsWritten | Should -Be 2 -Because 'fence stripping must not lose the JSON payload'
            $r.Failed        | Should -Be 0
        }
    }

    It 'records text_verbatim per claim and WARNs on a paraphrase (t/4382)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            # Snapshot body: "Body of src-a — plausible policy paragraph." One claim quotes it with a line
            # break and markdown emphasis (verbatim); the other rewords it (a paraphrase).
            Mock Invoke-AIByUsage -MockWith {
                [PSCustomObject]@{
                    Text = '{"claims":[{"text":"plausible\n*policy* paragraph","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":0.9},{"text":"a reasonable paragraph about policy","canonical_proposition":"Z ought W","polarity":"asserts","extraction_confidence":0.8}]}'
                    Model = 'stub'
                }
            }
            $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false -WarningVariable w 6>$null 3>$null
            $r.ClaimsWritten | Should -Be 4
            $stored = @((Get-Content $ClaimsPath -Raw | ConvertFrom-Json).claims)
            @($stored | Where-Object { $_.text -like 'plausible*' -and $_.text_verbatim -eq $true }).Count | Should -Be 2
            @($stored | Where-Object { $_.text -like 'a reasonable*' -and $_.text_verbatim -eq $false }).Count | Should -Be 2
            @($w | Where-Object { "$_" -match 'not a verbatim span' }).Count | Should -Be 2
        }
    }

    It 'text_verbatim is checked against the mojibake-repaired snapshot, not raw bytes (t/4608)' {
        InModuleScope AITriad -Parameters @{ ClaimsPath = $script:tmpClaims } {
            param($ClaimsPath)
            # cp1252-as-cp437 mojibake (t/4394): a snapshot written as cp1252 then misread as cp437.
            # This is the function's own documented example -- U+2019 round-trips to U+00C6.
            $mojiDir = Join-Path ([System.IO.Path]::GetTempPath()) "orgstance-t4608-src-$(Get-Random)"
            $srcDir = Join-Path $mojiDir 'src-moji'
            $null = New-Item -ItemType Directory -Path $srcDir -Force
            $clean = 'The government' + [char]0x2019 + 's ability to act is described here.'
            $cp1252 = [System.Text.Encoding]::GetEncoding(1252)
            $cp437 = [System.Text.Encoding]::GetEncoding(437)
            $corrupted = $cp437.GetString($cp1252.GetBytes($clean))
            [System.IO.File]::WriteAllText((Join-Path $srcDir 'snapshot.md'), $corrupted, [System.Text.UTF8Encoding]::new($false))

            try {
                Mock Get-SourcesDir -MockWith ({ $mojiDir }.GetNewClosure())
                Mock Get-OrganizationEdgesStore -MockWith {
                    [PSCustomObject]@{ edges = @([PSCustomObject]@{ source = 'org-014'; target = 'src-moji'; type = 'PUBLISHED'; status = 'approved' }) }
                }
                Mock Invoke-AIByUsage -MockWith {
                    [PSCustomObject]@{
                        Text = ('{{"claims":[{{"text":"{0}","canonical_proposition":"X ought Y","polarity":"asserts","extraction_confidence":0.9}}]}}' -f "government's ability to act is described here")
                        Model = 'stub'
                    }
                }
                $r = Invoke-OrgStanceExtraction -Concurrency 1 -OutputPath $ClaimsPath -Confirm:$false -WarningVariable w 6>$null 3>$null
                $r.ClaimsWritten | Should -Be 1
                $stored = @((Get-Content $ClaimsPath -Raw | ConvertFrom-Json).claims)
                @($stored | Where-Object { $_.text -like "government's*" })[0].text_verbatim |
                    Should -Be $true -Because 'the model''s clean output must compare against the repaired snapshot, not the raw mojibake bytes'
                @($w | Where-Object { "$_" -match 'repaired cp1252-as-cp437 mojibake' }).Count | Should -BeGreaterThan 0
            }
            finally {
                Remove-Item -Recurse -Force $mojiDir -ErrorAction SilentlyContinue
            }
        }
    }
}

Describe 'Test-StanceTextVerbatim (t/4382)' -Tag 'taxonomy' {
    It '<Name>' -ForEach @(
        @{ Name = 'exact span';                         Text = 'policy paragraph';                      Expected = $true }
        @{ Name = 'differs only in whitespace';         Text = "policy`n   paragraph";                  Expected = $true }
        # Curly quotes built from code points: PowerShell treats U+2018/U+2019 as string delimiters.
        @{ Name = 'differs only in curly vs straight quotes'; Text = ('the ' + [char]0x201C + 'Act' + [char]0x201D + ' isn' + [char]0x2019 + 't enough'); Expected = $true }
        @{ Name = 'differs only in markdown emphasis';  Text = 'the "**Act**" isn''t _enough_';         Expected = $true }
        @{ Name = 'paraphrase';                         Text = 'the law is insufficient';               Expected = $false }
        @{ Name = 'empty text';                         Text = '';                                      Expected = $false }
        @{ Name = 'markdown link anchor text matches (t/4610)'; Text = '[policy paragraph](https://example.com) says'; Expected = $true }
        @{ Name = 'markdown link anchor text does not match the source (t/4610)'; Text = '[fabricated phrase](https://example.com) says'; Expected = $false }
        @{ Name = 'elision joins two genuinely-present segments in order (t/4609)'; Text = 'policy paragraph ... isn''t enough'; Expected = $true }
        @{ Name = 'elision cannot paper over segments out of source order (t/4609)'; Text = 'isn''t enough ... policy paragraph'; Expected = $false }
        @{ Name = 'elision with a segment not present in the source (t/4609)'; Text = 'policy paragraph ... totally invented'; Expected = $false }
        @{ Name = 'bare ellipsis with no real content (t/4609)';  Text = '...';                          Expected = $false }
    ) {
        InModuleScope AITriad -Parameters @{ T = $Text; E = $Expected } {
            param($T, $E)
            $snapshot = "Intro.`n`nA policy paragraph says the ""Act"" isn't enough.`n"
            Test-StanceTextVerbatim -Text $T -Snapshot $snapshot | Should -Be $E
        }
    }
}
