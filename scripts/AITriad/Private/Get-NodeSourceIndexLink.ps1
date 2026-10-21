# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

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
        [Parameter(Mandatory)][System.Collections.Generic.HashSet[string]]$Live
    )
    Set-StrictMode -Version Latest
    $prop = { param($o, $n) if ($null -ne $o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }

    $povs = & $prop $Summary 'pov_summaries'
    if ($povs) {
        foreach ($pov in $povs.PSObject.Properties.Name) {
            $block = $povs.$pov
            if (-not ($block.PSObject.Properties['key_points'])) { continue }
            foreach ($kp in @($block.key_points)) {
                $nid = [string](& $prop $kp 'taxonomy_node_id')
                if (-not $nid -or -not $Live.Contains($nid)) { continue }
                $v = & $prop $kp 'verbatim'; $pt = & $prop $kp 'point'
                $q = if ($null -ne $v) { [string]$v } else { '' }
                $cmp = if (-not [string]::IsNullOrWhiteSpace($q)) { $q } elseif ($pt -is [string]) { $pt } else { '' }
                [pscustomobject]@{
                    node = $nid; field = 'key_point'; quote = $cmp
                    payload = [pscustomobject]@{
                        source_id = $SourceId; link_source = 'key_point'; quote = $q
                        doc_position = $null; evidence_level = $null; extraction_confidence = (& $prop $kp 'extraction_confidence')
                    }
                }
            }
        }
    }

    foreach ($fc in @(& $prop $Summary 'factual_claims')) {
        if ($null -eq $fc -or -not $fc.PSObject.Properties['linked_taxonomy_nodes']) { continue }
        $q = [string](& $prop $fc 'claim')
        foreach ($nid in @($fc.linked_taxonomy_nodes)) {
            $nid = [string]$nid
            if (-not $nid -or -not $Live.Contains($nid)) { continue }
            [pscustomobject]@{
                node = $nid; field = 'factual_claim'; quote = $q
                payload = [pscustomobject]@{
                    source_id = $SourceId; link_source = 'factual_claim'; quote = $q
                    doc_position = (& $prop $fc 'doc_position'); evidence_level = (& $prop $fc 'evidence_criteria')
                    extraction_confidence = (& $prop $fc 'extraction_confidence')
                }
            }
        }
    }
}
