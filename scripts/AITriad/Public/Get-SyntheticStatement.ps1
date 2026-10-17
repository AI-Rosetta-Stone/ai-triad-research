# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-SyntheticStatement {
    <#
    .SYNOPSIS
        Get the synthetic statements generated for a BDI taxonomy element (node).
    .DESCRIPTION
        Reads the synthetic corpus (written by New-SyntheticCorpus) and returns the statement
        entries for a given BDI element — a taxonomy node id shaped {acc|saf|skp}-{category}-NNN.

        The corpus is stored per-POV at <taxonomy>/synthetic/corpus_<pov>.json; the POV is derived
        from the node id prefix, so only the one relevant corpus file is read. Each returned entry
        carries the statement text plus its provenance (archetype, audience, model, timestamps).

        By default PRUNED entries are excluded (matching what Export-SyntheticEmbeddings embeds) —
        pass -IncludePruned to return them too. A node with no generated corpus returns nothing
        (with a verbose note); a POV whose corpus file is absent emits a WARNING and returns nothing.
    .PARAMETER NodeId
        The BDI element / taxonomy node id (e.g. 'acc-beliefs-003'). Accepts pipeline input and binds
        by the 'Id' property so taxonomy nodes can be piped in (e.g. Get-Tax -POV acc | Get-SyntheticStatement).
    .PARAMETER IncludePruned
        Also return entries marked pruned = true (excluded by default).
    .PARAMETER CorpusPath
        Override the synthetic corpus directory. Defaults to <taxonomy>/synthetic/.
    .OUTPUTS
        [PSCustomObject] one per matching corpus entry: node_id, statement, archetype, audience, model,
        generation_timestamp, rationale, pruned, prune_reason (and any other fields present on disk).
    .EXAMPLE
        Get-SyntheticStatement -NodeId acc-beliefs-003
        # All non-pruned synthetic statements for that Belief node.
    .EXAMPLE
        Get-SyntheticStatement acc-beliefs-003 | Select-Object -ExpandProperty statement
        # Just the statement text.
    .EXAMPLE
        Get-Tax -POV saf | Get-SyntheticStatement -IncludePruned
        # Every synthetic statement (incl. pruned) for all safetyist nodes.
    .LINK
        Show-AITriadHelp
    .LINK
        New-SyntheticCorpus
    .LINK
        Sync-SyntheticCorpus
    .LINK
        Export-SyntheticEmbeddings
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName, Position = 0)]
        [Alias('Id')]
        [ValidateNotNullOrEmpty()]
        [string]$NodeId,

        [switch]$IncludePruned,

        [string]$CorpusPath
    )

    begin {
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        if (-not $CorpusPath) { $CorpusPath = Join-Path (Get-TaxonomyDir) 'synthetic' }
        # Cache loaded POV corpora across pipeline items so piping many node ids reads each file once.
        $povCache  = @{}   # pov -> @(entries) | $null when the corpus file is absent
        $warnedPov = [System.Collections.Generic.HashSet[string]]::new()

        function Get-PovEntries {
            param([string]$Pov)
            if ($povCache.ContainsKey($Pov)) { return $povCache[$Pov] }
            $file = Join-Path $CorpusPath "corpus_$Pov.json"
            if (-not (Test-Path -LiteralPath $file)) {
                # Fallback-path logging (docs/error-handling.md): a requested node's corpus file is absent —
                # surface it once per POV rather than silently returning empty.
                if (-not $warnedPov.Contains($Pov)) {
                    Write-Warning "No synthetic corpus for POV '$Pov' at $file — run New-SyntheticCorpus first."
                    [void]$warnedPov.Add($Pov)
                }
                $povCache[$Pov] = $null
                return $null
            }
            try {
                $doc = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
            }
            catch {
                throw (New-ActionableError -AsErrorRecord `
                        -Goal     'Read synthetic statements for a BDI element' `
                        -Problem  "Synthetic corpus is not valid JSON: $file — $($_.Exception.Message)" `
                        -Location 'Get-SyntheticStatement' `
                        -NextSteps @("Inspect $file", 'Regenerate it with New-SyntheticCorpus, or repair the JSON.'))
            }
            $entries = if ($doc.PSObject.Properties['entries']) { @($doc.entries) } else { @() }
            $povCache[$Pov] = $entries
            return $entries
        }
    }

    process {
        $id = $NodeId.Trim()
        $pov = $id.Split('-')[0]
        if ([string]::IsNullOrWhiteSpace($pov) -or $pov -eq $id) {
            Write-Warning "Node id '$id' has no POV prefix ({acc|saf|skp}-…) — cannot locate its synthetic corpus."
            return
        }

        $entries = Get-PovEntries -Pov $pov
        if ($null -eq $entries) { return }   # corpus file absent (already warned)

        $matched = @($entries | Where-Object {
                $_.PSObject.Properties['node_id'] -and $_.node_id -eq $id -and
                ($IncludePruned -or -not ($_.PSObject.Properties['pruned'] -and $_.pruned))
            })

        if ($matched.Count -eq 0) {
            Write-Verbose "No synthetic statements for '$id' (pruned excluded: $(-not $IncludePruned))."
            return
        }
        $matched
    }
}
