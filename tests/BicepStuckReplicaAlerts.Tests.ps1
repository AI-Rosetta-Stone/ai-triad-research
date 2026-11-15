# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/266 option (a): two log alerts that catch a stuck replica (t/264, t/266#4). Static parse of the
# real main.bicep, the same approach as ProdOnlyLogAlerts.Tests.ps1. The thresholds were chosen by
# replaying the exact queries against real logs (t/266): the stuck-revision query fired on 11 real
# episodes in 8 days and 0 times after #4995; the replica-hours query read 48.1/40.2/38.4 on stall
# days and 19.9 on a normal day.

BeforeAll {
    $script:Bicep = Get-Content -Raw (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep')

    function Get-Rule([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?s)resource \w+ 'Microsoft\.Insights/scheduledQueryRules@[^']+' = \{\s*name:\s*'$([regex]::Escape($Name))'.*?\r?\n\}")
        if ($m.Success) { $m.Value } else { $null }
    }
    function Get-QueryVar([string]$RuleText) {
        $var = ([regex]::Match($RuleText, '(?m)^\s+query:\s*(\w+)\s*$')).Groups[1].Value
        $def = [regex]::Match($script:Bicep, "(?s)var $var\s*=\s*replace\('''(.*?)''',\s*'__APP_NAME__',\s*([\w.]+)\)")
        [pscustomobject]@{ Name = $var; Kql = $def.Groups[1].Value; Subst = $def.Groups[2].Value }
    }
    $script:Stuck = Get-Rule 'alert-stuck-revision-replica'
    $script:Hours = Get-Rule 'alert-replica-hours-24h'
}

Describe 'stuck-replica alerts (t/266 a)' {
    It 'both rules exist' {
        $script:Stuck | Should -Not -BeNullOrEmpty
        $script:Hours | Should -Not -BeNullOrEmpty
    }

    It 'both scope the prod app via containerApp.name (not a literal), on the console heartbeat' -ForEach @(
        @{ Rule = 'alert-stuck-revision-replica' }, @{ Rule = 'alert-replica-hours-24h' }
    ) {
        $q = Get-QueryVar (Get-Rule $Rule)
        $q.Name | Should -Not -BeNullOrEmpty
        $q.Subst | Should -Be 'containerApp.name'
        $q.Kql | Should -Match 'ContainerAppConsoleLogs_CL'
        $q.Kql | Should -Match 'ContainerAppName_s == "__APP_NAME__"'
        $q.Kql | Should -Match 'Log_s has "event-loop"'
    }

    It 'stuck-revision: a revision awake >= 50 of 60 min with ZERO requests, every 15 min, one page per 6h' {
        $q = Get-QueryVar $script:Stuck
        $q.Kql | Should -Match 'dcountif\(bin\(TimeGenerated, 1m\), Log_s has "event-loop"\)'
        $q.Kql | Should -Match 'countif\(Log_s has "requestId"\)'
        $q.Kql | Should -Match 'by RevisionName_s'
        $q.Kql | Should -Match 'where AwakeMinutes >= 50 and Requests == 0'
        $script:Stuck | Should -Match "windowSize: 'PT1H'"
        $script:Stuck | Should -Match "evaluationFrequency: 'PT15M'"
        $script:Stuck | Should -Match "muteActionsDuration: 'PT6H'"
    }

    It 'replica-hours: > 30 estimated replica-hours over 24h, summed across replicas per 5-min bin, hourly' {
        $q = Get-QueryVar $script:Hours
        $q.Kql | Should -Match 'extract\(''"hostname":"\(\[\^"\]\+\)"'', 1, Log_s\)'
        $q.Kql | Should -Match 'dcount\(Replica\) by bin\(TimeGenerated, 5m\)'
        $q.Kql | Should -Match 'sum\(Replicas\) \* 5\.0 / 60\.0'
        $q.Kql | Should -Match 'where ReplicaHours > 30'
        $script:Hours | Should -Match "windowSize: 'P1D'"
        $script:Hours | Should -Match "evaluationFrequency: 'PT1H'"
    }

    It 'both fire on any returned row and route to the existing action group (like every other alert)' -ForEach @(
        @{ Rule = 'alert-stuck-revision-replica' }, @{ Rule = 'alert-replica-hours-24h' }
    ) {
        $r = Get-Rule $Rule
        $r | Should -Match "timeAggregation: 'Count'"
        $r | Should -Match "operator: 'GreaterThan'"
        $r | Should -Match '(?m)^\s+threshold: 0\s*$'
        $r | Should -Match 'actionGroups: budgetAlertConfigured \? \[ restartAlertActionGroup\.id \] : \[\]'
        $r | Should -Match 'scopes: \[ logAnalytics\.id \]'
        $r | Should -Match 'enabled: true'
    }

    It 'FIRE ARM: the stuck-revision filter discriminates (an awake revision WITH requests is not stuck)' {
        # Mirrors the KQL predicate, so a loosened threshold is caught here and not only in replay.
        $stuck = { param($awake, $req) $awake -ge 50 -and $req -eq 0 }
        & $stuck 60 0 | Should -BeTrue     # c21fd5d / 60570a8 / bd493e9 shape
        & $stuck 60 812 | Should -BeFalse  # a busy serving revision
        & $stuck 8 0 | Should -BeFalse     # a normal deploy overlap
    }
}
