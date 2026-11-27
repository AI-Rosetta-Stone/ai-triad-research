# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-DirectionalJudge {
    <#
    .SYNOPSIS
        Stage-2 LLM directional-agreement judge for the polarity gate (t/2900).
    .DESCRIPTION
        The deberta engine (stage 1) over-flags `opposes` on the agency→loss claim
        pattern — it cannot infer *AI-gains-agency ⊨ humans-lose-oversight*, so it
        reads a capability claim as contradicting a loss-of-control proposition
        (t/2896#1). This LLM judge (gemini-3.1-pro-preview) makes the propositional
        discrimination deberta structurally can't, on ONLY the candidates deberta
        already flagged (cost-bounded to the tiny opposes subset).

        CONTRACT (TL design approval t/2900#7):
        - N draws at temp 0.3 (NOT 0): at temp 0 the draws are near-identical and
          only catch transient errors; at 0.3 the draw variance measures borderline
          confidence, so unanimity becomes a real confidence bar.
        - Returns 'opposes' ONLY on UNANIMOUS 'opposes' across all N draws — the
          destructive flip must clear a high bar (a false flip is the incident class;
          a false keep is fail-safe status quo).
        - FAIL-SAFE: any API error / malformed JSON / invalid direction / non-unanimous
          result → a non-'opposes' verdict, so the caller KEEPS the LLM mapping and
          never false-demotes.
    .PARAMETER Claim
        The claim representation deberta flagged (verbatim / canonical / attribution).
    .PARAMETER NodeProp
        The assigned node's proposition (label + Core), as built by the gate.
    .PARAMETER Camp
        The camp the claim is attributed to (accelerationist / safetyist / skeptic).
    .PARAMETER Model
        Judge model (default gemini-3.1-pro-preview, pinned: the CL rec, registered in ai-models.json). It deliberately does not follow the Advanced tier, so a change of tier does not change the judge (t/781).
    .PARAMETER Temperature
        Sampling temp (default 0.3 — see contract).
    .PARAMETER Draws
        Number of independent draws (default 3); unanimity required to confirm opposes.
    .OUTPUTS
        [string] one of 'opposes' | 'agrees' | 'unrelated' | 'unresolved'. Only
        'opposes' confirms a flip; everything else is a KEEP.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Claim,
        [Parameter(Mandatory)][string]$NodeProp,
        [Parameter(Mandatory)][string]$Camp,
        [string]$Model = 'gemini-3.1-pro-preview',  # research judge, pinned (t/781, Comp-Linguist): its frozen gates were validated on this model, so it does not follow the Advanced tier
        [ValidateRange(0.0, 2.0)][double]$Temperature = 0.3,
        [ValidateRange(1, 9)][int]$Draws = 3
    )
    Set-StrictMode -Version Latest

    $system = Get-Prompt -Name 'directional-judge'
    $user = "CAMP: $Camp`nCLAIM: $Claim`nNODE: $NodeProp"

    $seen = [System.Collections.Generic.List[string]]::new()
    for ($d = 0; $d -lt $Draws; $d++) {
        $resp = try {
            Invoke-AIApi -SystemInstruction $system -Prompt $user -Model $Model `
                -Temperature $Temperature -JsonMode -MaxTokens 900
        } catch { $null }

        # API failure → fail-safe KEEP (abandon remaining draws; unresolved never flips).
        if (-not $resp -or -not $resp.PSObject.Properties['Text'] -or [string]::IsNullOrWhiteSpace([string]$resp.Text)) {
            return 'unresolved'
        }

        $parsed = try { $resp.Text | ConvertFrom-Json } catch { $null }
        if (-not $parsed -or -not $parsed.PSObject.Properties['direction']) { return 'unresolved' }

        $dir = ([string]$parsed.direction).Trim().ToLowerInvariant()
        if ($dir -notin @('opposes', 'agrees', 'unrelated')) { return 'unresolved' }
        $seen.Add($dir)

        # Early-out: the first non-'opposes' draw already breaks unanimity → KEEP.
        if ($dir -ne 'opposes') { return $dir }
    }

    # All draws returned 'opposes' → unanimous → confirm the flip.
    return 'opposes'
}
