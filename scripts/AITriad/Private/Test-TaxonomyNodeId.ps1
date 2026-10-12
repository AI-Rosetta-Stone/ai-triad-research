# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Shared taxonomy node ID validator — loads all node IDs into a HashSet
# for O(1) lookup. Used by Invoke-DocumentSummary (gap 3.1),
# Find-PolicyAction (gap 6.1), Invoke-EdgeDiscovery (gap 7.1), etc.

$script:TaxonomyNodeIdSet = $null
$script:TaxonomyNodeIdSetTimestamp = [datetime]::MinValue

function Get-TaxonomyNodeIdSet {
    <#
    .SYNOPSIS
        Returns a HashSet of all valid taxonomy node IDs.
    .DESCRIPTION
        Loads node IDs from the four taxonomy JSON files (accelerationist, safetyist,
        skeptic, situations) plus policy IDs from policy_actions.json. Caches the
        result and refreshes if files are newer than the cached version.

        The set is returned with the comma operator so it reaches the caller as the
        HashSet itself. A bare `return $IdSet` unrolls it into object[] (or a single
        string), losing the OrdinalIgnoreCase comparer (t/4144).
    #>
    $TaxDir = Get-TaxonomyDir
    if (-not $TaxDir -or -not (Test-Path $TaxDir)) {
        Write-Verbose "Test-TaxonomyNodeId: taxonomy dir not found — validation skipped"
        return $null
    }

    $TaxFiles = @("accelerationist.json", "safetyist.json", "skeptic.json", "situations.json")
    $LatestMtime = [datetime]::MinValue
    foreach ($f in $TaxFiles) {
        $p = Join-Path $TaxDir $f
        if (Test-Path $p) {
            $mt = (Get-Item $p).LastWriteTimeUtc
            if ($mt -gt $LatestMtime) { $LatestMtime = $mt }
        }
    }

    if ($null -ne $script:TaxonomyNodeIdSet -and $LatestMtime -le $script:TaxonomyNodeIdSetTimestamp) {
        return , $script:TaxonomyNodeIdSet
    }

    $IdSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($f in $TaxFiles) {
        $p = Join-Path $TaxDir $f
        if (-not (Test-Path $p)) { continue }
        try {
            $Data = Get-Content $p -Raw | ConvertFrom-Json
            if ($Data.nodes) {
                foreach ($Node in $Data.nodes) {
                    if ($Node.id) { [void]$IdSet.Add($Node.id) }
                }
            }
        } catch {
            Write-Verbose "Test-TaxonomyNodeId: failed to load $f — $($_.Exception.Message)"
        }
    }

    $PolicyPath = Join-Path $TaxDir 'policy_actions.json'
    if (Test-Path $PolicyPath) {
        try {
            $PolicyReg = Get-Content -Raw -Path $PolicyPath | ConvertFrom-Json
            if ($PolicyReg.policies) {
                foreach ($pol in $PolicyReg.policies) {
                    if ($pol.id) { [void]$IdSet.Add($pol.id) }
                }
            }
        } catch {
            Write-Verbose "Test-TaxonomyNodeId: failed to load policy_actions.json — $($_.Exception.Message)"
        }
    }

    $script:TaxonomyNodeIdSet = $IdSet
    $script:TaxonomyNodeIdSetTimestamp = $LatestMtime
    Write-Verbose "Test-TaxonomyNodeId: loaded $($IdSet.Count) node IDs"
    return , $IdSet
}

function Test-TaxonomyNodeId {
    <#
    .SYNOPSIS
        Returns $true if the given node ID exists in the taxonomy.
    .PARAMETER NodeId
        The node ID to validate (e.g. 'acc-beliefs-042').
    #>
    param([string]$NodeId)

    if ([string]::IsNullOrWhiteSpace($NodeId)) { return $false }

    $IdSet = Get-TaxonomyNodeIdSet
    # An empty set used to unroll to $null (validation skipped); keep that meaning now that the set
    # arrives intact (t/4144).
    if ($null -eq $IdSet -or $IdSet.Count -eq 0) { return $true }

    return $IdSet.Contains($NodeId)
}
