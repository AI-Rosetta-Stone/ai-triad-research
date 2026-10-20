# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Anonymous hosted auth smoke (t/4134): assert the unauthenticated auth surface's positive outcome.
.DESCRIPTION
    Checks, all of which count:
      0. GET /healthz -> 200 (warm-up; staging and idle prod scale to zero)
      1. GET /api/auth/me with no session -> 200, anonymous true, capabilities.write false
      2. PUT /api/taxonomy/accelerationist with no session -> refused 401/403, never 2xx

    WHY THERE IS NO SIGN-IN STEP (t/4134#25, TL re-scope t/4134#26): ACA Easy Auth does not implement
    client-directed sign-in for the GitHub provider. POST /.auth/login/github {access_token} throws
    System.NotImplementedException in GitHubProvider.HandleClientDirectedLoginAsync (500, sub-status 74)
    for any token, with or without a backed token store. An automated signed-in smoke needs a provider
    that supports client-directed sign-in (an Entra test identity: a PI accounts decision, not taken).
    The t/4132 class (token store enabled without storage) is prevented by the t/4133 deploy gate.

    The assertion functions are pure so tests/Test-EasyAuthSmoke.Tests.ps1 can prove both arms.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = ''
)

function Test-AnonMeResponse {
    <# Pure: anonymous /api/auth/me must be a real anonymous session that cannot write. #>
    param([Parameter(Mandatory)][AllowNull()][object]$Me)
    if ($null -eq $Me) { return [PSCustomObject]@{ Pass = $false; Failures = @('no body') } }
    $fail = [System.Collections.Generic.List[string]]::new()
    $anon = if ($Me.PSObject.Properties['anonymous']) { $Me.anonymous } else { $null }
    if ($anon -ne $true) { $fail.Add("anonymous is '$anon', expected true (an unauthenticated request was treated as signed in)") }
    $caps = if ($Me.PSObject.Properties['capabilities']) { $Me.capabilities } else { $null }
    $write = if ($caps -and $caps.PSObject.Properties['write']) { $caps.write } else { $null }
    if ($write -ne $false) { $fail.Add("capabilities.write is '$write', expected false for an anonymous session") }
    return [PSCustomObject]@{ Pass = ($fail.Count -eq 0); Failures = @($fail) }
}

function Test-AnonWriteProbeResponse {
    <# Pure: an unauthenticated mutating request must be refused (401/403), never accepted. #>
    param([Parameter(Mandatory)][int]$StatusCode)
    if ($StatusCode -eq 401 -or $StatusCode -eq 403) { return [PSCustomObject]@{ Pass = $true; Failure = $null } }
    if ($StatusCode -ge 200 -and $StatusCode -lt 300) {
        return [PSCustomObject]@{ Pass = $false; Failure = "anonymous write probe returned $StatusCode — an unauthenticated mutating request was ACCEPTED" }
    }
    return [PSCustomObject]@{ Pass = $false; Failure = "anonymous write probe returned $StatusCode, expected 401/403 from the anonymous gate" }
}

if ($MyInvocation.InvocationName -ne '.') {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot '..' '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
    $Location = 'operations/devops/azure/Test-EasyAuthSmoke.ps1'
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        New-ActionableError -Goal 'Run the anonymous hosted auth smoke' -Problem '-BaseUrl is required.' -Location $Location -NextSteps @('Pass -BaseUrl https://<app>.<env>.azurecontainerapps.io') -Throw
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')
    $failures = [System.Collections.Generic.List[string]]::new()
    $summary = [System.Collections.Generic.List[string]]::new()

    # 0. Warm up: a scaled-to-zero app waits on a cold start (~30-60s); budget stays under the job's 5 minutes.
    $warmDeadline = (Get-Date).AddSeconds(120); $warm = $false; $warmStatus = 'no response'
    while (-not $warm -and (Get-Date) -lt $warmDeadline) {
        try {
            $hz = Invoke-WebRequest -Uri "$BaseUrl/healthz" -SkipHttpErrorCheck -TimeoutSec 45
            $warmStatus = "$($hz.StatusCode)"
            if ($hz.StatusCode -eq 200) { $warm = $true; break }
        } catch { $warmStatus = $_.Exception.Message }
        Start-Sleep -Seconds 10
    }
    $summary.Add("| GET /healthz | $warmStatus |")
    if (-not $warm) { $failures.Add("/healthz never returned 200 within 120s (last: $warmStatus)") }

    # 1. Anonymous identity
    $anonMe = Invoke-WebRequest -Uri "$BaseUrl/api/auth/me" -SkipHttpErrorCheck -TimeoutSec 30
    $summary.Add("| anonymous GET /api/auth/me | $($anonMe.StatusCode) |")
    if ($anonMe.StatusCode -ne 200) { $failures.Add("anonymous /api/auth/me returned $($anonMe.StatusCode), expected 200") }
    else {
        $av = Test-AnonMeResponse -Me ($anonMe.Content | ConvertFrom-Json)
        foreach ($f in $av.Failures) { $failures.Add("anonymous /api/auth/me: $f") }
    }

    # 2. Anonymous write must be refused
    $anonProbe = Invoke-WebRequest -Method Put -Uri "$BaseUrl/api/taxonomy/accelerationist" -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck -TimeoutSec 30
    $anonReason = if ($anonProbe.Headers['X-Auth-Reason']) { [string]@($anonProbe.Headers['X-Auth-Reason'])[0] } else { '' }
    $summary.Add("| anonymous write probe PUT /api/taxonomy/accelerationist | $($anonProbe.StatusCode) $anonReason |")
    $ap = Test-AnonWriteProbeResponse -StatusCode ([int]$anonProbe.StatusCode)
    if (-not $ap.Pass) { $failures.Add($ap.Failure) }

    if ($env:GITHUB_STEP_SUMMARY) {
        $verdict = if ($failures.Count) { "❌ FAILED ($($failures.Count))" } else { '✅ passed' }
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value (@("## Anonymous auth smoke (t/4134): $verdict on $BaseUrl", '', '| Step | Result |', '|---|---|') + $summary + @('') + ($failures | ForEach-Object { "- $_" })) -Encoding utf8
    }
    if ($failures.Count) {
        foreach ($f in $failures) { Write-Host "::error title=t/4134 anonymous auth smoke::$f" }
        exit 1
    }
    Write-Host "t/4134 anonymous auth smoke passed on ${BaseUrl}: /healthz 200, /me anonymous with write:false, anonymous write refused ($($anonProbe.StatusCode))."
}
