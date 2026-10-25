# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate: should the post-deploy AC2 check (t/4242) trigger a rollback? (t/4309)
.DESCRIPTION
    t/4309: deploy-azure.yml's existing rollback step only triggers on health_check/
    acceptance/persona/warm_gate failure. AC2 (serving revision active + weight 100 +
    /health 200) runs afterward and, until this fix, only alerts -- prod can keep serving a
    revision AC2 just declared broken until a human acts.

    SO review (e/360#2) found the real gap in a naive "ac2Failed -> rollback" design: AC2's
    own `if:` condition is `acceptance == 'true' && persona == 'true'` -- it is NOT gated on
    health_check or warm_gate. So in a run where warm_gate failed, the EXISTING "Rollback on
    failure" step has already fired before AC2 even runs. AC2 then finds the (now-inactive,
    now-disabled) new revision unhealthy and reports failed -- a naive predicate would fire a
    SECOND rollback aimed at the revision that's already serving, at best a no-op, at worst a
    spurious sev-1 alert on an already-healthy prod.

    Four arms (SO condition C1):
      - No AC2 failure: no action.
      - AC2 failure, no earlier rollback, first check (not a recheck): roll back once.
      - AC2 failure, no earlier rollback, IS a recheck (we already rolled back and re-checked):
        the rollback target itself fails AC2 -- stop, do not roll back again, alert sev-1.
      - AC2 failure, an earlier rollback ALREADY fired this run (health_check/acceptance/
        persona/warm_gate failed first): never roll back a second time. Go straight to
        checking AC2 against the already-restored revision; on failure, sev-1 directly (no
        rollback attempt -- there's nothing further to roll back TO).
.PARAMETER Ac2Failed
    True if the serving-revision-active/weight-100//health check failed on this check.
.PARAMETER EarlierRollbackFired
    True if the workflow's existing "Rollback on failure" step already ran THIS run, derived
    from the EXACT SAME expression that step's own `if:` uses
    (health_check/acceptance/persona/warm_gate), never a separate guess (SO condition C1).
.PARAMETER IsPostRollbackRecheck
    True when this AC2 evaluation is the one-time recheck AFTER this predicate itself already
    returned 'rollback' earlier in the same run (the caller tracks this; the predicate is
    stateless). Never true in the same call where EarlierRollbackFired is also true -- those
    are two different prior-rollback sources (the predicate's own vs. the pre-existing gates'),
    and the predicate doesn't need to distinguish them: EITHER one means "don't roll back
    again".
.OUTPUTS
    [PSCustomObject] { Action = 'none' | 'rollback' | 'stop-alert-sev1'; Reason = [string] }
#>
function Get-PostDeployRollbackVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [bool] $Ac2Failed,
        [Parameter(Mandatory)] [bool] $EarlierRollbackFired,
        [Parameter(Mandatory)] [bool] $IsPostRollbackRecheck
    )

    if (-not $Ac2Failed) {
        return [PSCustomObject]@{ Action = 'none'; Reason = 'AC2 passed' }
    }

    if ($EarlierRollbackFired -or $IsPostRollbackRecheck) {
        $why = if ($EarlierRollbackFired) {
            'an earlier gate (health_check/acceptance/persona/warm_gate) already rolled back this run -- AC2 is checking the already-restored revision, which also failed'
        } else {
            'the rollback target itself failed the post-rollback AC2 recheck'
        }
        return [PSCustomObject]@{
            Action = 'stop-alert-sev1'
            Reason = "AC2 failed and a rollback has already been attempted this run ($why) -- not rolling back again. Leaving traffic as-is."
        }
    }

    return [PSCustomObject]@{
        Action = 'rollback'
        Reason = 'AC2 failed on the first check this run, with no earlier rollback -- rolling back to the captured prior revision.'
    }
}
