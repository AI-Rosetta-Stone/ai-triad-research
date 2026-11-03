# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-OrgEndorsement {
    <#
    .SYNOPSIS
        t/4475 7b: an LLM judgment of whether an org claim rep ENDORSES a
        taxonomy node's proposition (entails/restates it) vs. only shares its
        topic. One Invoke-AIApi call per pair via the org-endorsement-gate
        prompt (t/4523).
    .DESCRIPTION
        Unlike the directional gate (Test-DirectionalAgreement), which wraps a
        shared local NLI engine, this is a genuine LLM call — the directional
        gate's asymmetric opposition detector cannot reject a topical-only
        match (CL t/4475#1 7b rationale).

        FAIL-SAFE: any call, parse, or out-of-enum failure resolves that pair
        to 'unknown' — never silently written as 'none'. Callers must treat
        'unknown' as "the gate didn't run", distinct from "the gate said no."
        This mirrors the AC: "WARN, not throw, on gate backend failure:
        proposals are written with endorsement: unknown."
    .PARAMETER Pair
        One or more pairs. Each is a hashtable/PSCustomObject with:
          Id        - opaque caller key echoed on the result
          ClaimProp - the org's stated position (the claim rep text)
          NodeProp  - the node's proposition (label + Core description)
          NodePov   - the node's POV camp (accelerationist/safetyist/skeptic)
        An empty collection returns an empty result (no AI call).
    .PARAMETER Model
        AI model. Default: Get-AITierModel -Tier basic (fast, cheap).
    .PARAMETER ApiKey
        API key. Forwarded to Invoke-AIApi, which resolves the rest (t/4087).
    .OUTPUTS
        One PSCustomObject per input pair (input order preserved):
          Id, Verdict ('endorses'|'partial'|'topic_only'|'unknown'), Reason
    .LINK
        Invoke-OrgClaimMatching
    .LINK
        Test-DirectionalAgreement
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.List[PSObject]])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Pair,

        [Parameter()]
        [string]$Model = (Get-AITierModel -Tier basic),

        [Parameter()]
        [string]$ApiKey = ''
    )

    Set-StrictMode -Version Latest

    $results = [System.Collections.Generic.List[PSObject]]::new()
    $pairs = @($Pair)
    if ($pairs.Count -eq 0) { return $results }

    # Read a field from a hashtable or PSCustomObject, StrictMode-safe (same
    # accessor shape as Test-DirectionalAgreement, for consistency).
    $getField = {
        param($obj, [string]$name)
        if ($null -eq $obj) { return $null }
        if ($obj -is [System.Collections.IDictionary]) {
            if ($obj.Contains($name)) { return $obj[$name] } else { return $null }
        }
        $prop = $obj.PSObject.Properties[$name]
        if ($prop) { return $prop.Value } else { return $null }
    }

    $responseSchema = @{
        type       = 'object'
        properties = @{
            verdict = @{ type = 'string'; enum = @('endorses', 'partial', 'topic_only') }
            reason  = @{ type = 'string' }
        }
        required   = @('verdict')
    }

    foreach ($p in $pairs) {
        $id = & $getField $p 'Id'
        $claimProp = [string](& $getField $p 'ClaimProp')
        $nodeProp = [string](& $getField $p 'NodeProp')
        $nodePov = [string](& $getField $p 'NodePov')

        try {
            $prompt = Get-Prompt -Name 'org-endorsement-gate' -Replacements @{
                claim     = $claimProp
                node_pov  = $nodePov
                node_prop = $nodeProp
            }
            $ai = Invoke-AIApi -Prompt $prompt -Model $Model -ApiKey $ApiKey `
                -Temperature 0.1 -MaxTokens 150 -ResponseSchema $responseSchema -TimeoutSec 15
            if (-not $ai -or -not $ai.Text) { throw 'empty response' }

            $cleanText = $ai.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
            $parsed = $cleanText.Trim() | ConvertFrom-Json
            $verdict = if ($parsed.PSObject.Properties['verdict']) { [string]$parsed.verdict } else { '' }
            if ($verdict -notin @('endorses', 'partial', 'topic_only')) {
                Write-Warning "Test-OrgEndorsement: out-of-enum verdict '$verdict' for pair '$id' — endorsement unknown"
                $verdict = 'unknown'
            }
            $reason = if ($parsed.PSObject.Properties['reason']) { [string]$parsed.reason } else { '' }
            $results.Add([PSCustomObject]@{ Id = $id; Verdict = $verdict; Reason = $reason })
        }
        catch {
            Write-Warning "Test-OrgEndorsement: gate call failed for pair '$id' — endorsement unknown: $($_.Exception.Message)"
            $results.Add([PSCustomObject]@{ Id = $id; Verdict = 'unknown'; Reason = '' })
        }
    }

    return $results
}
