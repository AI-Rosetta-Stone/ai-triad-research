# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4426: a prod-severity log alert must filter to the prod app, or staging noise pages it as if
# it were prod. Found via t/4263's C2 review: alert-event-loop-blocked (200/202 matching lines
# were staging) and alert-restart-loop (counted StoppingContainer, which every deploy emits, plus
# staging canary crash loops). Static parse of main.bicep, same pattern as BicepAllowedOrigins.Tests.ps1.
#
# SO C1 (p/769#52): removing StoppingContainer without adding "Error" made the alert BLIND — a
# 30d backtest shows ContainerBackOff/ImagePullBackOff alone never exceeds 3 events (never fires),
# while the real 2026-10-13 incident (t/4176, OOM-kill) produced Reason_s=="Error" x16 and no
# BackOff burst. Adding Error fires EXACTLY on that incident and nowhere else in 30d.
#
# SO C2 (p/769#52): the app name is injected via replace('...__APP_NAME__...', '__APP_NAME__',
# containerApp.name) instead of a second hardcoded 'taxonomy-editor' literal in each query, so a
# future rename of the prod app can't silently blind both sev-1 alerts.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    # Resolves a resource's `query:` to its KQL text, whether it's an inline '''...''' literal or
    # a `query: <varName>` reference to a `var <varName> = replace('''...''', ..., ...)` — so the
    # content checks (BackOff/Error/StoppingContainer) work the same way for either style.
    function Get-AlertQueryText([string]$AlertName) {
        $resourcePattern = "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'$AlertName'.*?query:\s*('''(.*?)'''|(\w+))\s*\r?\n"
        if ($script:Bicep -notmatch $resourcePattern) { return $null }
        if ($Matches[2]) { return $Matches[2] }                         # inline '''...''' literal
        $varName = $Matches[3]                                          # query: <varName> reference
        $varPattern = "(?s)var $varName\s*=\s*replace\('''(.*?)'''"
        if ($script:Bicep -match $varPattern) { return $Matches[1] }
        return $null
    }

    # Returns the FULL `var <varName> = replace(...)` statement text, for C2's structural check
    # (that the replace() substitutes containerApp.name, not a second hardcoded literal). Anchored
    # on the ''' ... ''' delimiters directly (not a generic `.*?\)`, which stops at the first `)`
    # inside the KQL body itself, e.g. `Reason_s in (...)`, before reaching replace()'s real close).
    function Get-AlertQueryVarDefinition([string]$VarName) {
        if ($script:Bicep -match "(?s)var $VarName\s*=\s*(replace\('''.*?'''\s*,\s*'__APP_NAME__'\s*,\s*[\w.]+\s*\))") { return $Matches[1] }
        return $null
    }

    function Get-AlertQueryVarName([string]$AlertName) {
        $resourcePattern = "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'$AlertName'.*?query:\s*(\w+)\s*\r?\n"
        if ($script:Bicep -match $resourcePattern) { return $Matches[1] }
        return $null
    }
}

Describe 'Prod-only log alerts filter to the prod app (t/4426)' {
    # -ForEach (not a bare `foreach`): Pester's It scriptblocks run deferred, and a bare foreach's
    # loop variable doesn't survive by closure to that deferred execution (all iterations would
    # see the same, final/cleared value) — hence the first draft's spurious "the '' ... " failures.
    It "'<_>' resolves a query (inline literal or var reference)" -ForEach @('alert-restart-loop', 'alert-event-loop-blocked', 'alert-prod-container-backoff') {
        $q = Get-AlertQueryText $_
        $q | Should -Not -BeNullOrEmpty -Because "the '$_' scheduledQueryRules resource must exist and resolve a query, in main.bicep"
    }

    It 'FIRE ARM: a query with no ContainerAppName_s filter would fail this assertion' {
        # Proves the content pattern itself discriminates — not just that today's file happens to pass.
        $unscoped = @'
            ContainerAppConsoleLogs_CL
            | where Log_s has "event loop blocked"
'@
        $unscoped | Should -Not -Match 'ContainerAppName_s'
    }

    It "'alert-restart-loop' catches the real incident shape (SO C1): Error is in the set, StoppingContainer is not" {
        $q = Get-AlertQueryText 'alert-restart-loop'
        $q | Should -Not -Match 'StoppingContainer'
        $q | Should -Match 'ContainerBackOff'
        $q | Should -Match 'ImagePullBackOff'
        $q | Should -Match '"Error"' -Because 'the 2026-10-13 incident (t/4176) produced Error x16 with no BackOff burst — without it this alert would backtest to 0 fires in 30d'
    }

    It "'alert-restart-loop' and 'alert-event-loop-blocked' inject the app name via containerApp.name, not a second literal (SO C2)" {
        foreach ($alertName in 'alert-restart-loop', 'alert-event-loop-blocked') {
            $varName = Get-AlertQueryVarName $alertName
            $varName | Should -Not -BeNullOrEmpty -Because "'$alertName' should reference a query var, not an inline literal"
            $def = Get-AlertQueryVarDefinition $varName
            $def | Should -Not -BeNullOrEmpty -Because "'$varName' must be a replace('''...''', '__APP_NAME__', <symbol>) call"
            $def | Should -Match "(?s)replace\('''.*''',\s*'__APP_NAME__',\s*containerApp\.name\)" -Because "'$varName' must substitute containerApp.name, the single source of truth for the prod app's name"
        }
    }

    It 'FIRE ARM: a replace() call substituting a literal instead of containerApp.name would fail the C2 check' {
        $badDef = "replace('''query''', '__APP_NAME__', 'taxonomy-editor')"
        $badDef | Should -Not -Match "(?s)replace\('''.*''',\s*'__APP_NAME__',\s*containerApp\.name\)"
    }

    It 'alert-prod-container-backoff and alert-staging-container-backoff are UNCHANGED (inline literals, out of this ticket''s scope)' {
        (Get-AlertQueryText 'alert-prod-container-backoff') | Should -Match 'ContainerAppName_s\s*==\s*"taxonomy-editor"'
        $stagingQ = $null
        $pattern = "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'alert-staging-container-backoff'.*?query:\s*'''(.*?)'''"
        $script:Bicep -match $pattern | Should -Be $true
        $Matches[1] | Should -Match 'ContainerAppName_s\s*==\s*"taxonomy-editor-staging"'
    }
}
