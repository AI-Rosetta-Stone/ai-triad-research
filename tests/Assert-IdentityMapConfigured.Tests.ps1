# Both-arms proof for the t/4326 IDENTITY_MAP deploy preflight (TL p/404#119). Dot-sources the SAME
# script deploy-azure.yml / deploy-staging.yml run, so the gate and its proof cannot diverge.

BeforeAll {
    $script = "$PSScriptRoot/../operations/devops/azure/Assert-IdentityMapConfigured.ps1"
    . $script
    $req = @('github:6188114')
}

Describe 'Test-IdentityMapValue (t/4326)' {
    It 'PASS: required entry present, names with spaces and @ allowed' {
        $v = Test-IdentityMapValue -Value 'github:6188114=jpsnover,github:42=alex franco,github:7=rich@gillin.us' -RequiredKeys $req
        $v.Pass | Should -BeTrue
    }
    It 'PASS: tolerates whitespace around entries' {
        (Test-IdentityMapValue -Value ' github:6188114=jpsnover , github:42=alex franco ' -RequiredKeys $req).Pass | Should -BeTrue
    }
    It 'FIRE: empty value (the silent fail-open this gate exists for)' {
        $v = Test-IdentityMapValue -Value '' -RequiredKeys $req
        $v.Pass | Should -BeFalse; ($v.Problems -join ' ') | Should -Match 'empty or unset'
    }
    It 'FIRE: whitespace-only value' {
        (Test-IdentityMapValue -Value '   ' -RequiredKeys $req).Pass | Should -BeFalse
    }
    It 'FIRE: required entry missing' {
        $v = Test-IdentityMapValue -Value 'github:42=alex franco' -RequiredKeys $req
        $v.Pass | Should -BeFalse; ($v.Problems -join ' ') | Should -Match "required entry 'github:6188114=' is missing"
    }
    It 'FIRE: required key present but mapped to an empty name' {
        (Test-IdentityMapValue -Value 'github:6188114=' -RequiredKeys $req).Pass | Should -BeFalse
    }
    It 'FIRE: a prefix of the required id is not a match (github:61881140)' {
        (Test-IdentityMapValue -Value 'github:61881140=someone' -RequiredKeys $req).Pass | Should -BeFalse
    }
    It 'FIRE: malformed entry (no =, no idp)' {
        $v = Test-IdentityMapValue -Value 'github:6188114=jpsnover,alexfranco' -RequiredKeys $req
        $v.Pass | Should -BeFalse; ($v.Problems -join ' ') | Should -Match 'malformed'
    }
}

Describe 'Assert-IdentityMapConfigured script modes (t/4326)' {
    # Run in a child pwsh exactly the way GitHub Actions' `shell: pwsh` does, and assert the real
    # process exit code — the property the deploy actually depends on.
    It 'Fail mode: an empty value exits 1 (prod preflight blocks the deploy)' {
        $null = pwsh -NoProfile -Command "& '$script' -Value '' -Mode Fail" 2>&1
        $LASTEXITCODE | Should -Be 1
    }
    It 'Fail mode: a missing required entry exits 1' {
        $null = pwsh -NoProfile -Command "& '$script' -Value 'github:42=alex franco' -Mode Fail" 2>&1
        $LASTEXITCODE | Should -Be 1
    }
    It 'Warn mode: an empty value exits 0 with a ::warning (staging warns only)' {
        $out = pwsh -NoProfile -Command "& '$script' -Value '' -Mode Warn" 2>&1 | Out-String
        $LASTEXITCODE | Should -Be 0
        $out | Should -Match '(?m)^::warning title=t/4326 IDENTITY_MAP::'
    }
    It 'Fail mode: a complete value exits 0' {
        $null = pwsh -NoProfile -Command "& '$script' -Value 'github:6188114=jpsnover,github:42=alex franco' -Mode Fail" 2>&1
        $LASTEXITCODE | Should -Be 0
    }
}

Describe 'Workflow wiring (t/4326)' {
    BeforeAll {
        $deploy  = Get-Content "$PSScriptRoot/../.github/workflows/deploy-azure.yml" -Raw
        $staging = Get-Content "$PSScriptRoot/../.github/workflows/deploy-staging.yml" -Raw
    }
    It 'deploy-azure preflight runs the gate in Fail mode' {
        $deploy | Should -Match 'Assert-IdentityMapConfigured\.ps1 -Value \$env:IDENTITY_MAP_VALUE -Mode Fail'
    }
    It 'neither workflow dot-sources the gate (dot-sourcing skips its body and it silently passes)' {
        $deploy  | Should -Not -Match '(?m)^\s*(run:\s*)?\.\s+\S*Assert-IdentityMapConfigured\.ps1'
        $staging | Should -Not -Match '(?m)^\s*(run:\s*)?\.\s+\S*Assert-IdentityMapConfigured\.ps1'
    }
    It 'deploy-staging runs the gate in Warn mode' {
        $staging | Should -Match 'Assert-IdentityMapConfigured\.ps1 -Value \$env:IDENTITY_MAP_VALUE -Mode Warn'
    }
}
