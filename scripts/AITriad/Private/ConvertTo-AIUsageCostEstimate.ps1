# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AIUsageEntryProp {
    # Behavior-preserving helper (t/refactor): read an optional note property
    # off an entry, returning $Default when it is absent. Mirrors the inline
    # `if ($E.PSObject.Properties['x']) { $E.x } else { $default }` idiom.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entry,
        [Parameter(Mandatory)][string]$Name,
        $Default
    )
    Set-StrictMode -Version Latest
    if ($Entry.PSObject.Properties[$Name]) { $Entry.$Name } else { $Default }
}

function Resolve-AIUsagePricingId {
    # Behavior-preserving helper (t/refactor): resolve an entry's pricing key in
    # the exact order the main function used -- modelId field first, then the
    # nested (backend, apiModelId) map, honouring the ambiguity marker. Returns
    # ResolvedId ($null when unresolved) and IsAmbiguous.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entry,
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$ModelId,
        [Parameter(Mandatory)][hashtable]$ApiModelIdMap
    )
    Set-StrictMode -Version Latest

    $RecordModelId = Get-AIUsageEntryProp -Entry $Entry -Name 'modelId' -Default $null
    if ($RecordModelId) {
        return [PSCustomObject]@{ ResolvedId = $RecordModelId; IsAmbiguous = $false }
    }

    $EBackend = Get-AIUsageEntryProp -Entry $Entry -Name 'backend' -Default $null
    if ($EBackend -and $ApiModelIdMap.ContainsKey($EBackend)) {
        $BackendMap = $ApiModelIdMap[$EBackend]
        if ($BackendMap.ContainsKey($ModelId)) {
            $Candidate = $BackendMap[$ModelId]
            if ($Candidate -eq $script:AmbiguousPricingKeyMarker) {
                return [PSCustomObject]@{ ResolvedId = $null; IsAmbiguous = $true }
            }
            return [PSCustomObject]@{ ResolvedId = $Candidate; IsAmbiguous = $false }
        }
    }

    return [PSCustomObject]@{ ResolvedId = $null; IsAmbiguous = $false }
}

function Write-AIUsageUnresolvedWarning {
    # Behavior-preserving helper (t/refactor): emit the once-per-model
    # unresolved WARN, choosing the ambiguous vs could-not-resolve wording
    # exactly as the main function did (t/3951).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entry,
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$ModelId,
        [Parameter(Mandatory)][bool]$IsAmbiguous
    )
    Set-StrictMode -Version Latest

    if ($IsAmbiguous) {
        Write-Warning "ConvertTo-AIUsageCostEstimate: '$ModelId' (backend: $($Entry.backend)) is ambiguous -- 2+ models share this (backend, apiModelId) pair at different prices; reporting as unresolved (estimatedCost=0, hasPricing=false), never a guessed match (t/3951)."
    }
    else {
        $BackendLabel = Get-AIUsageEntryProp -Entry $Entry -Name 'backend' -Default '<none>'
        Write-Warning "ConvertTo-AIUsageCostEstimate: '$ModelId' (backend: $BackendLabel) could not be resolved to a pricing key -- reporting as unresolved (estimatedCost=0, hasPricing=false), never a guessed match (t/3951)."
    }
}

function Get-AIUsageEntryCost {
    # Behavior-preserving helper (t/refactor): compute one entry's estimated
    # cost from its resolved pricing, including the once-per-model full-input
    # cache-rate fallback WARN (t/3947). Same arithmetic as the main loop.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$PriceInfo,
        [Parameter(Mandatory)][AllowNull()][string]$ResolvedId,
        [Parameter(Mandatory)][long]$InputTok,
        [Parameter(Mandatory)][long]$OutputTok,
        [Parameter(Mandatory)][long]$CachedTok,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$WarnedModels
    )
    Set-StrictMode -Version Latest

    $InputRate  = if ($PriceInfo.PSObject.Properties['inputPer1M'])  { $PriceInfo.inputPer1M }  else { 0 }
    $OutputRate = if ($PriceInfo.PSObject.Properties['outputPer1M']) { $PriceInfo.outputPer1M } else { 0 }
    if ($PriceInfo.PSObject.Properties['cachedInputPer1M']) {
        $CachedRate = $PriceInfo.cachedInputPer1M
    }
    else {
        $CachedRate = $InputRate
        if ($WarnedModels.Add($ResolvedId)) {
            Write-Warning "ConvertTo-AIUsageCostEstimate: '$ResolvedId' has no cachedInputPer1M -- falling back to the full input rate ($InputRate/1M) for cached tokens, which may overstate cost (t/3947)."
        }
    }

    $UncachedInput = [Math]::Max(0, $InputTok - $CachedTok)
    ($UncachedInput * $InputRate / 1000000) + ($CachedTok * $CachedRate / 1000000) + ($OutputTok * $OutputRate / 1000000)
}

function ConvertTo-AIUsageCostEstimate {
    <#
    .SYNOPSIS
        Get-AICostReport sub-helper (t/3910): computes per-entry estimated cost
        and attaches it to each entry in place (estimatedCost, hasPricing).
    .DESCRIPTION
        t/3951 (binding design t/3946#5, SO e/248): resolves each entry's
        pricing key in this order, matching the TS reader:
          1. An exact `modelId` field on the record (set by DebateTool,
             t/3950) -> pricing[modelId] directly. No further fallback --
             modelId is authoritative; if pricing lacks it, unresolved.
          2. Legacy records (no modelId): (backend, apiModelId) ->
             models[].id via Get-AICostPricing's ApiModelIdMap, then
             pricing[id]. Never looks up a bare apiModelId directly --
             `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` are each
             shared by 2 backends (azure/openai) on origin/main, so a bare
             lookup could silently pick the wrong backend's price.
          3. No backend, (backend, apiModelId) not in the map, or the map
             holds $script:AmbiguousPricingKeyMarker (two DIFFERENT models
             share that pair -- Get-AICostPricing never last-write-wins):
             UNRESOLVED -- never a first-match guess, never priced at $0
             silently (SO condition e/248#4). WARNs once per model id per
             call.
        The old `<backend>-<model>` string-concat fallback is dropped: it
        resolves 0 pricing keys on origin/main and only caused PS to
        diverge from the TS reader's resolution.

        t/3947: when a pricing entry has no cachedInputPer1M, cached tokens are
        costed at the full input rate (the same fallback registry.ts's
        findPricingMissingCacheRate warns about on the TS side, t/3945). That
        fallback can overstate cost silently, so this now emits one WARN per
        model id per call (fallback-path logging, root AGENTS.md) the first
        time a model hits it -- not once per usage entry, to avoid a WARN
        flood on a report covering thousands of calls for the same model.
    .PARAMETER Entries
        The parsed usage entries (as returned by Read-AIUsageEntries). Mutated
        in place -- each entry gains estimatedCost/hasPricing members.
    .PARAMETER Pricing
        Pricing lookup from Get-AICostPricing.
    .PARAMETER ApiModelIdMap
        Nested map from Get-AICostPricing: $ApiModelIdMap[backend][apiModelId]
        -> models[].id, or $script:AmbiguousPricingKeyMarker if two different
        models share that pair.
    .OUTPUTS
        None -- mutates each entry in place, adding estimatedCost, hasPricing,
        and resolvedPricingId (t/3968: $null when unresolved; otherwise the
        exact key this function looked up in Pricing, so a downstream
        consumer -- e.g. Get-AIUsageCacheSavings -- never has to re-run this
        same resolution by a bare model id, which drifted from this function's
        resolution order before and would again).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [System.Collections.Generic.List[PSObject]]$Entries,

        [Parameter(Mandatory)]
        [hashtable]$Pricing,

        [Parameter(Mandatory)]
        [hashtable]$ApiModelIdMap
    )

    Set-StrictMode -Version Latest

    $WarnedModels = [System.Collections.Generic.HashSet[string]]::new()
    $UnresolvedWarned = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($E in $Entries) {
        $ModelId = Get-AIUsageEntryProp -Entry $E -Name 'model' -Default 'unknown'
        $InputTok  = [long](Get-AIUsageEntryProp -Entry $E -Name 'promptTokens' -Default 0)
        $OutputTok = [long](Get-AIUsageEntryProp -Entry $E -Name 'completionTokens' -Default 0)
        $CachedTok = [long](Get-AIUsageEntryProp -Entry $E -Name 'cachedTokens' -Default 0)

        $Cost = 0.0
        $PriceInfo = $null

        $Resolution = Resolve-AIUsagePricingId -Entry $E -ModelId $ModelId -ApiModelIdMap $ApiModelIdMap
        $ResolvedId = $Resolution.ResolvedId
        $IsAmbiguous = $Resolution.IsAmbiguous

        if ($ResolvedId -and $Pricing.ContainsKey($ResolvedId)) {
            $PriceInfo = $Pricing[$ResolvedId]
        }
        elseif ($UnresolvedWarned.Add($ModelId)) {
            Write-AIUsageUnresolvedWarning -Entry $E -ModelId $ModelId -IsAmbiguous $IsAmbiguous
        }

        if ($null -ne $PriceInfo) {
            $Cost = Get-AIUsageEntryCost -PriceInfo $PriceInfo -ResolvedId $ResolvedId -InputTok $InputTok -OutputTok $OutputTok -CachedTok $CachedTok -WarnedModels $WarnedModels
        }

        $E | Add-Member -NotePropertyName 'estimatedCost' -NotePropertyValue $Cost -Force
        $E | Add-Member -NotePropertyName 'hasPricing' -NotePropertyValue ($null -ne $PriceInfo) -Force
        $E | Add-Member -NotePropertyName 'resolvedPricingId' -NotePropertyValue $(if ($null -ne $PriceInfo) { $ResolvedId } else { $null }) -Force
    }
}
