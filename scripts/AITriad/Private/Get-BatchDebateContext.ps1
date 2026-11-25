# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-BatchDebateContext {
    <#
    .SYNOPSIS
        Invoke-BatchSummary STEP 5b (t/3910): map each contested taxonomy node to the
        debates whose harvest applied a debate_ref to it.
    .DESCRIPTION
        Reads every harvests/*.json manifest; an unreadable manifest is skipped (Verbose).
        Returns @{ <nodeId> = @(<debate name>, ...) }, empty when there are no harvests.

        A debate is named by its `debate_title` when the manifest has one, and by its
        `debate_id` when it does not. Manifests the server writes after t/629 carry no title:
        it is the user's own text and is kept out of the public data repo. Older manifests
        still have it. Under strict mode a bare read of the missing field threw, the catch
        skipped the whole manifest, and its debates were lost with only a Verbose line. A
        manifest with neither field is skipped with a WARN.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$HarvestsDir)

    $DebateContext = @{}
    $NamedById = 0
    if (Test-Path $HarvestsDir) {
        foreach ($ManifestFile in (Get-ChildItem $HarvestsDir -Filter '*.json' -ErrorAction SilentlyContinue)) {
            try {
                $Manifest = Get-Content $ManifestFile.FullName -Raw | ConvertFrom-Json
                $Props = $Manifest.PSObject.Properties
                $DebateName = $null
                if ($Props['debate_title'] -and -not [string]::IsNullOrWhiteSpace([string]$Manifest.debate_title)) {
                    $DebateName = [string]$Manifest.debate_title
                }
                elseif ($Props['debate_id'] -and -not [string]::IsNullOrWhiteSpace([string]$Manifest.debate_id)) {
                    $DebateName = [string]$Manifest.debate_id
                    $NamedById++
                }
                else {
                    Write-Warning "Get-BatchDebateContext: harvest manifest $($ManifestFile.Name) has neither debate_title nor debate_id; skipped, so its debates are not in the batch's debate context."
                    continue
                }
                if (-not $Props['items'] -or $null -eq $Manifest.items) { continue }
                foreach ($Item in @($Manifest.items)) {
                    if ($null -eq $Item) { continue }
                    $ItemProps = $Item.PSObject.Properties
                    if (-not ($ItemProps['type'] -and $ItemProps['status'] -and $ItemProps['id'])) { continue }
                    if ($Item.type -eq 'debate_ref' -and $Item.status -eq 'applied') {
                        $NodeId = $Item.id
                        if (-not $DebateContext.ContainsKey($NodeId)) { $DebateContext[$NodeId] = @() }
                        $DebateContext[$NodeId] += $DebateName
                    }
                }
            }
            catch {
                Write-Verbose "Skipping harvest manifest $($ManifestFile.Name): $_"
            }
        }
    }
    if ($NamedById -gt 0) {
        # A fallback, so it is said once: these debates reach the prompt as ids, not titles.
        Write-Warning "Get-BatchDebateContext: $NamedById harvest manifest(s) have no debate_title (the server no longer writes it, t/629); their debates are named by debate_id in the batch's debate context."
    }
    if ($DebateContext.Count -gt 0) {
        Write-Info "  Loaded debate context for $($DebateContext.Count) contested nodes"
    }
    return $DebateContext
}
