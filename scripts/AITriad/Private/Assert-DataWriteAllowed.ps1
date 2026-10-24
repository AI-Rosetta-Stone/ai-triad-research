# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# ── Centralized dirty-tree-sweep guard for data-repo writes (t/2902 Part 2) ──
# The single chokepoint every data-of-record write funnels through. It asserts the
# SPECIFIC target file is clean vs HEAD before a whole-file rewrite, so concurrent
# uncommitted working-tree state can't be swept into the commit (t/2896: 128ce8f4
# swept sit-477). Per-FILE-dirty — NOT a whole-tree assertion (the data tree is
# perpetually dirty; a whole-tree gate would false-block at scale). Delegates the
# actual git check to Assert-CleanDataTree (Part 1).
#
# SCOPE (CL, t/2902#16): this guards the SAME-FILE sweep (t/2896 — a whole-file
# rewrite bundling concurrent edits to that file). It does NOT cover the CROSS-FILE
# `git add -A` sweep (the license-drift sibling) — that is the explicit-paths
# staging rule's job (root AGENTS.md junk-file-hygiene), not this per-file guard.
#
# TIERED mode (t/2909, TL ruling t/2909#3) — the guard mode is per-TARGET, not global:
#   BLOCK tier — low-traffic / usually-clean / high-sensitivity files: situations.json,
#     organization_stance_claims.json, and the registries. Real sweep prevention with
#     near-zero false-fire (usually clean between writes).
#   WARN tier  — high-traffic perpetually-dirty files (POV camp files, edges.json,
#     embeddings.json, summaries): ~always dirty from concurrent pipeline WIP, so
#     per-file Block can't tell own-WIP from foreign-WIP and would throw constantly.
#     The durable fix there is FIELD-SURGICAL writes (t/2916), not Block.
# $env:AI_TRIAD_DATA_WRITE_GUARD (Block|Warn|Off) is a GLOBAL override that wins over
# the tier for every path (testing / emergency de-escalation).

# BLOCK-tier targets by basename (case-insensitive). Keep in LOCKSTEP with the Python
# guard's _BLOCK_TIER_FILES (scripts/data_tree_guard.py) — update both together.
$script:BlockTierFiles = @(
    'situations.json'
    'organization_stance_claims.json'
    'policy_actions.json'
    'organizations.json'
    'organization_edges.json'
    'entities.json'
    'entity_mentions.json'
    # NOTE: .debate-index.json is intentionally WARN, not BLOCK (t/2909#5 GV): the
    # debate flow (lib/debate/debateIndex.ts) rewrites it every run, so it is
    # perpetually dirty and Block would false-fire on the occasional PS repair.
)
$script:DataWriteGuardMode = $null   # in-process GLOBAL override (tests); env wins if set

function Get-DataWriteGuardMode {
    <#
    .SYNOPSIS
        Resolve the guard mode for a TARGET path: Block | Warn | Off. Priority:
        $env:AI_TRIAD_DATA_WRITE_GUARD (global override) > $script:DataWriteGuardMode
        (in-process global override) > per-target TIER (Block for a BLOCK-tier basename,
        else Warn). Tiered ruling t/2909#3.
    #>
    [OutputType([string])]
    param([string]$Path)

    $envMode = [Environment]::GetEnvironmentVariable('AI_TRIAD_DATA_WRITE_GUARD')
    if (-not [string]::IsNullOrWhiteSpace($envMode)) {
        switch -Regex ($envMode.Trim()) {
            '^(?i)block$' { return 'Block' }
            '^(?i)warn$'  { return 'Warn' }
            '^(?i)off$'   { return 'Off' }
            default { Write-Warning "AI_TRIAD_DATA_WRITE_GUARD='$envMode' is not Block/Warn/Off — falling back to the per-target tier." }
        }
    }
    if ($script:DataWriteGuardMode) { return $script:DataWriteGuardMode }

    # Per-target tier (the default): BLOCK the sensitive low-traffic set; WARN otherwise.
    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        $leaf = Split-Path -Leaf $Path
        if ($script:BlockTierFiles -contains $leaf) { return 'Block' }
    }
    return 'Warn'
}

function Test-IsUnderDataRoot {
    <#
    .SYNOPSIS
        True when $Path resolves to a location under the shared data root. The guard
        only fires for data-of-record writes; non-data outputs (reports, PDFs, config,
        flight-recorder dumps) are never sweep-prone and must not be guarded.
    #>
    [OutputType([bool])]
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try { $root = Get-DataRoot } catch { return $false }
    if ([string]::IsNullOrWhiteSpace($root)) { return $false }
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
        $rootFull = [System.IO.Path]::GetFullPath($root)
    } catch { return $false }
    $sep = [System.IO.Path]::DirectorySeparatorChar
    if (-not $rootFull.EndsWith($sep)) { $rootFull += $sep }
    return $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DataWriteAllowed {
    <#
    .SYNOPSIS
        Sink-level dirty-tree-sweep guard. Call immediately before any whole-file
        rewrite of a data-repo file. No-op unless the target is under the data root
        AND already carries uncommitted changes.
    .PARAMETER Path
        The target file about to be overwritten.
    .PARAMETER AllowDirty
        Opt-out for a writer that legitimately rewrites a target left dirty by a
        prior pass in the same sequence (t/2902 condition 4). Bypasses the guard.
        Semantics: "the tree is dirty and I am choosing to ignore that" — a blanket
        override. Do NOT use it for surgical writes; use -SurgicalWrite (below).
    .PARAMETER SurgicalWrite
        Distinct, semantically-honest exemption for a FIELD-SURGICAL write (t/2916,
        TL ruling t/2916#8). Its claim is NOT "ignore the dirty tree" but "this write
        is sweep-proof BY CONSTRUCTION, so the dirty-tree check is N/A." Earned only by
        Save-JsonNodeFieldEdits, whose every write passes the re-parse-verify invariant
        (once per batch, against the fresh read with all edits applied) + byte-identical
        foreign-WIP preservation (proven in Update-JsonNodeField tests 5/7,
        Save-JsonNodeFieldEdits.Tests.ps1 batch-verify arms, and
        SurgicalWriteExemption.Tests.ps1). Kept
        SEPARATE from -AllowDirty on purpose: the two carry different risk profiles, and
        overloading one flag would make a `grep -AllowDirty` unable to tell "provably
        safe surgical" from "blanket override — scrutinize." Reachable only via the
        orchestrator (enforced by the detection gate in SurgicalWriteExemption.Tests.ps1),
        so a whole-file writer cannot claim it and bypass the BLOCK tier.
    .OUTPUTS
        None. In Block mode a dirty data-target throws (New-ActionableError via
        Assert-CleanDataTree); in Warn mode it warns and proceeds.
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [switch]$AllowDirty,

        [switch]$SurgicalWrite
    )
    # t/4454: a write to the protected (real) data root from inside a Pester run is reported first, before
    # every exemption below: -SurgicalWrite / -AllowDirty / mode Off don't apply to test runs (TL t/4454#3
    # condition 5). It refuses (throws) after logging DATA-ROOT-TEST-WRITE (Phase 2).
    $null = Invoke-DataRootTestWriteCheck -Path $Path

    # t/2916 Fork 2 (TL t/2916#8) — surgical-write exemption. A field-surgical write is
    # sweep-proof by construction (re-parse-verify + byte-identical preservation), so the
    # dirty-tree check is N/A: return BEFORE consulting the tier or the tree. This is the
    # one write that is SAFE on a dirty BLOCK-tier file; blocking it would defeat t/2916.
    # Kept distinct from -AllowDirty (blanket override) so the audit trail stays honest.
    if ($SurgicalWrite) { return }
    if ($AllowDirty) { return }
    $mode = Get-DataWriteGuardMode -Path $Path   # per-target tier (t/2909)
    if ($mode -eq 'Off') { return }
    if (-not (Test-IsUnderDataRoot -Path $Path)) { return }

    if ($mode -eq 'Block') {
        Assert-CleanDataTree -Path $Path            # dirty data-target -> throw
    }
    else {
        # Warn: dirty -> warn, proceed
        Assert-CleanDataTree -Path $Path -Force -ForceReason 'data-write guard is in Warn mode for this target; it will block once promoted'
    }
}
