# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms gate for .githooks/pre-push's ordering (t/4858, TL review condition 1).
.DESCRIPTION
    AITRIAD_PREPUSH=skip must skip only the (slower) TypeScript checks, never the
    queued-push guard -- a queued PR's head can race a push regardless of whether the
    pusher wants the TS checks run. Exercises the real hook script against a throwaway
    git repo with stub CHECKS/QUEUE_GUARD scripts, so no real `gh` call or TS build is
    needed and the refuse arm is deterministic.
#>

Describe '.githooks/pre-push ordering' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:HookSource = Join-Path $PSScriptRoot '../.githooks/pre-push'

        function New-StubRepo {
            $repo = Join-Path ([System.IO.Path]::GetTempPath()) ("prepush-test-" + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $repo -Force | Out-Null
            Push-Location $repo
            try {
                git init -q
                git config user.email 'test@example.com'
                git config user.name 'Test'
                'placeholder' | Set-Content -Path 'placeholder.txt'
                git add placeholder.txt
                git commit -q -m 'initial'
                git branch -q -m main
                New-Item -ItemType Directory -Path 'operations/devops' -Force | Out-Null
            } finally {
                Pop-Location
            }
            return $repo
        }

        function Invoke-Hook {
            param([string]$Repo, [hashtable]$Env)
            $headSha = (git -C $Repo rev-parse HEAD).Trim()
            $stdin = "refs/heads/feature $headSha refs/heads/feature $headSha`n"
            $psi = [System.Diagnostics.ProcessStartInfo]::new()
            $psi.FileName = $script:Sh
            $psi.ArgumentList.Add($script:HookSource)
            $psi.WorkingDirectory = $Repo
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.UseShellExecute = $false
            foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[$k] = $Env[$k] }
            $proc = [System.Diagnostics.Process]::Start($psi)
            $proc.StandardInput.Write($stdin)
            $proc.StandardInput.Close()
            $stderr = $proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
            return [PSCustomObject]@{ ExitCode = $proc.ExitCode; StdErr = $stderr }
        }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
        $script:Repo = New-StubRepo
        $script:Marker = Join-Path $script:Repo 'ts-checks-ran.marker'
        # Refusing stub: always exits 1, as the real guard does for a queued PR.
        @'
#!/bin/sh
echo "stub guard: refusing (simulated queued PR)" >&2
exit 1
'@ | Set-Content -Path (Join-Path $script:Repo 'operations/devops/check-queued-push-guard.sh') -NoNewline
        # TS-checks stub: records that it ran, then exits 0.
        $markerPath = $script:Marker -replace '\\', '/'
        @"
#!/bin/sh
touch '$markerPath'
exit 0
"@ | Set-Content -Path (Join-Path $script:Repo 'operations/devops/pre-push-checks.sh') -NoNewline
    }

    AfterEach {
        if ($script:Repo -and (Test-Path $script:Repo)) {
            Remove-Item -Recurse -Force $script:Repo -ErrorAction SilentlyContinue
        }
    }

    It 'runs the queue guard (and refuses) even when AITRIAD_PREPUSH=skip is set' {
        $result = Invoke-Hook -Repo $script:Repo -Env @{ AITRIAD_PREPUSH = 'skip' }
        $result.ExitCode | Should -Be 1
        $result.StdErr | Should -Match 'stub guard: refusing'
    }

    It 'does not run the TypeScript checks when AITRIAD_PREPUSH=skip is set' {
        Invoke-Hook -Repo $script:Repo -Env @{ AITRIAD_PREPUSH = 'skip' } | Out-Null
        Test-Path $script:Marker | Should -Be $false
    }

    It 'runs the TypeScript checks when AITRIAD_PREPUSH is not set (guard refusal short-circuits, so stub the guard to pass)' {
        @'
#!/bin/sh
exit 0
'@ | Set-Content -Path (Join-Path $script:Repo 'operations/devops/check-queued-push-guard.sh') -NoNewline
        $result = Invoke-Hook -Repo $script:Repo -Env @{}
        $result.ExitCode | Should -Be 0
        Test-Path $script:Marker | Should -Be $true
    }
}
