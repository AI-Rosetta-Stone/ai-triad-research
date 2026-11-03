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

        # Param literal defaults, needed to resolve a bare-identifier override value (below).
        $paramLiteralPattern = "param\s+([A-Za-z_][A-Za-z0-9_]*)\s+string\s*=\s*'([^'\$\{\}]*)'"
        $paramDefaults = @{}
        $content | Select-String -Pattern $paramLiteralPattern -AllMatches | ForEach-Object {
            foreach ($m in $_.Matches) { $paramDefaults[$m.Groups[1].Value] = $m.Groups[2].Value }
        }

        # t/4794 incident, fail-closed per t/4794#4 (TL): walk EVERY override entry (not just the
        # ones a pattern happens to match), one per line -- every real stagingEnvOverrides entry in
        # this file is single-line `{ name: 'X', value: <expr> }`. An entry whose <expr> can't be
        # resolved to a literal (not a quoted non-interpolated string, not a bare identifier naming
        # a param with a literal default) is fine to leave unmanaged IF baseEnv never exposed that
        # key as a literal either (e.g. ALLOWED_ORIGINS -- interpolated on both sides, by design,
        # t/4794#4 scoping). But if baseEnv DID supply a literal for that key, an unresolvable
        # override can never shadow it -- silently leaving baseEnv's (prod) value in place is
        # exactly the incident. THROW, naming the key and the unresolved expression, rather than
        # repeat the silent skip for the next shape of this bug.
        $entryLinePattern = "^\{\s*name:\s*'([^']+)',\s*value:\s*(.+?)\s*\}$"
        foreach ($rawLine in ($stagingBlock -split "`n")) {
            $line = $rawLine.Trim()
            if ($line -notmatch $entryLinePattern) { continue }  # comment, blank line, or not a single-line entry
            $name = $Matches[1]
            $rawValue = $Matches[2]

            if ($rawValue -match "^'([^'\$\{\}]*)'$") {
                $result[$name] = $Matches[1]
                continue
            }
            if ($rawValue -match '^[A-Za-z_][A-Za-z0-9_]*$' -and $paramDefaults.ContainsKey($rawValue)) {
                $result[$name] = $paramDefaults[$rawValue]
                continue
            }
            if ($result.ContainsKey($name)) {
                throw "Get-BicepBaseEnv.ps1 -ForStaging: stagingEnvOverrides entry '$name' = $rawValue cannot be resolved to a literal value, but baseEnv already supplies a literal for this key -- the override would silently fail to apply, and baseEnv's value would ship to staging unchanged. Aborting (t/4794)."
            }
        }
    } else {
        Write-Warning "stagingEnvOverrides block not found in $BicepPath — only baseEnv entries returned"
    }
}

return $result
