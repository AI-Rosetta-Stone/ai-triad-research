# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932: a push=false (A/B/dry-run) Container Image dispatch must never be read as "pushed."

BeforeAll {
    $script:Script = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-PushFlagFromRunName.ps1'
    $script:ShaScript = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-BuiltShaFromRunName.ps1'
    . $script:Script
    . $script:ShaScript
}

Describe 'Get-PushFlagFromRunName (t/4932)' {
    It 'reads push=true as pushed, from the real run-name shape: separate (sha-...) and (push=...)' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234) (push=true)' | Should -Be $true
    }

    It 'reads push=false as NOT pushed' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234) (push=false)' | Should -Be $false
    }

    It 'normalises case' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234) (push=TRUE)' | Should -Be $true
        Get-PushFlagFromRunName 'Container Image (sha-abc1234) (push=FALSE)' | Should -Be $false
    }

    It 'fails closed (not pushed) for a pre-change run name with no push marker' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234)' | Should -Be $false
    }

    It 'fails closed for empty, null or malformed input' {
        Get-PushFlagFromRunName '' | Should -Be $false
        Get-PushFlagFromRunName $null | Should -Be $false
        Get-PushFlagFromRunName 'Container Image (sha-abc1234) (push=maybe)' | Should -Be $false
    }

    It 'invoked with a marker, writes pushed=true/false to GITHUB_OUTPUT' {
        $OutFile = Join-Path $TestDrive 'gh_output.txt'
        $env:GITHUB_OUTPUT = $OutFile
        try {
            & $script:Script -RunName 'Container Image (sha-abc1234) (push=true)' -GitHubOutput
            Get-Content $OutFile -Raw | Should -Match 'pushed=true'
        } finally {
            Remove-Item Env:\GITHUB_OUTPUT -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Get-BuiltShaFromRunName and Get-PushFlagFromRunName against the SAME real run-name (t/4932 B1)' {
    # Lead review (#4679, B1): the push flag must live in its OWN parenthetical. The old
    # `(sha-X, push=true)` shape broke Get-BuiltShaFromRunName's `\(sha-...\)`-needs-`)`-
    # immediately-after-the-hex regex, fail-closing every staging deploy. Nothing tested the
    # two parsers against the SAME name before this -- these do.
    It 'both parsers agree on a pushed, full-length-SHA run name' {
        $Name = 'Container Image (sha-eeb267d00d0f87fec1870cf99b8af26c3c57cf3c) (push=true)'
        Get-BuiltShaFromRunName $Name | Should -Be 'eeb267d00d0f87fec1870cf99b8af26c3c57cf3c'
        Get-PushFlagFromRunName $Name | Should -Be $true
    }

    It 'both parsers agree on a non-pushed, short-SHA run name' {
        $Name = 'Container Image (sha-eeb267d) (push=false)'
        Get-BuiltShaFromRunName $Name | Should -Be 'eeb267d'
        Get-PushFlagFromRunName $Name | Should -Be $false
    }
}
