# Tag: ingestion (t/4394)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4394: read-side repair of console-code-page mojibake in PDF-derived snapshots.
.DESCRIPTION
    Damaged inputs are produced by applying the real mangle to clean text (the converter's bytes decoded
    as cp437), so every repair is checked as an exact round-trip. No smart punctuation appears as a
    literal in this file: PowerShell treats U+2018/U+2019 as single-quote delimiters.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:RSQ = [string][char]0x2019; $script:LDQ = [string][char]0x201C; $script:RDQ = [string][char]0x201D
    $script:EN  = [string][char]0x2013; $script:EM  = [string][char]0x2014; $script:ELL = [string][char]0x2026
    $script:EACUTE = [string][char]0x00E9

    function script:Mangle-Cp1252([string]$t) { [Text.Encoding]::GetEncoding(437).GetString([Text.Encoding]::GetEncoding(1252).GetBytes($t)) }
    function script:Mangle-Utf8([string]$t)   { [Text.Encoding]::GetEncoding(437).GetString([Text.Encoding]::UTF8.GetBytes($t)) }
    function script:Repair([string]$t) { InModuleScope AITriad -Parameters @{ T = $t } { param($T) Repair-SnapshotMojibake -Text $T } }

    # Our own wrapper: clean UTF-8 that is NOT cp437-encodable (U+2019 and U+2014), like the real header.
    $script:Wrapper = "<!-- AI Triad snapshot -->`n# The Agency" + $RSQ + "s Report`nAI Triad Research Project " + $EM + " Document Snapshot`n`n---`n"
    $script:Body = "The government" + $RSQ + "s ability isn" + $RSQ + "t clear. He said " + $LDQ + "no" + $RDQ +
                   " " + $EM + " then pages 3" + $EN + "4" + $ELL + " at the caf" + $EACUTE + "."
}

Describe 'Repair-SnapshotMojibake (t/4394)' -Tag 'ingestion' {

    It 'repairs the cp1252-as-cp437 variant exactly (U+2019 had become U+00C6)' {
        $damaged = Mangle-Cp1252 $Body
        $damaged | Should -Match ([string][char]0x00C6)
        $r = Repair ($Wrapper + $damaged)
        $r.Variant | Should -Be 'cp1252-as-cp437'
        $r.Text | Should -BeExactly ($Wrapper + $Body)
    }

    It 'repairs the utf8-as-cp437 variant exactly (U+2019 had become U+0393 U+00C7 U+00D6)' {
        $damaged = Mangle-Utf8 $Body
        $damaged | Should -Match ([string][char]0x0393 + [char]0x00C7 + [char]0x00D6)
        $r = Repair ($Wrapper + $damaged)
        $r.Variant | Should -Be 'utf8-as-cp437'
        $r.Text | Should -BeExactly ($Wrapper + $Body)
    }

    It 'never touches the wrapper (its genuine U+2019 and U+2014 survive byte-for-byte)' {
        $r = Repair ($Wrapper + (Mangle-Cp1252 $Body))
        $r.Text.Substring(0, $Wrapper.Length) | Should -BeExactly $Wrapper
    }

    It 'repairs a body with quote damage only (no apostrophe signature)' {
        $clean = "She wrote " + $LDQ + "yes" + $RDQ + " and then " + $LDQ + "no" + $RDQ + "."
        $r = Repair ($Wrapper + (Mangle-Cp1252 $clean))
        $r.Variant | Should -Be 'cp1252-as-cp437'
        $r.Text | Should -BeExactly ($Wrapper + $clean)
    }

    It 'leaves clean French text byte-unchanged (o-circumflex would invert to U+201C)' {
        $fr = "Le c" + [char]0x00F4 + "t" + $EACUTE + " o" + [char]0x00F9 + " l'" + $EACUTE + "t" + $EACUTE + " commence."
        $r = Repair ($Wrapper + $fr)
        $r.Variant | Should -Be 'none'
        $r.Text | Should -BeExactly ($Wrapper + $fr)
    }

    It 'leaves clean German text byte-unchanged (o-umlaut would invert to U+201D)' {
        $de = "Sch" + [char]0x00F6 + "n, sagte das M" + [char]0x00E4 + "dchen."
        $r = Repair ($Wrapper + $de)
        $r.Variant | Should -Be 'none'
        $r.Text | Should -BeExactly ($Wrapper + $de)
    }

    It 'leaves clean French with u-circumflex mid-word and "ou" + grave before a space unchanged' {
        # u-circumflex inverts to an en dash between letters (co-t), "ou"+grave to an em dash before a
        # space: neither is typographic dash evidence.
        $fr = "Le co" + [char]0x00FB + "t est s" + [char]0x00FB + "r, o" + [char]0x00F9 + " les prix montent."
        $r = Repair ($Wrapper + $fr)
        $r.Variant | Should -Be 'none'
        $r.Text | Should -BeExactly ($Wrapper + $fr)
    }

    It 'repairs English damaged only in its dashes (no apostrophes or quotes to count)' {
        $clean = "The framework" + $EM + "announced in May" + $EM + "covers 2019" + $EN + "2024 and more " + $EM + " much more."
        $r = Repair ($Wrapper + (Mangle-Cp1252 $clean))
        $r.Variant | Should -Be 'cp1252-as-cp437'
        $r.Text | Should -BeExactly ($Wrapper + $clean)
    }

    It 'repairs a utf8-as-cp437 body with one broken sequence, keeping the stray byte as it was' {
        # A no-break space (U+00A0, UTF-8 C2 A0) mangles to U+252C U+00E1. Drop the U+252C lead, as the
        # 19 corpus docs show, and strict UTF-8 rejects the whole body.
        $clean   = $Body + " and" + [char]0x00A0 + "more" + $RSQ + "s text."
        $damaged = (Mangle-Utf8 $clean).Replace([string][char]0x252C + [char]0x00E1, [string][char]0x00E1)
        $r = Repair ($Wrapper + $damaged)
        $r.Variant | Should -Be 'utf8-as-cp437'
        # Everything repaired except the broken spot, which keeps its original char (U+00E1).
        $r.Text | Should -BeExactly ($Wrapper + $clean.Replace([string][char]0x00A0, [string][char]0x00E1))
    }

    It 'leaves a body that is not cp437-encodable (it already holds a real U+2019)' {
        $t = $Wrapper + "It" + $RSQ + "s fine, " + [char]0x00C6 + "lfric."
        (Repair $t).Variant | Should -Be 'none'
    }

    It 'leaves pure ASCII, empty and null input unchanged' {
        (Repair ($Wrapper + "plain ascii, it's fine")).Variant | Should -Be 'none'
        (Repair '').Variant | Should -Be 'none'
        (Repair $null).Variant | Should -Be 'none'
    }

    It 'leaves a clean body whose only non-ASCII is cp437-encodable but gains no smart punctuation' {
        $t = $Wrapper + "Caf" + $EACUTE + " " + [char]0x00B7 + " menu"
        (Repair $t).Variant | Should -Be 'none'
    }
}

Describe 'Read-SnapshotForModel applies the repair on read, never on disk (t/4394)' -Tag 'ingestion' {

    It 'returns the repaired text, WARNs, and leaves the file byte-identical' {
        $path = Join-Path $TestDrive 'snapshot.md'
        [IO.File]::WriteAllText($path, $Wrapper + (Mangle-Cp1252 $Body), [Text.UTF8Encoding]::new($false))
        $before = (Get-FileHash $path).Hash

        $out = InModuleScope AITriad -Parameters @{ P = $path } {
            param($P)
            $w = $null
            $t = Read-SnapshotForModel -Path $P -CallerName 'Test' -WarningVariable w -WarningAction SilentlyContinue
            [pscustomobject]@{ Text = $t; Warns = @($w) }
        }
        $out.Text | Should -BeExactly ($Wrapper + $Body)
        @($out.Warns | Where-Object { "$_" -match 'cp1252-as-cp437' -and "$_" -match 't/4394' }).Count | Should -Be 1
        (Get-FileHash $path).Hash | Should -Be $before
    }

    It 'does not WARN for a clean snapshot' {
        $path = Join-Path $TestDrive 'clean.md'
        [IO.File]::WriteAllText($path, $Wrapper + $Body, [Text.UTF8Encoding]::new($false))
        $warns = InModuleScope AITriad -Parameters @{ P = $path } {
            param($P)
            $w = $null
            $null = Read-SnapshotForModel -Path $P -WarningVariable w -WarningAction SilentlyContinue
            @($w)
        }
        @($warns).Count | Should -Be 0
    }
}

Describe 'Repair-SnapshotMojibake fixture cases (t/4412)' -Tag 'ingestion' {
    # Shared fixture: same inputs and expected outputs as the vitest conformance suite
    # (lib/sanitize/repairSnapshotMojibake.test.ts). Includes near-miss 'must not repair' cases.
    # 'textInput' is used instead of 'input' to avoid shadowing the $input automatic variable.

    $fixturePath = Join-Path $PSScriptRoot 'fixtures' 'repair-snapshot-mojibake-cases.json'
    $fixtureCases = (Get-Content $fixturePath -Raw | ConvertFrom-Json).cases |
        ForEach-Object {
            @{
                id              = $_.id
                description     = $_.description
                textInput       = $_.input
                expectedVariant = $_.expected_variant
                expectedText    = $_.expected_text
            }
        }

    It '<id>: <description>' -ForEach $fixtureCases {
        $r = Repair $textInput
        $r.Variant | Should -Be $expectedVariant
        $et = if ($null -ne $expectedText) { $expectedText } else { $textInput }
        $r.Text | Should -BeExactly $et
    }
}
