# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-NodeSourceIndexLinkProp {
    # Safe property read: value of property $Name on $Object, or $null when absent.
    param($Object, [string]$Name)
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null }
}

function Resolve-NodeSourceIndexId {
    # Fold a node id through the superseded->survivor map; ids pass through when the map is absent.
    param([string]$Id, [System.Collections.Generic.IDictionary[string, string]]$ResolveMap)
    if ($Id -and $ResolveMap -and $ResolveMap.ContainsKey($Id)) { $ResolveMap[$Id] } else { $Id }
}

function Get-NodeSourceIndexKeyPointLink {
    # Key-point (taxonomy_node_id) links on live nodes, as spec 7.1.
    param(
        $Summary, [string]$SourceId,
        [System.Collections.Generic.HashSet[string]]$Live,
        [System.Collections.Generic.IDictionary[string, string]]$ResolveMap
    )
    $povs = Get-NodeSourceIndexLinkProp $Summary 'pov_summaries'
    if (-not $povs) { return }
    foreach ($pov in $povs.PSObject.Properties.Name) {
        $block = $povs.$pov
        if (-not ($block.PSObject.Properties['key_points'])) { continue }
        foreach ($kp in @($block.key_points)) {
            $nid = [string](Resolve-NodeSourceIndexId ([string](Get-NodeSourceIndexLinkProp $kp 'taxonomy_node_id')) $ResolveMap)
            if (-not $nid -or -not $Live.Contains($nid)) { continue }
            $v = Get-NodeSourceIndexLinkProp $kp 'verbatim'; $pt = Get-NodeSourceIndexLinkProp $kp 'point'
            $q = if ($null -ne $v) { [string]$v } else { '' }
            $cmp = if (-not [string]::IsNullOrWhiteSpace($q)) { $q } elseif ($pt -is [string]) { $pt } else { '' }
            [pscustomobject]@{
                node = $nid; field = 'key_point'; quote = $cmp
                payload = [pscustomobject]@{
                    source_id = $SourceId; link_source = 'key_point'; quote = $q
                    doc_position = $null; evidence_level = $null; extraction_confidence = (Get-NodeSourceIndexLinkProp $kp 'extraction_confidence')
                }
            }
        }
    }
}

function Get-NodeSourceIndexClaimLink {
    # Factual-claim (linked_taxonomy_nodes) links on live nodes, as spec 7.1.
    param(
        $Summary, [string]$SourceId,
        [System.Collections.Generic.HashSet[string]]$Live,
        [System.Collections.Generic.IDictionary[string, string]]$ResolveMap
    )
    foreach ($fc in @(Get-NodeSourceIndexLinkProp $Summary 'factual_claims')) {
        if ($null -eq $fc -or -not $fc.PSObject.Properties['linked_taxonomy_nodes']) { continue }
        $q = [string](Get-NodeSourceIndexLinkProp $fc 'claim')
        foreach ($nid in @($fc.linked_taxonomy_nodes)) {
            $nid = [string](Resolve-NodeSourceIndexId ([string]$nid) $ResolveMap)
            if (-not $nid -or -not $Live.Contains($nid)) { continue }
            [pscustomobject]@{
                node = $nid; field = 'factual_claim'; quote = $q
                payload = [pscustomobject]@{
                    source_id = $SourceId; link_source = 'factual_claim'; quote = $q
                    doc_position = (Get-NodeSourceIndexLinkProp $fc 'doc_position'); evidence_level = (Get-NodeSourceIndexLinkProp $fc 'evidence_criteria')
                    extraction_confidence = (Get-NodeSourceIndexLinkProp $fc 'extraction_confidence')
                }
            }
        }
    }
}

function Get-NodeSourceIndexLink {
    <#
    .SYNOPSIS
        One summary's live-node links for Build-NodeSourceIndex, as spec section 7 links whose
        payload is the source-index entry.
    .DESCRIPTION
        Key points (taxonomy_node_id) and factual claims (linked_taxonomy_nodes) on live nodes only.
        Each link's quote is the spec 7.1 comparison quote (a key point's verbatim, else its point;
        a claim's text). Its payload is the index entry exactly as Build-NodeSourceIndex has always
        written it (a key point's quote field stays its verbatim, or '' when there is none), so an
        index built without duplicate marks is byte-identical to before.
    .OUTPUTS
        [pscustomobject] { node; field; quote; payload }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]$Summary,
        [Parameter(Mandatory)][string]$SourceId,
        [Parameter(Mandatory)][System.Collections.Generic.HashSet[string]]$Live,
        # Superseded id -> survivor (Get-LiveBeliefNodeIds). A link to a superseded node is indexed under the
        # survivor (t/4441, t/4278 C1); absent or empty, ids are used as written.
        [System.Collections.Generic.IDictionary[string, string]]$ResolveMap
    )
    Set-StrictMode -Version Latest
    Get-NodeSourceIndexKeyPointLink -Summary $Summary -SourceId $SourceId -Live $Live -ResolveMap $ResolveMap
    Get-NodeSourceIndexClaimLink -Summary $Summary -SourceId $SourceId -Live $Live -ResolveMap $ResolveMap
}
