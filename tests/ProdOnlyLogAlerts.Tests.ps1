# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4426: a prod-severity log alert must filter to the prod app, or staging noise pages it as if
# it were prod. Found via t/4263's C2 review: alert-event-loop-blocked (200/202 matching lines
# were staging) and alert-restart-loop (counted StoppingContainer, which every deploy emits, plus
# staging canary crash loops). Static parse of main.bicep, same pattern as BicepAllowedOrigins.Tests.ps1.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    # Returns the resource's `query: '''...'''` body (the KQL text), or $null if the resource or
    # its query block isn't found.
    function Get-AlertQuery([string]$AlertName) {
        $pattern = "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'$AlertName'.*?query:\s*'''(.*?)'''"
        if ($script:Bicep -match $pattern) { return $Matches[1] }
        return $null
    }
}

Describe 'Prod-only log alerts filter to the prod app (t/4426)' {
    # The set of log alerts that are meant to fire ONLY on the prod app (sev 0/1 "page someone"
    # rules whose own name/intent is prod-specific). Staging-specific rules (e.g.
    # alert-staging-container-backoff) are deliberately excluded — they're SUPPOSED to see
    # staging only, which is a different assertion, not this one.
    #
    # -ForEach (not a bare `foreach`): Pester's It scriptblocks run deferred, and a bare foreach's
    # loop variable doesn't survive by closure to that deferred execution (all iterations would
    # see the same, final/cleared value) — hence the first draft's spurious "the '' ... " failures.
    It "'<_>' query filters to ContainerAppName_s == `"taxonomy-editor`"" -ForEach @('alert-restart-loop', 'alert-event-loop-blocked', 'alert-prod-container-backoff') {
        $q = Get-AlertQuery $_
        $q | Should -Not -BeNullOrEmpty -Because "the '$_' scheduledQueryRules resource must exist in main.bicep"
        $q | Should -Match 'ContainerAppName_s\s*==\s*"taxonomy-editor"'
    }

    It 'FIRE ARM: a query with no ContainerAppName_s filter would fail this assertion' {
        # Proves the regex itself discriminates — not just that today's file happens to pass.
        $unscoped = @'
            ContainerAppConsoleLogs_CL
            | where Log_s has "event loop blocked"
'@
        $unscoped | Should -Not -Match 'ContainerAppName_s\s*==\s*"taxonomy-editor"'
    }

    It "'alert-restart-loop' no longer counts StoppingContainer (every deploy emits it, t/4426)" {
        $q = Get-AlertQuery 'alert-restart-loop'
        $q | Should -Not -Match 'StoppingContainer'
        $q | Should -Match 'ContainerBackOff'
        $q | Should -Match 'ImagePullBackOff'
    }

    It 'alert-staging-container-backoff is UNCHANGED (still staging-scoped, not prod) — this ticket does not touch it' {
        $pattern = "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'alert-staging-container-backoff'.*?query:\s*'''(.*?)'''"
        $script:Bicep -match $pattern | Should -Be $true
        $Matches[1] | Should -Match 'ContainerAppName_s\s*==\s*"taxonomy-editor-staging"'
    }
}
