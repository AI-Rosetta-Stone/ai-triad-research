# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure decision for deploy-azure.yml's "retire-previous-revision" job (t/266 option b).

.DESCRIPTION
    After a prod deploy, the previous revision stays active at 0% traffic as the rollback target.
    It was found holding a replica for hours with zero requests and no KEDA events (t/264, t/266#4),
    pushing billed vCPU-h over budget on 4 consecutive days (t/260#6). The TL ruling (t/266#5) is to
    deactivate it, but only after AC2 passed AND a 15-minute green soak, and never on any failure.

    This function takes every input the workflow already has and returns a verdict. It calls no Azure
    API, so both arms are testable without live state. Fail-safe by construction: every input must
    positively say "safe", and anything missing, unknown or failed returns 'keep'.

    Returns @{ Action = 'retire' | 'keep'; Reason = <string> }.

    'retire' needs ALL of:
      - AC2 passed (Ac2Failed is exactly 'false'; empty means AC2 never ran, which is not a pass)
      - no earlier gate rollback (EarlierRollbackFired is exactly 'false'; when it fired, AC2 checked
        the PREVIOUS revision, which is serving again and must never be retired)
      - the soak passed (SoakPassed is exactly 'true')
      - a previous revision exists and differs from the new one
      - fresh reads: the new revision serves at weight 100 and the previous one is at weight 0
#>

function Get-PreviousRevisionRetireVerdict {
    param(
        [AllowEmptyString()][string]$Ac2Failed,
        [AllowEmptyString()][string]$EarlierRollbackFired,
        [AllowEmptyString()][string]$SoakPassed,
        [AllowEmptyString()][string]$PreviousRevision,
        [AllowEmptyString()][string]$NewRevision,
        # Fresh reads taken immediately before the decision; $null = could not read (never treated as 0/100).
        [Nullable[int]]$NewRevisionWeight,
        [Nullable[int]]$PreviousRevisionWeight
    )

    function Keep([string]$why) { @{ Action = 'keep'; Reason = $why } }

    if ($Ac2Failed -ne 'false') { return Keep "AC2 did not pass (failed='$Ac2Failed')" }
    if ($EarlierRollbackFired -ne 'false') { return Keep "an earlier gate rollback fired or is unknown (fired='$EarlierRollbackFired'); the previous revision may be serving" }
    if ($SoakPassed -ne 'true') { return Keep "the 15-minute soak did not pass (passed='$SoakPassed')" }
    if ([string]::IsNullOrWhiteSpace($PreviousRevision)) { return Keep 'no previous revision (first deploy, or it was not captured)' }
    if ([string]::IsNullOrWhiteSpace($NewRevision)) { return Keep 'the new revision name is unknown' }
    if ($PreviousRevision -eq $NewRevision) { return Keep "the previous and new revision are the same ('$NewRevision')" }
    if ($null -eq $NewRevisionWeight) { return Keep "could not read the new revision's traffic weight" }
    if ($NewRevisionWeight -ne 100) { return Keep "the new revision serves at weight $NewRevisionWeight, not 100" }
    if ($null -eq $PreviousRevisionWeight) { return Keep "could not read the previous revision's traffic weight" }
    if ($PreviousRevisionWeight -ne 0) { return Keep "the previous revision still has weight $PreviousRevisionWeight" }

    @{ Action = 'retire'; Reason = "AC2 passed, soak green, '$NewRevision' serves at 100 and '$PreviousRevision' is at 0" }
}
