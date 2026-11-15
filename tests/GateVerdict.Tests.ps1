# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4496: the three-state gate verdict helper (PASS / FAIL / GATE-UNREADABLE).
# The share-specific worked example lives in tests/Test-ProdStagingDigestParity.Tests.ps1.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'GateVerdict.ps1')
}

Describe 'New-GateVerdict' {
    It 'builds PASS and FAIL verdicts; the reason is optional for them' {
        (New-GateVerdict -Gate 'g' -Verdict 'PASS').Verdict | Should -Be 'PASS'
        (New-GateVerdict -Gate 'g' -Verdict 'FAIL' -Reason 'found it').Reason | Should -Be 'found it'
    }

    It 'refuses GATE-UNREADABLE without a reason (actionable error, not a silent verdict)' {
        { New-GateVerdict -Gate 'g' -Verdict 'GATE-UNREADABLE' -Reason ' ' } | Should -Throw -ExpectedMessage '*Error:*no reason*'
    }

    It 'refuses a value outside the three verdicts' {
        { New-GateVerdict -Gate 'g' -Verdict 'OK' } | Should -Throw
        { New-GateVerdict -Gate 'g' -Verdict 'SKIPPED' } | Should -Throw
    }

    It 'flattens a multi-line reason to one line' {
        (New-GateVerdict -Gate 'g' -Verdict 'FAIL' -Reason "a`r`nverdict=PASS").Reason | Should -Be 'a verdict=PASS'
    }
}

Describe 'Get-GateReadFailureReason' {
    It 'classifies <Expected>' -ForEach @(
        @{ Text = "ERROR: (AuthorizationFailed) The client 'x' does not have authorization to perform action"; Expected = 'access denied (403)' }
        @{ Text = 'This request is not authorized to perform this operation using this permission. AuthorizationPermissionMismatch'; Expected = 'access denied (403)' }
        @{ Text = 'Response status code does not indicate success: 403 (Forbidden).'; Expected = 'access denied (403)' }
        @{ Text = "ERROR: Please run 'az login' to setup account."; Expected = 'authentication failed (401)' }
        @{ Text = 'AADSTS700213: No matching federated identity record found'; Expected = 'authentication failed (401)' }
        @{ Text = 'ERROR: (ResourceNotFound) The Resource was not found.'; Expected = 'target not found (404)' }
        @{ Text = 'Get-Content: Cannot find path because it does not exist.'; Expected = 'target not found (404)' }
        @{ Text = 'TooManyRequests'; Expected = 'throttled (429)' }
        @{ Text = 'The operation timed out'; Expected = 'service unavailable or timed out' }
        @{ Text = 'something odd'; Expected = 'read failed' }
    ) {
        Get-GateReadFailureReason -ErrorText $Text | Should -BeLike "${Expected}:*"
    }

    It 'says so when no error text was captured' {
        Get-GateReadFailureReason -ErrorText '' | Should -Be 'read failed (no error text captured)'
    }

    It 'truncates long error text' {
        $r = Get-GateReadFailureReason -ErrorText ('x' * 1000) -MaxLength 50
        $r | Should -BeLike '*...'
        $r.Length | Should -BeLessThan 80
    }
}

Describe 'Write-GateVerdict' {
    BeforeEach {
        $out = Join-Path $TestDrive 'out.txt'
        $sum = Join-Path $TestDrive 'sum.md'
        Remove-Item $out, $sum -ErrorAction SilentlyContinue
    }

    It 'PASS arm: writes verdict=PASS to the output and a PASS block to the summary' {
        Write-GateVerdict -Verdict (New-GateVerdict -Gate 'demo' -Verdict 'PASS') -OutputPath $out -SummaryPath $sum -SuppressAnnotations
        Get-Content $out | Should -Be @('gate=demo', 'verdict=PASS', 'reason=')
        Get-Content $sum -Raw | Should -Match '### Gate verdict: demo'
        Get-Content $sum -Raw | Should -Match '\*\*PASS\*\* \(read the target; nothing wrong found\)'
    }

    It 'FAIL arm: writes verdict=FAIL with the reason and details' {
        $v = New-GateVerdict -Gate 'demo' -Verdict 'FAIL' -Reason 'drift' -Details @('one', 'two')
        Write-GateVerdict -Verdict $v -OutputPath $out -SummaryPath $sum -SuppressAnnotations
        Get-Content $out | Should -Contain 'verdict=FAIL'
        Get-Content $out | Should -Contain 'reason=drift'
        Get-Content $sum -Raw | Should -Match "- one`n- two"
    }

    It 'UNREADABLE arm: a simulated 403 writes verdict=GATE-UNREADABLE with the classified reason' {
        $reason = Get-GateReadFailureReason -ErrorText "ERROR: (AuthorizationFailed) does not have authorization`nCode: AuthorizationFailed"
        Write-GateVerdict -Verdict (New-GateVerdict -Gate 'demo' -Verdict 'GATE-UNREADABLE' -Reason $reason) -OutputPath $out -SummaryPath $sum -SuppressAnnotations
        Get-Content $out | Should -Contain 'verdict=GATE-UNREADABLE'
        (Get-Content $out | Where-Object { $_ -like 'reason=*' }) | Should -BeLike 'reason=access denied (403): *'
        Get-Content $sum -Raw | Should -Match 'could NOT read the target; this is no verdict, not a pass'
    }

    It 'emits a ::warning:: annotation for FAIL and GATE-UNREADABLE, a plain line for PASS' {
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $lines.Add([string]$Object) }
        Write-GateVerdict -Verdict (New-GateVerdict -Gate 'd' -Verdict 'PASS') -OutputPath $out -SummaryPath $sum
        Write-GateVerdict -Verdict (New-GateVerdict -Gate 'd' -Verdict 'FAIL') -OutputPath $out -SummaryPath $sum
        Write-GateVerdict -Verdict (New-GateVerdict -Gate 'd' -Verdict 'GATE-UNREADABLE' -Reason 'r') -OutputPath $out -SummaryPath $sum
        $lines[0] | Should -Be 'GATE-VERDICT d: PASS'
        $lines[1] | Should -Be '::warning title=FAIL::d: FAIL'
        $lines[2] | Should -Be '::warning title=GATE-UNREADABLE::d: GATE-UNREADABLE - r'
    }

    It 'with no sink paths (a local run) logs a WARN per sink and does not throw' {
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $lines.Add([string]$Object) }
        { Write-GateVerdict -Verdict (New-GateVerdict -Gate 'd' -Verdict 'PASS') -OutputPath '' -SummaryPath '' } | Should -Not -Throw
        @($lines | Where-Object { $_ -like 'WARN:*not set*' }).Count | Should -Be 2
    }

    It 'a sink write failure is a WARN, not a throw' {
        $lines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host { $lines.Add([string]$Object) }
        $bad = Join-Path $TestDrive 'no-such-dir' 'out.txt'
        { Write-GateVerdict -Verdict (New-GateVerdict -Gate 'd' -Verdict 'FAIL') -OutputPath $bad -SummaryPath $sum } | Should -Not -Throw
        @($lines | Where-Object { $_ -like 'WARN: could not write the gate verdict to GITHUB_OUTPUT*' }).Count | Should -Be 1
    }
}
