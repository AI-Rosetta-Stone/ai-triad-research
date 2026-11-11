# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/349 (SO C2 on #5054): alert-stuck-revision-replica fires on a prod revision that logged its heartbeat
# in >= 50 of 60 minutes with ZERO `requestId` lines. ACA's probes hit the app every few seconds; that
# only works because the request-completion log in server.ts skips those exact paths (`isQuiet`). If a
# probe moved to a logged path (e.g. /readyz), or a probe path dropped off the quiet list, every replica
# would show requests and the alert would go blind, silently. This pins both sides.

BeforeAll {
    $root = Join-Path $PSScriptRoot '..'
    $script:Bicep = Get-Content -Raw (Join-Path $root 'deploy' 'azure' 'main.bicep')
    $script:Server = Get-Content -Raw (Join-Path $root 'taxonomy-editor' 'src' 'server' 'server.ts')

    # The prod container app's probe paths (the `containerApp` resource, i.e. 'taxonomy-editor').
    $prod = [regex]::Match($script:Bicep, "(?s)(?m)^resource containerApp 'Microsoft\.App/containerApps@[^']+' = \{.*?\r?\n\}").Value
    $script:ProbePaths = @([regex]::Matches($prod, "httpGet:\s*\{\s*path:\s*'([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)

    # server.ts: const isQuiet = urlPath.startsWith('/assets/') || urlPath === '/health' || ...
    $quietLine = [regex]::Match($script:Server, '(?m)^\s*const isQuiet\s*=\s*(.+);\s*$').Groups[1].Value
    $script:QuietExact = @([regex]::Matches($quietLine, "urlPath\s*===\s*'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    $script:QuietPrefix = @([regex]::Matches($quietLine, "urlPath\.startsWith\('([^']+)'\)") | ForEach-Object { $_.Groups[1].Value })

    function Test-Quiet([string]$Path) {
        ($Path -in $script:QuietExact) -or @($script:QuietPrefix | Where-Object { $Path.StartsWith($_) }).Count -gt 0
    }
}

Describe 'probe paths stay off the request log, so alert-stuck-revision-replica can see idle (t/349)' {
    It 'finds the prod probes and the server quiet list (the parse is not vacuous)' {
        $script:ProbePaths | Should -Not -BeNullOrEmpty
        $script:ProbePaths | Should -Contain '/health'
        $script:QuietExact.Count | Should -BeGreaterThan 0 -Because 'server.ts must still have `const isQuiet = ...` with exact-path checks'
    }

    It 'every prod probe path is on the server quiet list' {
        foreach ($p in $script:ProbePaths) {
            Test-Quiet $p | Should -BeTrue -Because "probe path '$p' would log a requestId every probe and blind alert-stuck-revision-replica"
        }
    }

    It 'the stuck-revision alert still keys on requestId lines (the signal the quiet list protects)' {
        $script:Bicep | Should -Match "Requests = countif\(Log_s has `"requestId`"\)"
    }

    It 'FIRE ARM: a probe on a logged path (/readyz) is caught' {
        Test-Quiet '/readyz' | Should -BeFalse
        Test-Quiet '/api/data/available' | Should -BeFalse
    }
}
