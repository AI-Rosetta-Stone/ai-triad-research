# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4406: each container app's ALLOWED_ORIGINS must name its OWN host. Staging inherited prod's
# value from baseEnv, so its CORS allow-origin header named prod (hygiene; same-origin requests
# were unaffected because the guard passes Origin host == Host first, and Host is preserved).
# Static parse of main.bicep (Get-BicepBaseEnv.ps1 skips interpolated values by design).

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-Block([string]$VarName) {
        if ($script:Bicep -notmatch "(?s)var $VarName\s*=\s*\[(.*?)\n\]") { throw "var $VarName block not found in main.bicep" }
        return $Matches[1]
    }
    function Get-OriginHost([string]$Block) {
        $m = [regex]::Matches($Block, "\{\s*name:\s*'ALLOWED_ORIGINS',\s*value:\s*'https://([a-z0-9-]+)\.\$\{containerAppEnv\.properties\.defaultDomain\}'\s*\}")
        return @($m | ForEach-Object { $_.Groups[1].Value })
    }
    function Get-AppName([string]$ResourceSymbol) {
        if ($script:Bicep -notmatch "(?s)resource $ResourceSymbol 'Microsoft\.App/containerApps@[^']+' = \{\s*name:\s*'([^']+)'") {
            throw "resource $ResourceSymbol not found in main.bicep"
        }
        return $Matches[1]
    }
    $script:StagingSymbol = if ($script:Bicep -match "(?m)^resource (\w+) 'Microsoft\.App/containerApps@[^']+' = \{\s*\r?\n\s*name:\s*'taxonomy-editor-staging'") { $Matches[1] } else { $null }
}

Describe 'ALLOWED_ORIGINS per app (t/4406)' {
    It 'baseEnv (prod) names the prod app host exactly once' {
        $hosts = @(Get-OriginHost (Get-Block 'baseEnv'))
        $hosts.Count | Should -Be 1
        $hosts[0] | Should -Be (Get-AppName 'containerApp')
    }

    It 'stagingEnvOverrides names the staging app host exactly once' {
        $script:StagingSymbol | Should -Not -BeNullOrEmpty -Because 'the staging container app resource must be found'
        $hosts = @(Get-OriginHost (Get-Block 'stagingEnvOverrides'))
        $hosts.Count | Should -Be 1
        $hosts[0] | Should -Be (Get-AppName $script:StagingSymbol)
    }

    It 'stagingBaseEnv filters baseEnv ALLOWED_ORIGINS out, so staging carries one value, not prod''s plus its own' {
        $script:Bicep -match "(?s)var stagingBaseEnv\s*=\s*concat\(\s*filter\(baseEnv,\s*e\s*=>\s*([^\)]*)\)" | Should -Be $true
        $Matches[1] | Should -Match "e\.name != 'ALLOWED_ORIGINS'"
    }

    It 'the prod and staging origins differ' {
        @(Get-OriginHost (Get-Block 'baseEnv'))[0] | Should -Not -Be @(Get-OriginHost (Get-Block 'stagingEnvOverrides'))[0]
    }
}
