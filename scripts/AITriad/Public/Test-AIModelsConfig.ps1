# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-AIModelsConfig {
    <#
    .SYNOPSIS
        Validates ai-models.json for the config defects that have caused
        production AI failures — BOM, unparseable JSON, incomplete model
        entries, friendly-id-in-apiModelId, and orphaned model references.

    .DESCRIPTION
        ai-models.json is the single source of truth for both the PowerShell
        module and the Electron apps. Two flight-recorder incidents (2026-07-24)
        traced to config defects a static check catches instantly (t/1705):
          - a UTF-8 BOM made Electron's JSON.parse throw on every read (t/1702);
          - `defaults.zai` referenced `zai-glm-5-2` with no matching models[]
            entry, so the friendly id was sent verbatim to the provider and
            rejected as an invalid model (t/1703).

        Two severities:
          - Error   (fails Pass): BOM, invalid JSON, incomplete models[] entry,
                     friendly-id-in-apiModelId. These are unambiguous defects.
          - Warning (surfaced, does NOT fail Pass): a reference in defaults /
                     debateTiers / fallbackChains that resolves to no models[]
                     entry or `<family>-latest` alias. Verbatim passthrough is
                     INTENTIONAL and load-bearing (a valid provider model such as
                     `deepseek-chat` legitimately needs no curated models[] entry),
                     so an unresolved reference can't be auto-distinguished from a
                     typo — it is reported for review, not failed. This mirrors
                     lib/ai-client/registry.ts `validateModelConfig`, which warns
                     on the same class for the same reason.

        Emits one Write-Warning per issue and returns a result object with a
        boolean Pass (no Error-severity issues) and the full issue list, so a
        Pester test (run by the CI `test-powershell` job over ./tests/) asserts
        Pass on the committed config, and a broken config produces actionable
        output for every defect.

        Reference resolution mirrors registry.ts `getApiModelId` /
        `buildModelIdMap` — a reference resolves if it is a models[].id OR a
        synthesized `<family>-latest` alias. If that resolver changes, update the
        nested Get-ModelFamily here to match (the committed-config test is the
        drift tripwire).

    .PARAMETER Path
        Path to ai-models.json. Default: the repo-root ai-models.json.

    .EXAMPLE
        Test-AIModelsConfig

    .EXAMPLE
        # Fail a script/CI step on any Error-severity config defect
        if (-not (Test-AIModelsConfig).Pass) { throw 'ai-models.json has config errors' }

    .EXAMPLE
        # See the unresolved-reference warnings (e.g. orphaned fallback entries)
        (Test-AIModelsConfig).Issues | Where-Object Severity -eq 'Warning'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AIApiKey
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Position = 0)]
        [string]$Path = (Join-Path $script:RepoRoot 'ai-models.json')
    )

    Set-StrictMode -Version Latest

    if (-not (Test-Path -Path $Path)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Validate ai-models.json' `
            -Problem "Config file not found: $Path" `
            -Location 'Test-AIModelsConfig' `
            -NextSteps 'Pass -Path to the ai-models.json location, or run from the repo root.')
    }

    $Issues = [System.Collections.Generic.List[PSCustomObject]]::new()
    function Add-Issue([string]$Severity, [string]$Check, [string]$Site, [string]$Detail) {
        $Issues.Add([PSCustomObject]@{ Severity = $Severity; Check = $Check; Site = $Site; Detail = $Detail })
        Write-Warning "[$Severity/$Check] ${Site}: $Detail"
    }

    # ── Check 1: UTF-8 BOM (EF BB BF) — breaks Electron JSON.parse (t/1702) ──
    $Bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        Add-Issue 'Error' 'BOM' $Path 'File begins with a UTF-8 BOM (EF BB BF). PowerShell tolerates it but Electron JSON.parse throws on every read — re-save as UTF-8 without BOM.'
    }

    # ── Check 2: JSON parses ────────────────────────────────────────────────
    try {
        $Cfg = Get-Content -Path $Path -Raw | ConvertFrom-Json
    }
    catch {
        Add-Issue 'Error' 'InvalidJson' $Path "ConvertFrom-Json failed: $($_.Exception.Message)"
        # Nothing else is checkable without a parsed object.
        return [PSCustomObject]@{ Path = $Path; Pass = $false; Issues = @($Issues) }
    }

    $Models   = if ($Cfg.PSObject.Properties['models'])   { @($Cfg.models) }   else { @() }
    $Backends = if ($Cfg.PSObject.Properties['backends']) { @($Cfg.backends) } else { @() }

    # ── Check A: UnknownAdapter — each backends[].id must match a callProvider switch case ──
    # Parse switch cases from client.ts so the check stays current when new adapters are added.
    $ClientTsPath = Join-Path $script:RepoRoot 'lib/ai-client/client.ts'
    $KnownAdapters = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $AdapterSetValid = $false
    if (Test-Path $ClientTsPath) {
        $ClientTs = Get-Content $ClientTsPath -Raw
        [regex]::Matches($ClientTs, "case '(\w+)':") | ForEach-Object { [void]$KnownAdapters.Add($_.Groups[1].Value) }
        [void]$KnownAdapters.Add('gemini')  # default case — no explicit switch arm
        $AdapterSetValid = $true
    }

    $BackendIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $BackendIdx = 0
    foreach ($B in $Backends) {
        $BId = if ($B.PSObject.Properties['id']) { [string]$B.id } else { '' }
        if (-not [string]::IsNullOrWhiteSpace($BId)) {
            [void]$BackendIds.Add($BId)
            if ($AdapterSetValid -and -not $KnownAdapters.Contains($BId)) {
                Add-Issue 'Error' 'UnknownAdapter' "backends[$BackendIdx] ($BId)" "Backend id '$BId' has no matching switch case in lib/ai-client/client.ts callProvider — requests will silently fall through to the gemini default."
            }
        }
        $BackendIdx++
    }

    # Backends whose real provider API model names legitimately carry the vendor
    # name as a prefix (gemini-2.5-flash, claude-opus-4-6, deepseek-chat). For
    # every OTHER backend the friendly id is vendor-prefixed but the apiModelId is
    # not (azure-gpt-4o -> gpt-4o, zai-glm-5-2 -> glm-5.3), so a prefixed apiModelId
    # means the friendly id leaked into it — the t/1703 class.
    $PrefixExemptBackends = @('gemini', 'claude', 'deepseek')
    $ModelIds = [System.Collections.Generic.List[string]]::new()

    # ── Check 3 + 4: models[] completeness and apiModelId plausibility ──────
    for ($i = 0; $i -lt $Models.Count; $i++) {
        $M = $Models[$i]
        $Id      = if ($M.PSObject.Properties['id'])         { [string]$M.id }         else { '' }
        $ApiId   = if ($M.PSObject.Properties['apiModelId']) { [string]$M.apiModelId } else { '' }
        $Backend = if ($M.PSObject.Properties['backend'])    { [string]$M.backend }    else { '' }
        $Where   = "models[$i]$(if ($Id) { " ($Id)" })"

        if ([string]::IsNullOrWhiteSpace($Id))      { Add-Issue 'Error' 'IncompleteModel' $Where 'Missing/empty id.' }
        if ([string]::IsNullOrWhiteSpace($ApiId))   { Add-Issue 'Error' 'IncompleteModel' $Where 'Missing/empty apiModelId.' }
        if ([string]::IsNullOrWhiteSpace($Backend)) { Add-Issue 'Error' 'IncompleteModel' $Where 'Missing/empty backend.' }

        # ── Check B: DanglingModelBackend — models[].backend must be in backends[].id ──
        if ($Backend -and $BackendIds.Count -gt 0 -and -not $BackendIds.Contains($Backend)) {
            Add-Issue 'Error' 'DanglingModelBackend' $Where "Backend '$Backend' is not declared in backends[].id — likely a typo."
        }

        if ($Id) { $ModelIds.Add($Id) }

        if ($ApiId -and $Backend -and ($Backend -notin $PrefixExemptBackends) -and $ApiId.StartsWith("$Backend-")) {
            Add-Issue 'Error' 'ApiModelIdPrefix' $Where "apiModelId '$ApiId' starts with the backend prefix '$Backend-' — that is a friendly id, not a provider API model name. Set apiModelId to the real provider model (the friendly id belongs in 'id')."
        }
    }

    # ── Build the resolvable-id set (mirrors buildModelIdMap) ───────────────
    # parseVersionedModelId port — SOURCE OF TRUTH: lib/ai-client/registry.ts:74.
    function Get-ModelFamily([string]$ModelId) {
        if ($ModelId -match '^(gemini)-(\d+\.\d+)-(.+?)(?:-preview)?$') {
            return "$($Matches[1])-$($Matches[3])"
        }
        if ($ModelId -match '^(claude-(?:opus|sonnet|haiku))-(\d+(?:-\d+)?)$') {
            return $Matches[1]
        }
        return $null
    }

    $ResolvableIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($Id in $ModelIds) { [void]$ResolvableIds.Add($Id) }
    foreach ($Id in $ModelIds) {
        $Family = Get-ModelFamily $Id
        if ($Family) { [void]$ResolvableIds.Add("$Family-latest") }
    }

    # ── Check 5: reference resolution (Warning — verbatim passthrough is intentional) ──
    function Test-Reference([string]$RefId, [string]$Site) {
        if ([string]::IsNullOrWhiteSpace($RefId)) { return }
        if ($ResolvableIds.Contains($RefId)) { return }
        Add-Issue 'Warning' 'UnresolvedReference' $Site "Model id '$RefId' resolves to no models[] entry or known <family>-latest alias. If it is a valid provider model it will pass through verbatim; if it is a typo or retired model it will be rejected at request time. Add a models[] entry or fix the reference."
    }

    if ($Cfg.PSObject.Properties['defaults']) {
        foreach ($P in $Cfg.defaults.PSObject.Properties) {
            if ($P.Name.StartsWith('_')) { continue }
            Test-Reference ([string]$P.Value) "defaults.$($P.Name)"
        }
    }

    if ($Cfg.PSObject.Properties['debateTiers']) {
        foreach ($Tier in $Cfg.debateTiers.PSObject.Properties) {
            if ($Tier.Name.StartsWith('_') -or $null -eq $Tier.Value -or $Tier.Value -isnot [PSCustomObject]) { continue }
            foreach ($B in $Tier.Value.PSObject.Properties) {
                if ($B.Name.StartsWith('_')) { continue }
                Test-Reference ([string]$B.Value) "debateTiers.$($Tier.Name).$($B.Name)"
            }
        }
    }

    if ($Cfg.PSObject.Properties['fallbackChains']) {
        foreach ($Chain in $Cfg.fallbackChains.PSObject.Properties) {
            if ($Chain.Name.StartsWith('_')) { continue }
            Test-Reference $Chain.Name "fallbackChains (key '$($Chain.Name)')"
            foreach ($Fallback in @($Chain.Value)) {
                Test-Reference ([string]$Fallback) "fallbackChains.$($Chain.Name)[]"
            }
        }
    }

    # ── Check 6: ai-usages.json model references (Warning — same rationale as Check 5) ──
    # UsageID entries (ai-usages.json, the ADR-006 registry) each pin a `model`.
    # A gemini-migration incident (t/1850) left usage entries pointing at removed
    # model ids while Test-AIModelsConfig still passed, because it never looked past
    # ai-models.json. ai-usages.json is the sibling of ai-models.json at the repo
    # root, so resolve it relative to $Path; skip silently if absent (a custom -Path
    # with no sibling registry is not a defect this cmdlet owns). Only entries with a
    # DIRECT `model` are checked — _extends children inherit `model` from a parent
    # entry that is itself checked at its own definition site, so every distinct model
    # string in the file is covered without re-implementing extends resolution.
    $UsagesPath = Join-Path (Split-Path -Parent $Path) 'ai-usages.json'
    if (Test-Path -Path $UsagesPath) {
        try {
            $Usages = Get-Content -Path $UsagesPath -Raw | ConvertFrom-Json
            foreach ($U in $Usages.PSObject.Properties) {
                if ($U.Name.StartsWith('_') -or $null -eq $U.Value -or $U.Value -isnot [PSCustomObject]) { continue }
                if ($U.Value.PSObject.Properties['model']) {
                    Test-Reference ([string]$U.Value.model) "ai-usages.json ($($U.Name)).model"
                }
            }
        }
        catch {
            Add-Issue 'Warning' 'UsagesUnreadable' $UsagesPath "Could not parse ai-usages.json for model-reference validation: $($_.Exception.Message). Its model refs were not checked."
        }
    }

    [PSCustomObject]@{
        Path   = $Path
        Pass   = (@($Issues | Where-Object { $_.Severity -eq 'Error' }).Count -eq 0)
        Issues = @($Issues)
    }
}
