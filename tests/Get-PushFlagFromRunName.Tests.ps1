# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932: a push=false (A/B/dry-run) Container Image dispatch must never be read as "pushed."

BeforeAll {
    $script:Script = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-PushFlagFromRunName.ps1'
    . $script:Script
}

Describe 'Get-PushFlagFromRunName (t/4932)' {
    It 'reads push=true as pushed' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234, push=true)' | Should -Be $true
    }

    It 'reads push=false as NOT pushed' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234, push=false)' | Should -Be $false
    }

    It 'normalises case' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234, push=TRUE)' | Should -Be $true
        Get-PushFlagFromRunName 'Container Image (sha-abc1234, push=FALSE)' | Should -Be $false
    }

    It 'fails closed (not pushed) for a pre-change run name with no push marker' {
        Get-PushFlagFromRunName 'Container Image (sha-abc1234)' | Should -Be $false
    }

    It 'fails closed for empty, null or malformed input' {
        Get-PushFlagFromRunName '' | Should -Be $false
        Get-PushFlagFromRunName $null | Should -Be $false
        Get-PushFlagFromRunName 'Container Image (sha-abc1234, push=maybe)' | Should -Be $false
    }

    It 'invoked with a marker, writes pushed=true/false to GITHUB_OUTPUT' {
        $OutFile = Join-Path $TestDrive 'gh_output.txt'
        $env:GITHUB_OUTPUT = $OutFile
        try {
            & $script:Script -RunName 'Container Image (sha-abc1234, push=true)' -GitHubOutput
            Get-Content $OutFile -Raw | Should -Match 'pushed=true'
        } finally {
            Remove-Item Env:\GITHUB_OUTPUT -ErrorAction SilentlyContinue
        }
    }
}
