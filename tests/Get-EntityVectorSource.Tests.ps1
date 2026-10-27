# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Parity contract (t/4458): PowerShell's Get-EntityVectorSource -> SrcHash must agree
# byte-for-byte with TypeScript's computeEntityVectorSourceHash (lib/entities/entityVectors.ts)
# over tests/fixtures/entity-vector-source-cases.json, the shared fixture both runtimes consume.
# Same pattern as SourceIdentity.Tests.ps1. _src_hashes is the staleness fingerprint
# lib/entities/nameResolver.ts now reads to skip a stale/unhashed vector (t/4458, PR #3962).

#Requires -Module Pester

BeforeDiscovery {
    $script:FixturePath = Join-Path $PSScriptRoot 'fixtures' 'entity-vector-source-cases.json'
    $fixture = Get-Content -Raw -LiteralPath $script:FixturePath | ConvertFrom-Json
    $script:Cases = @($fixture.cases | ForEach-Object {
        @{ Name = $_.name; EntityName = [string]$_.entity_name; Aliases = @($_.aliases); Description = [string]$_.description; Expected = [string]$_.expected_hash }
    })
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Fixture = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'fixtures' 'entity-vector-source-cases.json') | ConvertFrom-Json
}

Describe 'Entity-vector-source fixture' -Tag 'entities' {
    It 'is version 1 and non-vacuous' {
        $script:Fixture.version | Should -Be 1
        @($script:Fixture.cases).Count | Should -BeGreaterThan 5
    }

    It 'has no duplicate case names' {
        $n = @($script:Fixture.cases.name)
        @($n | Sort-Object -Unique).Count | Should -Be $n.Count
    }
}

Describe 'Get-EntityVectorSource.SrcHash matches the shared fixture (parity with computeEntityVectorSourceHash, t/4458)' -Tag 'entities' {
    It '<Name>' -ForEach $script:Cases {
        $got = InModuleScope AITriad -Parameters @{ EntityName = $EntityName; Aliases = $Aliases; Description = $Description } {
            param($EntityName, $Aliases, $Description)
            (Get-EntityVectorSource -Name $EntityName -Aliases @($Aliases) -Description $Description).SrcHash
        }
        $got | Should -BeExactly $Expected
    }
}
