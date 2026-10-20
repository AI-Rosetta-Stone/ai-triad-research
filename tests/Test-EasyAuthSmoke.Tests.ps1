# Both-arms proof for the anonymous hosted auth smoke's assertions (t/4134). Dot-sources the SAME
# script auth-smoke.yml runs, so the gate and its proof cannot diverge (t/3010 co-location pattern).
# Fixture shapes follow /api/auth/me on origin/main (routes/session.ts: anonymous, capabilities.write)
# and the live staging responses recorded on t/4134 (anonymous /me 200; anonymous PUT 401 no_session).
# The signed-in assertions were removed with the sign-in step: ACA Easy Auth does not implement
# client-directed GitHub sign-in (t/4134#25, TL re-scope t/4134#26).

BeforeAll {
    . "$PSScriptRoot/../operations/devops/azure/Test-EasyAuthSmoke.ps1"
}

Describe 'Test-AnonMeResponse (t/4134)' {
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
        $r = Test-AnonMeResponse -Me $me
        $r.Pass | Should -BeFalse; ($r.Failures -join ' ') | Should -Match 'capabilities.write'
    }
    It 'FIRE: anonymous field missing' {
        $me = '{"capabilities":{"write":false}}' | ConvertFrom-Json
        (Test-AnonMeResponse -Me $me).Pass | Should -BeFalse
    }
    It 'FIRE: capabilities missing (write not proven false)' {
        $me = '{"anonymous":true}' | ConvertFrom-Json
        (Test-AnonMeResponse -Me $me).Pass | Should -BeFalse
    }
    It 'FIRE: null body' {
        (Test-AnonMeResponse -Me $null).Pass | Should -BeFalse
    }
}

Describe 'Test-AnonWriteProbeResponse (t/4134)' {
    It 'PASS: 401 (live staging: no_session)' {
        (Test-AnonWriteProbeResponse -StatusCode 401).Pass | Should -BeTrue
    }
    It 'PASS: 403' {
        (Test-AnonWriteProbeResponse -StatusCode 403).Pass | Should -BeTrue
    }
    It 'FIRE: accepted (2xx)' {
        $r = Test-AnonWriteProbeResponse -StatusCode 200
        $r.Pass | Should -BeFalse; $r.Failure | Should -Match 'ACCEPTED'
    }
    It 'FIRE: 204 is also an accept' {
        (Test-AnonWriteProbeResponse -StatusCode 204).Failure | Should -Match 'ACCEPTED'
    }
    It 'FIRE: 428/500 (not the anonymous gate)' {
        (Test-AnonWriteProbeResponse -StatusCode 428).Pass | Should -BeFalse
        (Test-AnonWriteProbeResponse -StatusCode 500).Pass | Should -BeFalse
    }
}
