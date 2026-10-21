# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Source-document identity contract (t/4337, t/4334): the PowerShell implementation must
# produce every expected value in tests/fixtures/source-identity-cases.json, the fixture the
# TypeScript side (lib/sourceIndex) also runs. Rules: docs/specs/source-identity.md.

BeforeDiscovery {
    $script:FixturePath = Join-Path $PSScriptRoot 'fixtures' 'source-identity-cases.json'
    $fixture = Get-Content -Raw -LiteralPath $script:FixturePath | ConvertFrom-Json
    $script:HashCases  = @($fixture.hash_cases  | ForEach-Object { @{ Name = $_.name; Text = [string]$_.text; Expected = $_.expected_sha256 } })
    $script:UrlCases   = @($fixture.url_cases   | ForEach-Object { @{ Name = $_.name; InputUrl = $_.input; Expected = $_.expected } })
    $script:TrustCases = @($fixture.trust_cases | ForEach-Object { @{ Name = $_.name; Metadata = $_.metadata; Expected = @($_.expected) } })
    $script:TitleCases = @($fixture.title_cases | ForEach-Object { @{ Name = $_.name; InputTitle = [string]$_.input; Expected = [string]$_.expected } })
    $script:GroupingCases = @($fixture.grouping_cases | ForEach-Object {
        @{ Name = $_.name; Documents = @($_.documents); Expected = $_.expected_canonical
           ExpectedCollisionsJson = (ConvertTo-Json -InputObject @($_.expected_title_collisions | ForEach-Object { , [string[]]@($_) }) -Compress -Depth 4)
           ExpectedConflictsJson  = (ConvertTo-Json -InputObject @($_.expected_url_conflicts | ForEach-Object { [ordered]@{ url_key = [string]$_.url_key; ids = [string[]]@($_.ids) } }) -Compress -Depth 4) } })
    $script:DuplicateOfCases = @($fixture.duplicate_of_cases | ForEach-Object {
        @{ Name = $_.name; Documents = @($_.documents); Expected = $_.expected_canonical; ExpectedResolved = $_.expected_resolved
           ExpectedSelectableJson = (ConvertTo-Json -InputObject ([string[]]@($_.expected_selectable)) -Compress -AsArray)
           ExpectedErrorsJson = (ConvertTo-Json -InputObject @($_.expected_duplicate_of_errors | ForEach-Object { [ordered]@{ id = [string]$_.id; target = [string]$_.target; kind = [string]$_.kind } }) -Compress -Depth 4) } })
}

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'SourceIdentity.ps1')
    $script:Fixture = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'fixtures' 'source-identity-cases.json') | ConvertFrom-Json
}

Describe 'Source identity fixture (docs/specs/source-identity.md)' -Tag 'source-identity' {

    It 'is version 5 and non-vacuous' {
        $script:Fixture.version | Should -Be 5
        @($script:Fixture.duplicate_of_cases).Count | Should -BeGreaterThan 5
        @($script:Fixture.hash_cases).Count  | Should -BeGreaterThan 10
        @($script:Fixture.url_cases).Count   | Should -BeGreaterThan 10
        @($script:Fixture.trust_cases).Count | Should -BeGreaterThan 3
    }

    It 'covers the cases where runtimes could diverge (TL list, p/801#3)' {
        $names = @($script:Fixture.hash_cases.name) + @($script:Fixture.url_cases.name) + @($script:Fixture.trust_cases.name)
        $names += @($script:Fixture.grouping_cases.name) + @($script:Fixture.duplicate_of_cases.name)
        # Plus the section 4 revision cases the TL required on #3522 (p/801#6).
        foreach ($needle in 'CRLF', 'BOM', 'non-ASCII', 'utm', 'query order', 'fragment', 'search', 'REAL: 7 query-string', 'REAL: eight-ways', 'union',
            'AI Policy Bulletin', 'non-ASCII titles that reduce', 'genuine -N collision', 'year suffix', 'title_collision',
            # And the 4.3 URL conflict veto cases the TL required (t/4337#8).
            'url_conflict', 'REAL: url_conflict - two PNAS papers', 'REAL: arXiv-number slug',
            # And the 1.3 body floor the TL required (p/801#17).
            'floor: 99 words', 'floor: exactly 100 words', 'NBSP-joined', 'same cookie wall do not merge',
            # And the section 6 duplicate marks the SO required (e/342#2, C1/C2/C6).
            'missing_target', 'self mark', 'chain is not followed', 'cycle', 'conflict', 'unmarked group member', 'not the ordinal-smallest') {
            @($names | Where-Object { $_ -match [regex]::Escape($needle) }).Count | Should -BeGreaterThan 0 -Because "the fixture must cover '$needle'"
        }
    }

    It 'has no duplicate case names' {
        foreach ($list in 'hash_cases', 'url_cases', 'trust_cases', 'title_cases', 'grouping_cases', 'duplicate_of_cases') {
            $n = @($script:Fixture.$list.name)
            @($n | Sort-Object -Unique).Count | Should -Be $n.Count -Because "$list names must be unique"
        }
    }
}

Describe 'Get-SourceContentHash matches the fixture' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:HashCases {
        $got = Get-SourceContentHash -Text $Text
        if ($null -eq $Expected) { $got | Should -BeNullOrEmpty } else { $got | Should -BeExactly $Expected }
    }
}

Describe 'ConvertTo-SourceUrlKey matches the fixture' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:UrlCases {
        $got = ConvertTo-SourceUrlKey -Url $InputUrl
        if ($null -eq $Expected) { $got | Should -BeNullOrEmpty } else { $got | Should -BeExactly $Expected }
    }
}

Describe 'Get-TrustedSourceUrlKey matches the fixture' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:TrustCases {
        [string[]]$got = Get-TrustedSourceUrlKey -Metadata $Metadata
        ($got | ConvertTo-Json -Compress -AsArray) | Should -BeExactly ([string[]]$Expected | ConvertTo-Json -Compress -AsArray)
    }
}

Describe 'ConvertTo-SourceTitleKey matches the fixture' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:TitleCases {
        ConvertTo-SourceTitleKey -Title $InputTitle | Should -BeExactly $Expected
    }
}

Describe 'Get-SourceIdentityGroup matches the fixture' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:GroupingCases {
        $docs = @($Documents | ForEach-Object {
            [pscustomobject]@{ Id = [string]$_.id; Metadata = $_.metadata
                               # snapshot_text (v4): the consumer computes the hash itself (spec 5), floor included.
                               SnapshotSha256 = $(if ($_.PSObject.Properties['snapshot_text']) { Get-SourceContentHash -Text ([string]$_.snapshot_text) }
                                                  elseif ($_.PSObject.Properties['snapshot_sha256']) { [string]$_.snapshot_sha256 }) } })
        $got = Get-SourceIdentityGroup -Documents $docs
        $expectedIds = @($Expected.PSObject.Properties.Name)
        @($got.Canonical.Keys).Count | Should -Be $expectedIds.Count
        foreach ($id in $expectedIds) {
            $got.Canonical[$id] | Should -BeExactly ([string]$Expected.$id) -Because "canonical id of '$id'"
        }
        $gotJson = ConvertTo-Json -InputObject @($got.TitleCollisions | ForEach-Object { , [string[]]@($_) }) -Compress -Depth 4
        $gotJson | Should -BeExactly $ExpectedCollisionsJson -Because 'title_collision report'
        $gotConflicts = ConvertTo-Json -InputObject @($got.UrlConflicts | ForEach-Object { [ordered]@{ url_key = [string]$_.url_key; ids = [string[]]@($_.ids) } }) -Compress -Depth 4
        $gotConflicts | Should -BeExactly $ExpectedConflictsJson -Because 'url_conflict report'
    }
}

Describe 'Get-SourceIdentityGroup duplicate marks match the fixture (spec section 6)' -Tag 'source-identity' {
    It '<Name>' -ForEach $script:DuplicateOfCases {
        $docs = @($Documents | ForEach-Object {
            [pscustomobject]@{ Id = [string]$_.id; Metadata = $_.metadata
                               SnapshotSha256 = $(if ($_.PSObject.Properties['snapshot_sha256']) { [string]$_.snapshot_sha256 }) } })
        $got = Get-SourceIdentityGroup -Documents $docs
        foreach ($id in @($Expected.PSObject.Properties.Name)) {
            $got.Canonical[$id] | Should -BeExactly ([string]$Expected.$id) -Because "canonical id of '$id'"
            $got.Resolved[$id]  | Should -BeExactly ([string]$ExpectedResolved.$id) -Because "resolved id of '$id'"
        }
        (ConvertTo-Json -InputObject ([string[]]$got.Selectable) -Compress -AsArray) | Should -BeExactly $ExpectedSelectableJson -Because 'selectable ids'
        $gotErrors = ConvertTo-Json -InputObject @($got.DuplicateOfErrors | ForEach-Object { [ordered]@{ id = [string]$_.id; target = [string]$_.target; kind = [string]$_.kind } }) -Compress -Depth 4
        $gotErrors | Should -BeExactly $ExpectedErrorsJson -Because 'duplicate_of_error report'
    }
}
