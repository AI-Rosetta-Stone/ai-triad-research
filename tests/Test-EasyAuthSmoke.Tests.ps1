# Both-arms proof for the signed-in hosted smoke's assertions (t/4134). Dot-sources the SAME script
# auth-smoke.yml runs, so the gate and its proof cannot diverge (t/3010 co-location pattern).
# Fixture shapes follow /api/auth/me on origin/main (routes/session.ts: user, idp, anonymous,
# readOnly, capabilities.write = signed-in && !readOnly) and the t/4296 guard's 403
# (readOnlyGuard.ts: X-Auth-Reason read_only, body {"error":"read_only"}).

BeforeAll {
    . "$PSScriptRoot/../operations/devops/azure/Test-EasyAuthSmoke.ps1"
    function New-Me([hashtable]$Over = @{}) {
        $m = @{ user = 'ai-triad-smoke'; idp = 'github'; anonymous = $false; readOnly = $true; capabilities = @{ ai = $true; write = $false } }
        foreach ($k in $Over.Keys) { $m[$k] = $Over[$k] }
        ($m | ConvertTo-Json -Depth 4) | ConvertFrom-Json
    }
}

Describe 'Test-AuthMeResponse (t/4134)' {
    It 'PASS: signed-in, read-only smoke identity' {
        (Test-AuthMeResponse -Me (New-Me) -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeTrue
    }
    It 'PASS: login match is case-insensitive' {
        (Test-AuthMeResponse -Me (New-Me @{ user = 'AI-Triad-Smoke' }) -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeTrue
    }
    It 'FIRE: anonymous session (sign-in did not take)' {
        $r = Test-AuthMeResponse -Me (New-Me @{ anonymous = $true }) -ExpectedLogin 'ai-triad-smoke'
        $r.Pass | Should -BeFalse; ($r.Failures -join ' ') | Should -Match 'anonymous'
    }
    It 'FIRE: a different user' {
        (Test-AuthMeResponse -Me (New-Me @{ user = '_local' }) -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeFalse
    }
    It 'FIRE: wrong idp' {
        (Test-AuthMeResponse -Me (New-Me @{ idp = 'aad' }) -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeFalse
    }
    It 'FIRE: readOnly false (READ_ONLY_PRINCIPALS not live)' {
        $r = Test-AuthMeResponse -Me (New-Me @{ readOnly = $false }) -ExpectedLogin 'ai-triad-smoke'
        $r.Pass | Should -BeFalse; ($r.Failures -join ' ') | Should -Match 't/4296'
    }
    It 'FIRE: readOnly missing entirely (pre-#3429 server)' {
        $me = New-Me; $me.PSObject.Properties.Remove('readOnly')
        (Test-AuthMeResponse -Me $me -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeFalse
    }
    It 'FIRE: capabilities.write true' {
        (Test-AuthMeResponse -Me (New-Me @{ capabilities = @{ ai = $true; write = $true } }) -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeFalse
    }
    It 'FIRE: null body' {
        (Test-AuthMeResponse -Me $null -ExpectedLogin 'ai-triad-smoke').Pass | Should -BeFalse
    }
}

Describe 'Test-ReadOnlyProbeResponse (t/4134)' {
    It 'PASS: 403 with X-Auth-Reason read_only' {
        (Test-ReadOnlyProbeResponse -StatusCode 403 -AuthReason 'read_only' -Body '').Pass | Should -BeTrue
    }
    It 'PASS: 403 with body error read_only (header stripped by a proxy)' {
        (Test-ReadOnlyProbeResponse -StatusCode 403 -AuthReason '' -Body '{"error":"read_only","message":"x"}').Pass | Should -BeTrue
    }
    It 'FIRE: 2xx — the guard let a mutating route through' {
        $r = Test-ReadOnlyProbeResponse -StatusCode 200 -AuthReason '' -Body '{}'
        $r.Pass | Should -BeFalse; $r.Failure | Should -Match 'did NOT block'
    }
    It 'FIRE: 428/400 — rejected by the save route itself, not the read-only guard' {
        (Test-ReadOnlyProbeResponse -StatusCode 428 -AuthReason '' -Body '{"error":"baseSha required"}').Pass | Should -BeFalse
    }
    It 'FIRE: 403 for another reason (e.g. allowlist), not read_only' {
        (Test-ReadOnlyProbeResponse -StatusCode 403 -AuthReason 'user_not_in_allowlist' -Body 'Forbidden').Pass | Should -BeFalse
    }
}
