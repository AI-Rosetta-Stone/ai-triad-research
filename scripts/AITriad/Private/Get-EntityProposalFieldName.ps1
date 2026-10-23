# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Allowlist of proposal fields Import-Entity accepts — the Entity contract field set (t/3133).
.DESCRIPTION
    Any `-Proposal` key outside this set is an UNKNOWN field and is rejected loudly by Import-Entity,
    instead of being silently dropped. Silent drop is the t/3118 near-miss: a stale (pre-t/3131)
    module didn't read `description_provenance`, dropped it, and the grandfather rule would have
    auto-approved unedited AI drafts. Loud rejection turns any stale-code / typo'd-field case into an
    immediate failure rather than silent data-correctness drift.

    This list MUST match the Entity contract (lib/entities/types.ts). The Entity drift-parity test
    asserts the two stay in sync, so a newly-added contract field can't be silently rejected here.
    `created_at` / `last_modified` are contract fields the cmdlet manages (ignored if echoed on a
    proposal) — included so a full-record round-trip is tolerated, not rejected.
#>
function Get-EntityProposalFieldName {
    [OutputType([string[]])]
    param()
    @(
        'id'
        'name'
        'aliases'
        'entity_type'
        'dolce_category'
        'description'
        'status'
        'created_at'
        'last_modified'
        'description_provenance'
        'external_refs'
        'source_refs'
        'source_refs_basis'    # t/4404
        'source_refs_status'   # t/4404
        'relations'
        'merged_into'
        'discovered_by'
        'confidence'
    )
}
