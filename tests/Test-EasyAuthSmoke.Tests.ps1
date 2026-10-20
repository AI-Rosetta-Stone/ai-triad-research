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

Describe 'Test-ShouldSendWriteProbe — probe self-gating (t/4134, SO C1)' {
    It 'SEND: /me proved read-only' {
        Test-ShouldSendWriteProbe -MeVerdict (Test-AuthMeResponse -Me (New-Me) -ExpectedLogin 'ai-triad-smoke') | Should -BeTrue
    }
    It 'SKIP: /me shows readOnly false (READ_ONLY_PRINCIPALS not live) — no mutating request' {
        Test-ShouldSendWriteProbe -MeVerdict (Test-AuthMeResponse -Me (New-Me @{ readOnly = $false }) -ExpectedLogin 'ai-triad-smoke') | Should -BeFalse
    }
    It 'SKIP: /me shows write true' {
        Test-ShouldSendWriteProbe -MeVerdict (Test-AuthMeResponse -Me (New-Me @{ capabilities = @{ write = $true } }) -ExpectedLogin 'ai-triad-smoke') | Should -BeFalse
    }
    It 'SKIP: /me never returned 200 (no verdict)' {
        Test-ShouldSendWriteProbe -MeVerdict $null | Should -BeFalse
    }
}

Describe 'Get-SignInFailureClass — token rejected vs t/4132 outage (t/4134, SO rec.)' {
    It '401 -> token rejected, explicitly NOT the t/4132 class' {
        $m = Get-SignInFailureClass -StatusCode 401
        $m | Should -Match 'rejected'; $m | Should -Match 'NOT the t/4132'
    }
    It '403 -> token rejected' {
        Get-SignInFailureClass -StatusCode 403 | Should -Match 'rejected'
    }
    It '500 -> Easy Auth pipeline failing (the t/4132 class)' {
        $m = Get-SignInFailureClass -StatusCode 500
        $m | Should -Match 'the t/4132 class'; $m | Should -Not -Match 'NOT the'
    }
    It '302/other -> unexpected response' {
        Get-SignInFailureClass -StatusCode 302 | Should -Match 'unexpected'
    }
}

Describe 'Anonymous subset — interim (d) (t/4134)' {
    It 'PASS: anonymous /me (live staging shape: anonymous true, write false)' {
        $me = '{"user":"_anonymous","idp":"","anonymous":true,"readOnly":false,"capabilities":{"ai":false,"write":false}}' | ConvertFrom-Json
        (Test-AnonMeResponse -Me $me).Pass | Should -BeTrue
    }
    It 'FIRE: an unauthenticated request reported as signed in' {
        $me = '{"user":"someone","anonymous":false,"capabilities":{"write":true}}' | ConvertFrom-Json
        (Test-AnonMeResponse -Me $me).Pass | Should -BeFalse
    }
    It 'FIRE: anonymous but write true' {
        $me = '{"anonymous":true,"capabilities":{"write":true}}' | ConvertFrom-Json
        (Test-AnonMeResponse -Me $me).Pass | Should -BeFalse
    }
    It 'PASS: anonymous write probe 401 (live staging: no_session)' {
        (Test-AnonWriteProbeResponse -StatusCode 401).Pass | Should -BeTrue
    }
    It 'PASS: anonymous write probe 403' {
        (Test-AnonWriteProbeResponse -StatusCode 403).Pass | Should -BeTrue
    }
    It 'FIRE: anonymous write probe accepted (2xx)' {
        $r = Test-AnonWriteProbeResponse -StatusCode 200
        $r.Pass | Should -BeFalse; $r.Failure | Should -Match 'ACCEPTED'
    }
    It 'FIRE: anonymous write probe 428/500 (not the anonymous gate)' {
        (Test-AnonWriteProbeResponse -StatusCode 428).Pass | Should -BeFalse
        (Test-AnonWriteProbeResponse -StatusCode 500).Pass | Should -BeFalse
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
