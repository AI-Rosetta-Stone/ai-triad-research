# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/671 (t/500): the storage lifecycle rules that delete anonymous op-ed blobs are the backstop for
# the 24-hour retention promise. They delete data, so what each one can reach is pinned here by a
# static parse of the real main.bicep (same approach as BicepStagingFreeTierKey.Tests.ps1):
# which environments are armed, the literal prefix, and that neither rule can reach signed-in data
# or the anon-oped-spend/ ledger. Arming prod is a deliberate, reviewed change to this file too.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-ParamDefault([string]$Name, [string]$Text = $script:Bicep) {
        $m = [regex]::Match($Text, "(?m)^param $Name \w+ = (.+?)\s*$")
        if (-not $m.Success) { throw "param $Name not found in main.bicep" }
        $m.Groups[1].Value
    }

    # The rule object named $RuleName inside var anonOpEdLifecycleRules, up to its closing filters block.
    function Get-RuleBlock([string]$RuleName, [string]$Text = $script:Bicep) {
        $m = [regex]::Match($Text, "(?s)name: '$([regex]::Escape($RuleName))'.*?prefixMatch: \[([^\]]*)\]")
        if (-not $m.Success) { throw "lifecycle rule '$RuleName' not found in main.bicep" }
        [pscustomobject]@{ Body = $m.Value; PrefixMatch = $m.Groups[1].Value.Trim() }
    }

    # What a prefixMatch entry resolves to, given the params' defaults. Anything it can't resolve is returned as written.
    function Resolve-Prefix([string]$Expression, [string]$Text = $script:Bicep) {
        $value = $Expression.Trim("'")
        foreach ($name in 'azureUserContentContainerStaging', 'anonOpEdLifecyclePrefix') {
            $value = $value.Replace('${' + $name + '}', (Get-ParamDefault $name $Text).Trim("'"))
        }
        $value
    }

    # The problems with a resolved prefix, as a list of reasons. Empty means the rule is confined to anonymous op-eds.
    function Get-PrefixProblems([string]$Resolved, [string]$Container) {
        $problems = @()
        if ($Resolved -notmatch '^[a-z0-9-]+/[a-z0-9-]+/$') { $problems += "not <container>/<prefix>/ : '$Resolved'" }
        if (-not $Resolved.StartsWith("$Container/", [StringComparison]::Ordinal)) { $problems += "not in container '$Container'" }
        if ($Resolved -ne "$Container/anon-oped/") { $problems += "not exactly '$Container/anon-oped/'" }
        $problems
    }

    $script:StagingRule = Get-RuleBlock 'delete-anon-oped-staging'
    $script:ProdRule = Get-RuleBlock 'delete-anon-oped-prod'
}

Describe 'anonymous op-ed lifecycle rules (t/671, t/500)' {

    It 'staging is armed and prod is not (arming prod is its own reviewed change)' {
        Get-ParamDefault 'anonOpEdLifecycleStagingEnabled' | Should -Be 'true'
        Get-ParamDefault 'anonOpEdLifecycleProdEnabled' | Should -Be 'false'
    }

    It 'the prefix param allows only anon-oped/ and defaults to it' {
        Get-ParamDefault 'anonOpEdLifecyclePrefix' | Should -Be "'anon-oped/'"
        $script:Bicep | Should -Match "(?s)@allowed\(\[\s*'anon-oped/'\s*\]\)\s*\r?\nparam anonOpEdLifecyclePrefix string"
    }

    It 'each rule is gated on its own flag and on the prefix safety check' {
        $script:Bicep | Should -Match "\(anonOpEdLifecycleStagingEnabled && anonOpEdPrefixSafe\)\s*\r?\n\s*\? \[\s*\r?\n\s*\{\s*\r?\n\s*name: 'delete-anon-oped-staging'"
        $script:Bicep | Should -Match "\(anonOpEdLifecycleProdEnabled && anonOpEdPrefixSafe\)\s*\r?\n\s*\? \[\s*\r?\n\s*\{\s*\r?\n\s*name: 'delete-anon-oped-prod'"
        $script:Bicep | Should -Match "(?m)^var anonOpEdPrefixSafe = !empty\(anonOpEdLifecyclePrefix\) && !startsWith\(anonOpEdLifecyclePrefix, 'users/'\) && endsWith\(anonOpEdLifecyclePrefix, '/'\)"
    }

    It 'the staging rule reaches exactly staging-user-content/anon-oped/' {
        $script:StagingRule.PrefixMatch | Should -Be "'`${azureUserContentContainerStaging}/`${anonOpEdLifecyclePrefix}'"
        Get-PrefixProblems (Resolve-Prefix $script:StagingRule.PrefixMatch) 'staging-user-content' | Should -BeNullOrEmpty
    }

    It 'the prod rule reaches exactly user-content/anon-oped/' {
        $script:ProdRule.PrefixMatch | Should -Be "'user-content/`${anonOpEdLifecyclePrefix}'"
        Get-PrefixProblems (Resolve-Prefix $script:ProdRule.PrefixMatch) 'user-content' | Should -BeNullOrEmpty
    }

    It 'neither rule''s prefix is a prefix of the spend ledger or of signed-in data' {
        foreach ($rule in $script:StagingRule, $script:ProdRule) {
            $resolved = Resolve-Prefix $rule.PrefixMatch
            foreach ($kept in 'anon-oped-spend/day-2026-11-25.json', 'users/someone/debates/_index.json', '_system/free-pool-budget/2026-11-25.json') {
                foreach ($container in 'staging-user-content', 'user-content') {
                    "$container/$kept".StartsWith($resolved, [StringComparison]::Ordinal) | Should -BeFalse -Because "$resolved must not match $container/$kept"
                }
            }
        }
    }

    It 'both rules delete only block blobs older than the age param, by last modification' {
        foreach ($rule in $script:StagingRule, $script:ProdRule) {
            $rule.Body | Should -Match 'baseBlob: \{ delete: \{ daysAfterModificationGreaterThan: anonOpEdLifecycleAgeDays \} \}'
            $rule.Body | Should -Match "blobTypes: \['blockBlob'\]"
        }
        Get-ParamDefault 'anonOpEdLifecycleAgeDays' | Should -Be '2'
    }

    # Failing arm: the check must reject the prefixes that would delete the wrong data.
    Context 'failing arm: a widened prefix is reported' {
        It 'the prefix without its trailing slash (would also match anon-oped-spend/)' {
            Get-PrefixProblems 'staging-user-content/anon-oped' 'staging-user-content' | Should -Not -BeNullOrEmpty
            'staging-user-content/anon-oped-spend/day.json'.StartsWith('staging-user-content/anon-oped') | Should -BeTrue -Because 'this is the deletion the slash prevents'
        }
        It 'the whole container' {
            Get-PrefixProblems 'staging-user-content/' 'staging-user-content' | Should -Not -BeNullOrEmpty
        }
        It 'a signed-in prefix' {
            Get-PrefixProblems 'staging-user-content/users/' 'staging-user-content' | Should -Not -BeNullOrEmpty
        }
        It 'the staging rule pointed at prod''s container' {
            Get-PrefixProblems 'user-content/anon-oped/' 'staging-user-content' | Should -Not -BeNullOrEmpty
        }
        It 'a mutated main.bicep whose staging rule names prod''s container is caught by the same parse' {
            $mutated = $script:Bicep.Replace("prefixMatch: ['`${azureUserContentContainerStaging}/`${anonOpEdLifecyclePrefix}']", "prefixMatch: ['user-content/`${anonOpEdLifecyclePrefix}']")
            $mutated | Should -Not -Be $script:Bicep -Because 'the mutation must change the file'
            $rule = Get-RuleBlock 'delete-anon-oped-staging' $mutated
            Get-PrefixProblems (Resolve-Prefix $rule.PrefixMatch $mutated) 'staging-user-content' | Should -Not -BeNullOrEmpty
        }
    }
}
