# Tag: taxonomy (t/4626)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-BoundedTestRun.ps1 (t/4626): a wall-clock/memory watchdog for ad hoc Pester runs,
    added after an unbounded `Invoke-Pester -Path tests/` run grew to 15 GB and OOM-crashed the
    Orca server fleet. These tests run the real script against small throwaway fixture files —
    not the production suite — so they stay fast and don't themselves risk the thing they guard.
#>

BeforeAll {
    $script:RunnerPath = Join-Path $PSScriptRoot '..' 'scripts' 'Invoke-BoundedTestRun.ps1'
    $script:FixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) "boundedrun-t4626-$(Get-Random)"
    New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null

    Set-Content -Path (Join-Path $script:FixtureDir 'Fast.Tests.ps1') -Encoding utf8NoBOM -Value @'
Describe 'fast fixture' {
    It 'passes immediately' { $true | Should -Be $true }
}
'@

    Set-Content -Path (Join-Path $script:FixtureDir 'Hangs.Tests.ps1') -Encoding utf8NoBOM -Value @'
Describe 'hanging fixture' {
    It 'sleeps far longer than the test timeout' { Start-Sleep -Seconds 600 }
}
'@

    Set-Content -Path (Join-Path $script:FixtureDir 'MemoryHog.Tests.ps1') -Encoding utf8NoBOM -Value @'
Describe 'memory-hungry fixture' {
    It 'allocates well past a tiny ceiling, slowly enough for a poll to catch it' {
        $blocks = [System.Collections.Generic.List[byte[]]]::new()
        1..60 | ForEach-Object {
            $b = [byte[]]::new(20MB)
            # Touch every page so the OS actually commits it to the working set, not just reserves it.
            for ($i = 0; $i -lt $b.Length; $i += 4096) { $b[$i] = 1 }
            $blocks.Add($b)
            Start-Sleep -Milliseconds 300
        }
    }
}
'@
}

AfterAll {
    if ($script:FixtureDir -and (Test-Path $script:FixtureDir)) {
        Remove-Item -Recurse -Force $script:FixtureDir -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-BoundedTestRun (t/4626)' -Tag 'taxonomy' {

    It 'completes normally with no KilledReason when the run is fast and small' {
        $r = & $script:RunnerPath -Path (Join-Path $script:FixtureDir 'Fast.Tests.ps1') `
            -TimeoutMinutes 2 -MaxMemoryMB 1024 -PollSeconds 1
        $r.KilledReason | Should -BeNullOrEmpty
        $r.ExitCode     | Should -Be 0
        $r.PeakMemoryMB | Should -BeGreaterThan 0
    }

    It 'kills a hanging run at the timeout ceiling and throws an ActionableError (t/4626)' {
        { & $script:RunnerPath -Path (Join-Path $script:FixtureDir 'Hangs.Tests.ps1') `
            -TimeoutMinutes 0 -MaxMemoryMB 1024 -PollSeconds 1 -ErrorAction Stop } |
            Should -Throw -ExpectedMessage '*exceeded the 0-minute ceiling*'
    }

    It 'kills a memory-hungry run at the memory ceiling and throws an ActionableError (t/4626)' {
        { & $script:RunnerPath -Path (Join-Path $script:FixtureDir 'MemoryHog.Tests.ps1') `
            -TimeoutMinutes 5 -MaxMemoryMB 150 -PollSeconds 1 -ErrorAction Stop } |
            Should -Throw -ExpectedMessage '*over the 150MB ceiling*'
    }
}
