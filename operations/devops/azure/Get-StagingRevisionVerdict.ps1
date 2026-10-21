<#
.SYNOPSIS
    Pure predicate for t/4376: create, reuse, or refuse the deterministic `staging-<sha7>` revision.

.DESCRIPTION
    deploy-staging.yml names each new revision `staging-<sha7>`. ACA revision names are immutable, so
    a re-run of a run that already created its revision (a success, or a smoke failure after creation)
    used to fail `az containerapp update --revision-suffix` with "revision with suffix ... already
    exists". The rejected template then stayed as the app's desired state: provisioningState=Failed,
    and every later app write (including the rollback traffic set) was rejected the same way.

    `Get-StagingRevisionVerdict` takes the already-gathered facts (the existing revision's image, or
    $null if no revision has that name) and returns one of:
      - 'create' — no revision with this name exists; create it as before.
      - 'reuse'  — it exists with the intended image; reuse it (activate if needed), don't create.
      - 'refuse' — it exists with a DIFFERENT image. The suffix encodes the built commit, so this
                   should never happen; fail closed rather than promote something unexpected.

    The workflow step (CLI wrapper, not duplicated here) does the `az containerapp revision show` call
    and feeds its result in — kept out of this file so the decision is testable without Azure state.
#>

function Get-StagingRevisionVerdict {
    param(
        [string]$ExistingImage,
        [Parameter(Mandatory)]
        [string]$ExpectedImageRef
    )
    if ([string]::IsNullOrWhiteSpace($ExistingImage)) {
        return [PSCustomObject]@{ Action = 'create'; Reason = 'no-existing-revision' }
    }
    if ($ExistingImage -eq $ExpectedImageRef) {
        return [PSCustomObject]@{ Action = 'reuse'; Reason = 'existing-revision-same-image' }
    }
    return [PSCustomObject]@{ Action = 'refuse'; Reason = 'existing-revision-different-image' }
}
