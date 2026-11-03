<#
.SYNOPSIS
    Parses literal-string env entries from the baseEnv block in main.bicep.

.DESCRIPTION
    Extracts entries where the value is a pure single-quoted string literal —
    no Bicep interpolation (`${...}`), no parameter/resource references.
    These are the only entries that can be statically compared against the
    ExpectedEnvVars table in deploy-azure.yml (t/2631).

    Skipped by design (not static-comparable):
      ALLOWED_ORIGINS             — Bicep string interpolation
      AZURE_KEYVAULT_URL          — resource property reference
      AZURE_STORAGE_ACCOUNT_URL   — resource property reference
      AUTH_DISABLED / AUTH_OPTIONAL / ADMIN_USERS
      GIT_SYNC_ENABLED / GITHUB_* — parameter references (overridden by -ForStaging)
      APPLICATIONINSIGHTS_*       — resource property reference

.PARAMETER BicepPath
    Path to deploy/azure/main.bicep. Defaults to the canonical location
    relative to this script's repo root.

.PARAMETER ForStaging
    Also parse var stagingEnvOverrides and merge into the result (staging values
    win over baseEnv). Use when syncing or verifying the staging container app.

.OUTPUTS
    [hashtable] mapping env-var name → literal string value.
    Exits non-zero if the baseEnv block is not found.

.EXAMPLE
    $env = . ./operations/devops/Get-BicepBaseEnv.ps1
    $env['NODE_ENV']   # 'production'

.EXAMPLE
    $env = . ./operations/devops/Get-BicepBaseEnv.ps1 -ForStaging
    $env['TAXONOMY_CACHE_DIR']   # '/mnt/staging-state/cache'
#>
[CmdletBinding()]
param(
    [string]$BicepPath,
    [switch]$ForStaging,
    [switch]$NamesOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $BicepPath) {
    $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $BicepPath = Join-Path $repoRoot 'deploy/azure/main.bicep'
}

if (-not (Test-Path $BicepPath)) {
    throw "main.bicep not found at: $BicepPath"
}

$content = Get-Content $BicepPath -Raw

# Locate the baseEnv block: var baseEnv = [ ... ]
# Capture everything between the opening '[' and the matching ']'
if ($content -notmatch '(?s)var baseEnv\s*=\s*\[(.*?)\]') {
    Write-Error "baseEnv block not found in $BicepPath"
    exit 1
}
$block = $Matches[1]

# Match entries where the value is a pure single-quoted string literal.
# Excludes: values with ${...} (interpolation), or values without quotes (param refs).
$literalPattern = @"
\{\s*name:\s*'([^']+)',\s*value:\s*'([^'\$\{\}]*)'\s*\}
"@.Trim()

if ($NamesOnly) {
    # Return all key names from baseEnv (and stagingEnvOverrides if ForStaging),
    # regardless of value type (literal, interpolated, param-ref). Used by
    # Sync-StagingEnv.ps1 to scope its orphan-removal reconcile safely (t/3345).
    $namePattern = "\{\s*name:\s*'([^']+)'"
    $allNames    = [System.Collections.Generic.List[string]]::new()
    foreach ($src in @($block)) {
        $src | Select-String -Pattern $namePattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) {
                $n = $m.Groups[1].Value
                if ($n -notin $allNames) { $allNames.Add($n) }
            }
        }
    }
    if ($ForStaging -and $content -match '(?s)var stagingEnvOverrides\s*=\s*\[(.*?)\]') {
        $stagingBlock = $Matches[1]
        $stagingBlock | Select-String -Pattern $namePattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) {
                $n = $m.Groups[1].Value
                if ($n -notin $allNames) { $allNames.Add($n) }
            }
        }
    }
    return [string[]]$allNames
}

$result = @{}
$block | Select-String -Pattern $literalPattern -AllMatches | ForEach-Object {
    foreach ($m in $_.Matches) {
        $name  = $m.Groups[1].Value
        $value = $m.Groups[2].Value
        $result[$name] = $value
    }
}

if ($ForStaging) {
    if ($content -match '(?s)var stagingEnvOverrides\s*=\s*\[(.*?)\]') {
        $stagingBlock = $Matches[1]
        $stagingBlock | Select-String -Pattern $literalPattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) {
                $result[$m.Groups[1].Value] = $m.Groups[2].Value
            }
        }

        # t/4794 incident: an override entry whose value is a bare PARAM reference (e.g.
        # `{ name: 'AZURE_USER_CONTENT_CONTAINER', value: azureUserContentContainerStaging }`,
        # t/4738) does NOT match $literalPattern (no quotes), so it was silently skipped here --
        # baseEnv's own (prod) literal for that same key then survived untouched, and staging
        # served prod's blob containers for ~15h. Resolve a bare-identifier override value against
        # this file's own `param <name> ... = '<literal>'` declarations (a param with a non-literal
        # default, e.g. a resource reference, still can't be resolved and is left unmatched --
        # this only closes the specific "override points at a param with a literal default" shape).
        $paramLiteralPattern = "param\s+([A-Za-z_][A-Za-z0-9_]*)\s+string\s*=\s*'([^'\$\{\}]*)'"
        $paramDefaults = @{}
        $content | Select-String -Pattern $paramLiteralPattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) { $paramDefaults[$m.Groups[1].Value] = $m.Groups[2].Value }
        }
        $identifierOverridePattern = "\{\s*name:\s*'([^']+)',\s*value:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}"
        $stagingBlock | Select-String -Pattern $identifierOverridePattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) {
                $name = $m.Groups[1].Value
                $paramName = $m.Groups[2].Value
                if ($paramDefaults.ContainsKey($paramName)) { $result[$name] = $paramDefaults[$paramName] }
            }
        }
    } else {
        Write-Warning "stagingEnvOverrides block not found in $BicepPath — only baseEnv entries returned"
    }
}

return $result
