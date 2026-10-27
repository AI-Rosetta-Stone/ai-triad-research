# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Proves the t/4513 incident (run 40358394585) can't recur silently: every command the
deploy workflow's mount-readiness probe step calls actually resolves from the exact
scope that step runs in -- `Import-Module` only, no dot-sourcing, no prior session state.

.DESCRIPTION
The incident: deploy-azure.yml's probe step called New-AnonymousWebSession,
Invoke-RemoteCheck and Test-DataPresenceAssertion directly. Those are module-Private --
invisible outside the module -- so every one of 13 attempts failed with "not recognized"
and read as "mount not ready", rolling prod back on a false negative. t/4513#1's original
9/10 Pester suite covered Get-MountReadinessVerdict.ps1's pure retry logic only; nothing
ever actually invoked the probe's real PowerShell commands the way the workflow does.

This test closes that gap: it launches a FRESH pwsh CHILD PROCESS (a clean scope, the
same isolation boundary the real workflow step has -- this session's own loaded module
state, dot-sourced helpers, etc. must never leak in and mask the bug) that does exactly
what the workflow does: `Import-Module ./scripts/AITriad/AITriad.psm1 -Force`, then calls
`Test-TaxEditorMountReadiness`. HTTP calls are mocked at the lowest level that still
exercises real command resolution (a local HttpListener stand-in is overkill for this
repo's conventions; instead we point BaseUrl at an unroutable address with a very short
timeout and assert the FAILURE MODE is a timeout/connection error, never
CommandNotFoundException -- the one failure mode this test exists to catch).
#>

BeforeAll {
    $script:RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
    $script:PwshPath = (Get-Command pwsh).Source
}

Describe 'Test-TaxEditorMountReadiness -- real command resolution (t/4513 incident proof-arm)' {

    It 'resolves and runs from a fresh child process with ONLY Import-Module in scope (no dot-sourcing)' {
        # Deliberately minimal script, mirroring deploy-azure.yml's actual run: block shape.
        # 10.255.255.1 is a non-routable TEST-NET-adjacent address chosen to fail fast
        # (connection refused/timeout) rather than hang or accidentally succeed.
        $probeScript = @'
Import-Module "{0}/scripts/AITriad/AITriad.psm1" -Force
try {{
    $result = Test-TaxEditorMountReadiness -BaseUrl 'http://10.255.255.1' -TimeoutSec 2
    Write-Output "RESULT:$($result.Ready)"
}} catch [System.Management.Automation.CommandNotFoundException] {{
    Write-Output "COMMAND_NOT_FOUND:$($_.Exception.Message)"
    exit 1
}} catch {{
    # In practice this arm is NOT the expected outcome against an unroutable address: the
    # cmdlet's HTTP layer (Invoke-RemoteCheck / New-AnonymousWebSession) catches timeouts,
    # connection-refused and DNS failures internally and returns Ready=$false -- the RESULT:
    # branch above is what actually fires. This catch exists only as a safety net for an
    # exception type neither arm anticipated; reaching it still proves the COMMAND resolved
    # and ran (the one thing this test asserts), so it's treated as a pass either way.
    Write-Output "OTHER_EXCEPTION:$($_.Exception.GetType().Name)"
    exit 0
}}
'@ -f $script:RepoRoot

        $tempScriptPath = [System.IO.Path]::GetTempFileName() + '.ps1'
        try {
            Set-Content -Path $tempScriptPath -Value $probeScript -Encoding UTF8
            $output = & $script:PwshPath -NoProfile -NonInteractive -File $tempScriptPath 2>&1
            $exitCode = $LASTEXITCODE

            ($output -join "`n") | Should -Not -Match 'COMMAND_NOT_FOUND'
            ($output -join "`n") | Should -Not -Match 'not recognized as the name of a cmdlet'
            $exitCode | Should -Be 0
        } finally {
            Remove-Item -Path $tempScriptPath -ErrorAction SilentlyContinue
        }
    }

    It 'FAILS this way if New-AnonymousWebSession/Invoke-RemoteCheck/Test-DataPresenceAssertion are called directly (the actual t/4513 incident shape) -- proof the test catches the real bug' {
        # Reproduces the EXACT broken step body from run 40358394585, byte-for-byte in
        # shape, to prove this test suite would have caught it before merge.
        $brokenScript = @'
Import-Module "{0}/scripts/AITriad/AITriad.psm1" -Force
try {{
    $Session = New-AnonymousWebSession -BaseUrl 'http://10.255.255.1' -TimeoutSec 2
    Write-Output "RESULT:unexpected-success"
}} catch [System.Management.Automation.CommandNotFoundException] {{
    Write-Output "COMMAND_NOT_FOUND:$($_.Exception.Message)"
    exit 1
}} catch {{
    Write-Output "OTHER_EXCEPTION:$($_.Exception.GetType().Name)"
    exit 0
}}
'@ -f $script:RepoRoot

        $tempScriptPath = [System.IO.Path]::GetTempFileName() + '.ps1'
        try {
            Set-Content -Path $tempScriptPath -Value $brokenScript -Encoding UTF8
            $output = & $script:PwshPath -NoProfile -NonInteractive -File $tempScriptPath 2>&1
            $exitCode = $LASTEXITCODE

            # This asserts the INCIDENT SHAPE still fails exactly as it did in production --
            # confirming New-AnonymousWebSession really is Private (not accidentally exported),
            # so Test-TaxEditorMountReadiness's wrapper is the only thing bridging that gap.
            ($output -join "`n") | Should -Match 'COMMAND_NOT_FOUND'
            $exitCode | Should -Be 1
        } finally {
            Remove-Item -Path $tempScriptPath -ErrorAction SilentlyContinue
        }
    }
}
