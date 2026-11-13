# Tag: ingestion (t/375)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Import flags snapshots whose text layer lost its figures: metadata.numeric_gaps + WARN (t/375 fix 2).
.DESCRIPTION
    The gap text is from epistemic-boundaries-macroeconomic-realities-technical-2026's snapshot, a
    Google Docs PDF whose numbers aren't in its text layer. The clean text holds the near-misses the
    corpus calibration turned up ("by and large", "used by and under", "the Trillion Dollar Cluster").
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:GapText = @"
Specifically, Acemoglu projects that AI
will impact less than

of all work tasks, implyinga highly marginal cumulative U.S.

productivity increase of
and a cumulative GDP growthboost of only
over
12
the next decade. Briggs forecasts that generative AI will ultimately automate
of all work tasks, thereby raising U.S. productivityby

and cumulative GDP growth by

over the same period.12 To earn an adequate return on the estimated
trillion in planned CapEx for data centers, the technology must be capable.
"@
    $script:CleanText = @"
AI will impact less than 5% of all work tasks, with a productivity increase of 0.5% and a GDP
boost of only 0.9% over the next decade. By and large, the systems are used by and under the
control of a human operator. See Racing to the Trillion Dollar Cluster, which costs more than
1 trillion dollars, and an estimated 4.7 trillion in investment.
"@
    # 100 words, so the import computes a content hash like a real document (spec 1.3 floor).
    $script:Pad = "`n" + ((1..100 | ForEach-Object { "pad$_" }) -join ' ') + "`n"
}

Describe 'Measure-SnapshotNumericGaps (t/375)' -Tag 'ingestion' {

    It 'counts every lost figure in the real gap text' {
        InModuleScope AITriad -Parameters @{ T = $script:GapText } {
            param($T)
            # less than of; increase of and; boost of only over; by over the; estimated trillion
            Measure-SnapshotNumericGaps -Text $T | Should -Be 5
        }
    }

    It 'counts nothing in clean text, including the corpus near-misses' {
        InModuleScope AITriad -Parameters @{ T = $script:CleanText } {
            param($T)
            Measure-SnapshotNumericGaps -Text $T | Should -Be 0
            Measure-SnapshotNumericGaps -Text '' | Should -Be 0
        }
    }
}

Describe 'Import-AITriadDocument records numeric_gaps (t/375)' -Tag 'ingestion' {

    BeforeEach {
        $script:Sources = Join-Path ([System.IO.Path]::GetTempPath()) "ait-gaps-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path (Join-Path $script:Sources '_work') -Force | Out-Null
    }
    AfterEach {
        if (Test-Path $script:Sources) { Remove-Item $script:Sources -Recurse -Force }
    }

    It 'writes numeric_gaps=<Expected> and <Warns> for the <Name> text' -TestCases @(
        @{ Name = 'gap';   Expected = 5; Warns = 'WARNs' }
        @{ Name = 'clean'; Expected = 0; Warns = 'does not WARN' }
    ) {
        param($Name, $Expected, $Warns)
        $text = if ($Name -eq 'gap') { $script:GapText } else { $script:CleanText }
        $file = Join-Path $script:Sources '_work' "$Name-study.md"
        [System.IO.File]::WriteAllText($file, "# A $Name study`n`n$text$($script:Pad)", [System.Text.UTF8Encoding]::new($false))

        $warnings = InModuleScope AITriad -Parameters @{ Sources = $script:Sources; F = $file } {
            param($Sources, $F)
            Mock Get-SourcesDir { $Sources }
            Mock Update-AITSourceIndex { }
            Mock Add-ToSummaryQueue { }
            Mock Submit-ToWaybackMachine { }
            $w = $null
            $null = Import-AITriadDocument -File $F -SkipAiMeta -SkipWayback -NoSummaryQueue -NoSummarize -WarningVariable w -WarningAction SilentlyContinue 6>$null
            , @($w | ForEach-Object { [string]$_ })
        }

        $docDir = @(Get-ChildItem -LiteralPath $script:Sources -Directory | Where-Object { $_.Name -notmatch '^[._]' })
        $docDir.Count | Should -Be 1
        $meta = Get-Content (Join-Path $docDir[0].FullName 'metadata.json') -Raw | ConvertFrom-Json
        $meta.numeric_gaps | Should -Be $Expected
        $gapWarnings = @($warnings | Where-Object { $_ -match 'numeric gap' })
        if ($Expected -gt 0) {
            $gapWarnings.Count | Should -Be 1
            $gapWarnings[0] | Should -Match "$Expected numeric gap"
        } else {
            $gapWarnings.Count | Should -Be 0
        }
    }
}
