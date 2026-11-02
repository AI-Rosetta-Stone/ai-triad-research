# Tag: cli (t/4755)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Start-ContainerMode's docker run argument construction (t/4755).
.DESCRIPTION
    t/4755: container mode mounted the data repo at /data but never told the
    server to use it -- the image's own default (NODE_ENV=production,
    AI_TRIAD_DATA_ROOT=/tmp/taxonomy-cache) picks the github-api storage
    backend, which needs GitHub App credentials nobody but the hosted
    deployment has. Also missing: loopback-only port binding (the container
    has no sign-in gate). This suite asserts the actual docker run argument
    list the cmdlet builds, mocking docker itself so no real container runs.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:TestDataDir = Join-Path ([System.IO.Path]::GetTempPath()) "taxeditor-t4755-data-$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $script:TestDataDir -Force
}

AfterAll {
    if ($script:TestDataDir -and (Test-Path $script:TestDataDir)) {
        Remove-Item -Recurse -Force $script:TestDataDir -ErrorAction SilentlyContinue
    }
}

Describe 'Start-ContainerMode docker run arguments (t/4755)' -Tag 'cli' {

    It 'passes STORAGE_MODE=filesystem, AI_TRIAD_DATA_ROOT=/data, and binds loopback-only' {
        InModuleScope AITriad -Parameters @{ DataDir = $script:TestDataDir } {
            param($DataDir)

            Mock Get-ContainerName -MockWith { 'taxonomy-editor-test' }
            Mock Test-TaxonomyContainerRunning -MockWith { $false }
            Mock Test-DockerImageExists -MockWith { $true }
            # Unary comma prevents the empty array from unrolling to $null across the
            # Mock pipeline boundary (same class of gotcha as a bare 'return @()').
            Mock Get-ApiKeyEnvArgs -MockWith { ,@() }

            $script:capturedArgs = $null
            Mock docker -MockWith {
                # Distinguish the stale-container probe from the real run call by
                # inspecting the first couple of positional args ($args is docker's
                # own argv here, since Mock intercepts the unqualified command name).
                if ($args[0] -eq 'ps') { return @() }
                if ($args[0] -eq 'run') {
                    $script:capturedArgs = $args
                    $global:LASTEXITCODE = 0
                    return 'container-id-stub'
                }
                $global:LASTEXITCODE = 0
                return @()
            }
            Mock Wait-ForHealthEndpoint -MockWith { $false }

            Start-ContainerMode -Port 7862 -DataPath $DataDir -NoBrowser -Detach

            $script:capturedArgs | Should -Not -BeNullOrEmpty -Because 'the run call must have been reached'
            $joined = $script:capturedArgs -join ' '

            $joined | Should -Match ([regex]::Escape('-p 127.0.0.1:7862:7862')) -Because 'the container has no sign-in gate, so it must not be LAN-reachable'
            $joined | Should -Match ([regex]::Escape('-e STORAGE_MODE=filesystem')) -Because 'without this the server picks the github-api backend and ignores the /data mount'
            $joined | Should -Match ([regex]::Escape('-e AI_TRIAD_DATA_ROOT=/data')) -Because 'must point at the bind-mount path, not the image default'
            $joined | Should -Match ([regex]::Escape("-v ${DataDir}:/data")) -Because 'the data repo mount itself must still be present'
        }
    }
}
