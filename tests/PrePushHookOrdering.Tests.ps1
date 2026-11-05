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

        # Vars that must NEVER leak in from whatever else ran earlier in this same
        # PowerShell process (Pester runs many test files in one process in CI) --
        # ProcessStartInfo otherwise inherits the full current environment by default,
        # so a sibling test file that sets one of these via `$env:` and never restores
        # it would silently poison every test here that doesn't override it itself.
        # GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_CEILING_DIRECTORIES/GIT_COMMON_DIR
        # would make the hook's own `git rev-parse --show-toplevel` resolve to the REAL
        # checkout instead of the throwaway stub repo, running the real guard/checks
        # scripts instead of the stubs -- exactly the shape of a CI-only, order-dependent
        # failure that passes in isolation.
        $script:IsolatedVars = @(
            'AITRIAD_PREPUSH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
            'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR'
        )

        function Invoke-Hook {
            # Deliberately PowerShell's native `&` call operator, piping stdin in and
            # redirecting stderr to a temp file -- the SAME invocation shape as the
            # already CI-proven-green tests in CheckQueuedPushGuard.Tests.ps1. A raw
            # .NET ProcessStartInfo with all three streams manually redirected (the
            # prior version of this function) hit a Linux-only, unreproducible-on-Windows
            # "Bad fd number" error from the hook's OWN nested `sh "$QUEUE_GUARD"` call --
            # a double-redirected-pipe nesting none of the other tests in this repo do.
            # Confirmed NOT reproducible locally even via the real dash.exe binary
            # through the identical ProcessStartInfo mechanism (t/4858, TL review #2) --
            # switching invocation style sidesteps the unreproducible interaction instead
            # of chasing a platform quirk neither environment here can exhibit.
            param([string]$Repo, [hashtable]$Env)
            $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N') + '.stderr')
            # Env:<name> drive, not [System.Environment]::SetEnvironmentVariable(name, $null) --
            # that coerces $null to an empty string ("") rather than truly unsetting the var,
            # which left GIT_DIR='' exported and broke the hook's OWN `git rev-parse
            # --show-toplevel` (silently resolving $ROOT to '', so every path under it stopped
            # existing and both the guard and the TS-checks step got skipped as "not found").
            $savedEnv = @{}
            foreach ($v in $script:IsolatedVars) {
                $savedEnv[$v] = if (Test-Path "Env:$v") { (Get-Item "Env:$v").Value } else { $null }
            }
            try {
                # Isolation must happen BEFORE this file's own `git` call too -- a leaked
                # GIT_DIR/etc. breaks `git -C $Repo rev-parse HEAD` just as surely as it
                # breaks the hook's internal git calls, not just the hook's own invocation.
                foreach ($v in $script:IsolatedVars) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                foreach ($k in $Env.Keys) { Set-Item "Env:$k" $Env[$k] }
                $headSha = (git -C $Repo rev-parse HEAD).Trim()
                $stdinLine = "refs/heads/feature $headSha refs/heads/feature $headSha"
                # Push-Location, not [Environment]::CurrentDirectory -- confirmed live (debug
                # session, t/4858) that PowerShell's native `&` call operator spawns the child
                # using $PWD, NOT [Environment]::CurrentDirectory; setting only the latter left
                # the hook's own `git rev-parse HEAD` resolving against the ORIGINAL directory,
                # so HEAD_SHA never matched the piped-in local_sha and every check silently
                # skipped as "not the checked-out commit" -- status stayed 0 the whole time.
                Push-Location $Repo
                try {
                    $stdout = $stdinLine | & $script:Sh $script:HookSource 2> $errFile
                    $exitCode = $LASTEXITCODE
                } finally {
                    Pop-Location
                }
            } finally {
                foreach ($v in $script:IsolatedVars) {
                    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
                    if ($null -ne $savedEnv[$v]) { Set-Item "Env:$v" $savedEnv[$v] }
                }
            }
            $stderr = if (Test-Path $errFile) { Get-Content -Path $errFile -Raw -ErrorAction SilentlyContinue } else { '' }
            Remove-Item -Path $errFile -ErrorAction SilentlyContinue
            return [PSCustomObject]@{ ExitCode = $exitCode; StdErr = $stderr; StdOut = ($stdout -join "`n") }
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
