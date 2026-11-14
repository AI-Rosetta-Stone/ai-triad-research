# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms gate for operations/devops/create-coldstore-builder.sh (t/4883, SO p/682#56 C1).
.DESCRIPTION
    Runs the script against a stub `docker` on PATH (no Docker daemon needed). The stub logs each
    `buildx create` and fails it when the image ref contains "does-not-exist", or for the first N
    calls (STUB_FAIL_FIRST). Stubs are written LF-only: a CRLF shebang line breaks on Linux CI.
#>

Describe 'create-coldstore-builder.sh' -Tag 'devops' {

    BeforeAll {
        # Prefer Git for Windows' bash. On Windows, a PATH 'bash' can be the WSL launcher
        # (C:\Windows\System32\bash.exe), which has no distro and exits 127, so it is not used here.
        $script:Bash = @(
            'C:\Program Files\Git\bin\bash.exe'
            (Get-Command bash -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\System32\bash.exe' })?.Source
        ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
        $script:Script = (Resolve-Path (Join-Path $PSScriptRoot '../operations/devops/create-coldstore-builder.sh')).Path

        $script:StubDir = Join-Path ([System.IO.Path]::GetTempPath()) ("coldstore-stub-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:StubDir | Out-Null
        $stub = @(
            '#!/usr/bin/env bash'
            'if [ "$1 $2" = "buildx create" ]; then'
            '  echo "create" >> "$STUB_LOG"'
            '  n=$(wc -l < "$STUB_LOG")'
            '  case "$*" in *does-not-exist*) exit 1 ;; esac'
            '  [ "$n" -le "${STUB_FAIL_FIRST:-0}" ] && exit 1'
            'fi'
            'exit 0'
        ) -join "`n"
        [System.IO.File]::WriteAllText((Join-Path $script:StubDir 'docker'), $stub + "`n", [System.Text.UTF8Encoding]::new($false))

        # A Windows path ('C:\x') in bash's PATH splits on the drive colon; Git-bash wants '/c/x'.
        # Linux paths pass through unchanged.
        function ConvertTo-BashPath([string]$p) {
            $p = $p -replace '\\', '/'
            if ($p -match '^([A-Za-z]):/(.*)$') { return '/' + $Matches[1].ToLower() + '/' + $Matches[2] }
            return $p
        }

        function Invoke-Script([hashtable]$Env) {
            $log = Join-Path $script:StubDir ("calls-" + [guid]::NewGuid().ToString('N') + '.log')
            $assign = @("STUB_LOG='$(ConvertTo-BashPath $log)'", "COLDSTORE_RETRY_DELAY=0")
            foreach ($k in $Env.Keys) { $assign += "$k='$($Env[$k])'" }
            $stubPath = ConvertTo-BashPath $script:StubDir
            $cmd = "chmod +x '$stubPath/docker'; PATH='$stubPath':`"`$PATH`" $($assign -join ' ') bash '$(ConvertTo-BashPath $script:Script)' coldstore-test"
            $out = & $script:Bash -c $cmd 2>&1
            [pscustomobject]@{
                ExitCode = $LASTEXITCODE
                Output   = ($out -join "`n")
                Creates  = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
            }
        }
    }

    AfterAll {
        if ($script:StubDir -and (Test-Path $script:StubDir)) { Remove-Item -Recurse -Force $script:StubDir }
    }

    BeforeEach {
        if (-not $script:Bash) { Set-ItResult -Skipped -Because 'no bash available' }
    }

    It 'a bad image ref exhausts the retries and exits 3 with a distinct INFRA ::error::' {
        $r = Invoke-Script @{ COLDSTORE_BUILDKIT_IMAGE = 'moby/buildkit:does-not-exist' }
        $r.ExitCode | Should -Be 3
        $r.Creates | Should -Be 3
        $r.Output | Should -Match '::error::t/4883 INFRA \(not a guard verdict\)'
    }

    It 'a transient failure is retried and the builder is created (exit 0)' {
        $r = Invoke-Script @{ STUB_FAIL_FIRST = '1' }
        $r.ExitCode | Should -Be 0
        $r.Creates | Should -Be 2
        $r.Output | Should -Match "::warning::t/4883: cold-store builder create attempt 1 of 3 failed"
        $r.Output | Should -Match "cold-store builder 'coldstore-test' ready"
    }

    It 'pins the default BuildKit image by digest, not a mutable tag' {
        $text = Get-Content -Raw $script:Script
        $text | Should -Match "DEFAULT_IMAGE='moby/buildkit:[^'@]+@sha256:[0-9a-f]{64}'"
    }
}
