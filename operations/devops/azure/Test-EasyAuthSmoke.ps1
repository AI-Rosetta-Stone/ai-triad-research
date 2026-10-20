# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Signed-in hosted smoke (t/4134): sign in through Easy Auth as the read-only smoke identity and
    assert the positive outcome, not just "responds".
.DESCRIPTION
    t/4132: every signed-in user got HTTP 500 from Easy Auth for ~35 min while the anonymous smokes
    stayed green. This exercises the Easy Auth sign-in pipeline itself:
      1. POST /.auth/login/github {access_token}  -> 200 with an authenticationToken
      2. GET  /api/auth/me (X-ZUMO-AUTH)          -> 200, user == ai-triad-smoke, idp github,
                                                     anonymous false, readOnly true, write false
      3. PUT  /api/taxonomy/accelerationist with NO If-Match -> 403 read_only (t/4296 guard)
    Step 3 is SELF-GATED (SO C1, #3497): it is sent only after step 2 has proved readOnly:true and
    write:false, so "never writes" does not rest on another role's handler ordering. Even then it has
    a second line of defence: with no If-Match header, the save route's requireBaseVersion rejects it
    before ensureSessionBranch() would run.

    The GitHub token comes from $env:SMOKE_GH_TOKEN (an Actions secret) and is never printed; the
    Easy Auth session token is masked in the Actions log. Run only after t/4296 (READ_ONLY_PRINCIPALS)
    is deployed to the target, per the TL (t/4134#9).

    The assertion functions are pure so tests/Test-EasyAuthSmoke.Tests.ps1 can prove both arms.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = '',
    [string]$ExpectedLogin = 'ai-triad-smoke'
)

function Test-AuthMeResponse {
    <# Pure: does a /api/auth/me body prove a real, read-only, signed-in session for $ExpectedLogin? #>
    param([Parameter(Mandatory)][AllowNull()][object]$Me, [Parameter(Mandatory)][string]$ExpectedLogin)
    $fail = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $Me) { return [PSCustomObject]@{ Pass = $false; Failures = @('no /api/auth/me body') } }
    $get = { param($n) if ($Me.PSObject.Properties[$n]) { $Me.$n } else { $null } }
    if (-not [string]::Equals([string](& $get 'user'), $ExpectedLogin, [StringComparison]::OrdinalIgnoreCase)) { $fail.Add("user is '$(& $get 'user')', expected '$ExpectedLogin'") }
    if ((& $get 'anonymous') -ne $false) { $fail.Add("anonymous is '$(& $get 'anonymous')', expected false (sign-in did not take)") }
    if ([string](& $get 'idp') -ne 'github') { $fail.Add("idp is '$(& $get 'idp')', expected 'github'") }
    if ((& $get 'readOnly') -ne $true) { $fail.Add("readOnly is '$(& $get 'readOnly')', expected true (t/4296 READ_ONLY_PRINCIPALS not live?)") }
    $caps = & $get 'capabilities'
    $write = if ($caps -and $caps.PSObject.Properties['write']) { $caps.write } else { $null }
    if ($write -ne $false) { $fail.Add("capabilities.write is '$write', expected false") }
    return [PSCustomObject]@{ Pass = ($fail.Count -eq 0); Failures = @($fail) }
}

function Get-SignInFailureClass {
    <# Pure: classify a failed Easy Auth sign-in so a dead token isn't reported as the t/4132 outage. #>
    param([Parameter(Mandatory)][int]$StatusCode)
    if ($StatusCode -eq 401 -or $StatusCode -eq 403) {
        return "sign-in returned $StatusCode — SMOKE_GH_TOKEN was rejected (expired or revoked?); rotate it. This is NOT the t/4132 Easy Auth outage class."
    }
    if ($StatusCode -ge 500) {
        return "sign-in returned $StatusCode — the Easy Auth pipeline itself is failing (the t/4132 class)."
    }
    return "sign-in returned $StatusCode with no authenticationToken — unexpected Easy Auth response."
}

function Test-ShouldSendWriteProbe {
    <# Pure (SO C1): send the write probe ONLY when /api/auth/me has already proved read-only. #>
    param([Parameter(Mandatory)][AllowNull()][object]$MeVerdict)
    return [bool]($MeVerdict -and $MeVerdict.Pass)
}

function Test-ReadOnlyProbeResponse {
    <# Pure: did the write probe get the t/4296 read-only rejection (and nothing weaker)? #>
    param([Parameter(Mandatory)][int]$StatusCode, [AllowNull()][string]$AuthReason, [AllowNull()][string]$Body)
    if ($StatusCode -ge 200 -and $StatusCode -lt 300) {
        return [PSCustomObject]@{ Pass = $false; Failure = "write probe returned $StatusCode — the read-only guard did NOT block a mutating route" }
    }
    $bodyReadOnly = $Body -and ($Body -match '"error"\s*:\s*"read_only"')
    if ($StatusCode -eq 403 -and ($AuthReason -eq 'read_only' -or $bodyReadOnly)) {
        return [PSCustomObject]@{ Pass = $true; Failure = $null }
    }
    return [PSCustomObject]@{ Pass = $false; Failure = "write probe returned $StatusCode (X-Auth-Reason '$AuthReason'), expected 403 read_only — rejected by something other than the read-only guard" }
}

if ($MyInvocation.InvocationName -ne '.') {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot '..' '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
    $Location = 'operations/devops/azure/Test-EasyAuthSmoke.ps1'
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        New-ActionableError -Goal 'Run the signed-in hosted smoke' -Problem '-BaseUrl is required.' -Location $Location -NextSteps @('Pass -BaseUrl https://<app>.<env>.azurecontainerapps.io') -Throw
    }
    if ([string]::IsNullOrWhiteSpace($env:SMOKE_GH_TOKEN)) {
        New-ActionableError -Goal 'Sign in as the smoke identity' -Problem 'SMOKE_GH_TOKEN is not set.' -Location $Location -NextSteps @('Run from auth-smoke.yml, which maps the SMOKE_GH_TOKEN Actions secret into the environment') -Throw
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')
    $failures = [System.Collections.Generic.List[string]]::new()
    $summary = [System.Collections.Generic.List[string]]::new()

    # 1. Easy Auth client-directed sign-in
    $zumo = $null
    try {
        $login = Invoke-WebRequest -Method Post -Uri "$BaseUrl/.auth/login/github" -ContentType 'application/json' `
            -Body (@{ access_token = $env:SMOKE_GH_TOKEN } | ConvertTo-Json -Compress) -SkipHttpErrorCheck -TimeoutSec 30
        $summary.Add("| sign-in POST /.auth/login/github | $($login.StatusCode) |")
        if ($login.StatusCode -eq 200) {
            $zumo = ($login.Content | ConvertFrom-Json).authenticationToken
            if ($zumo) { Write-Host "::add-mask::$zumo" }
        }
        if (-not $zumo) { $failures.Add((Get-SignInFailureClass -StatusCode ([int]$login.StatusCode))) }
    } catch {
        $failures.Add("sign-in request failed: $($_.Exception.Message)")
    }

    if ($zumo) {
        $h = @{ 'X-ZUMO-AUTH' = $zumo }
        # 2. Authenticated identity + read-only tier
        $me = Invoke-WebRequest -Uri "$BaseUrl/api/auth/me" -Headers $h -SkipHttpErrorCheck -TimeoutSec 30
        $summary.Add("| GET /api/auth/me | $($me.StatusCode) |")
        $v = $null
        if ($me.StatusCode -ne 200) { $failures.Add("/api/auth/me returned $($me.StatusCode) for a signed-in session (t/4132 returned 500 here)") }
        else {
            $v = Test-AuthMeResponse -Me ($me.Content | ConvertFrom-Json) -ExpectedLogin $ExpectedLogin
            foreach ($f in $v.Failures) { $failures.Add("/api/auth/me: $f") }
        }
        # 3. Write probe — only once /me has proved read-only (SO C1); no If-Match, so it can't write
        if (Test-ShouldSendWriteProbe -MeVerdict $v) {
            $probe = Invoke-WebRequest -Method Put -Uri "$BaseUrl/api/taxonomy/accelerationist" -Headers $h -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck -TimeoutSec 30
            $reason = if ($probe.Headers['X-Auth-Reason']) { [string]@($probe.Headers['X-Auth-Reason'])[0] } else { '' }
            $summary.Add("| write probe PUT /api/taxonomy/accelerationist (no If-Match) | $($probe.StatusCode) $reason |")
            $p = Test-ReadOnlyProbeResponse -StatusCode ([int]$probe.StatusCode) -AuthReason $reason -Body ([string]$probe.Content)
            if (-not $p.Pass) { $failures.Add($p.Failure) }
        } else {
            $summary.Add('| write probe | SKIPPED — /api/auth/me did not prove read-only |')
            $failures.Add('write probe skipped: /api/auth/me did not prove readOnly:true and write:false, so no mutating request was sent (SO C1)')
        }
    }

    if ($env:GITHUB_STEP_SUMMARY) {
        $verdict = if ($failures.Count) { "❌ FAILED ($($failures.Count))" } else { '✅ passed' }
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value (@("## Signed-in smoke (t/4134): $verdict on $BaseUrl", '', '| Step | Result |', '|---|---|') + $summary + @('') + ($failures | ForEach-Object { "- $_" })) -Encoding utf8
    }
    if ($failures.Count) {
        foreach ($f in $failures) { Write-Host "::error title=t/4134 signed-in smoke::$f" }
        exit 1
    }
    Write-Host "t/4134 signed-in smoke passed on $BaseUrl (user $ExpectedLogin, read-only, write probe 403 read_only)"
}
