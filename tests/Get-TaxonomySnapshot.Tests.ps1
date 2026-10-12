# Tag: taxonomy (t/1493)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Get-TaxonomySnapshot multi-file fetch cmdlet (t/1493).
.DESCRIPTION
    Mocks HTTP + GitHub API to verify: the 11-file fetch (9 taxonomy +
    2 conflict), commit-SHA stamping, snapshot-meta.json manifest, and
    the required-set validation gate that container.yml's inlined logic
    used to enforce.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:SnapDir = Join-Path ([System.IO.Path]::GetTempPath()) "taxsnap-t1493-$(Get-Random)"
}

AfterAll {
    if ($script:SnapDir -and (Test-Path $script:SnapDir)) {
        Remove-Item -Recurse -Force -Path $script:SnapDir -ErrorAction SilentlyContinue
    }
}

Describe 'Get-TaxonomySnapshot (t/1493)' -Tag 'taxonomy' {

    It 'Fetches 11 files, stamps commit, writes snapshot-meta.json, reports Valid' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SnapDir } {
            param($Dir)

            # Mock the per-file fetch to write a small JSON body — verifies the
            # cmdlet routes each URL to the right destination and captures size.
            Mock Invoke-WebRequest -MockWith {
                param($Uri, $OutFile)
                # $OutFile comes through PSBoundParameters — Pester binds names.
                Set-Content -Path $OutFile -Value '{"ok":true}' -Encoding utf8NoBOM
                [PSCustomObject]@{ StatusCode = 200 }
            }
            Mock Invoke-GitHubApi -MockWith {
                [PSCustomObject]@{ sha = 'deadbeefcafebabe1234567890abcdef' }
            }

            $r = Get-TaxonomySnapshot -OutputPath $Dir 3>$null

            $r                        | Should -Not -BeNullOrEmpty
            $r.Commit                 | Should -Be 'deadbeefcafebabe1234567890abcdef'
            @($r.Files).Count         | Should -Be 11 -Because '9 taxonomy + 2 conflict = 11 files'
            $r.Valid                  | Should -Be $true
            @($r.MissingRequired).Count | Should -Be 0
            Test-Path $r.SnapshotMetaPath | Should -Be $true

            $meta = Get-Content $r.SnapshotMetaPath -Raw | ConvertFrom-Json
            $meta.commit              | Should -Be 'deadbeefcafebabe1234567890abcdef'
            $meta.repo                | Should -Be 'AI-Rosetta-Stone/ai-triad-data'
            $meta.branch              | Should -Be 'main'
            $meta.valid               | Should -Be $true

            # Spot-check the layout: taxonomy files under taxonomy/Origin/, conflict under conflicts/
            Test-Path (Join-Path $Dir 'taxonomy/Origin/edges.json')       | Should -Be $true
            Test-Path (Join-Path $Dir 'taxonomy/Origin/situations.json')  | Should -Be $true
            Test-Path (Join-Path $Dir 'conflicts/_conflict-index.json')   | Should -Be $true
        }
    }

    It 'Reports Valid=false and lists missing required files when a POV file fails to download' {
        InModuleScope AITriad {
            $SnapDir2 = Join-Path ([System.IO.Path]::GetTempPath()) "taxsnap-t1493-fail-$(Get-Random)"
            try {
                Mock Invoke-WebRequest -MockWith {
                    param($Uri, $OutFile)
                    # Fail specifically for safetyist.json — leaves the file un-written.
                    if ($Uri -match 'safetyist\.json$') {
                        throw [System.Net.WebException]::new('404 not found')
                    }
                    Set-Content -Path $OutFile -Value '{"ok":true}' -Encoding utf8NoBOM
                    [PSCustomObject]@{ StatusCode = 200 }
                }
                Mock Invoke-GitHubApi -MockWith {
                    [PSCustomObject]@{ sha = 'abc123' }
                }

                $r = Get-TaxonomySnapshot -OutputPath $SnapDir2 3>$null

                $r.Valid                    | Should -Be $false
                @($r.MissingRequired)       | Should -Contain 'safetyist.json'
                $failingFile                = $r.Files | Where-Object { $_.Url -match 'safetyist\.json$' }
                $failingFile.Ok             | Should -Be $false
            } finally {
                if (Test-Path $SnapDir2) { Remove-Item -Recurse -Force -Path $SnapDir2 -ErrorAction SilentlyContinue }
            }
        }
    }

    It "Sets Commit to 'unknown' when the GitHub API call fails" {
        InModuleScope AITriad {
            $SnapDir3 = Join-Path ([System.IO.Path]::GetTempPath()) "taxsnap-t1493-noshas-$(Get-Random)"
            try {
                Mock Invoke-WebRequest -MockWith {
                    param($Uri, $OutFile)
                    Set-Content -Path $OutFile -Value '{"ok":true}' -Encoding utf8NoBOM
                    [PSCustomObject]@{ StatusCode = 200 }
                }
                Mock Invoke-GitHubApi -MockWith { throw 'no token' }

                $r = Get-TaxonomySnapshot -OutputPath $SnapDir3 3>$null

                $r.Commit                   | Should -Be 'unknown'
                # Fetch still succeeded — snapshot is still Valid (commit is metadata, not gating).
                $r.Valid                    | Should -Be $true
            } finally {
                if (Test-Path $SnapDir3) { Remove-Item -Recurse -Force -Path $SnapDir3 -ErrorAction SilentlyContinue }
            }
        }
    }
}
