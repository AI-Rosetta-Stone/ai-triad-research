# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Bounded-retry classifier for resolving a brand-new revision's FQDN (t/4822).

.DESCRIPTION
t/4822: "Health check new revision" queried the new revision's FQDN exactly once,
immediately after revision creation, before Wait-RevisionActivation's own polling loop
ever ran. ARM/ACA can take a few seconds to populate `properties.fqdn` on a revision
that's still `Activating` — reproduced twice (runs 41660425655, 41662045970), the second
time even after the health-check loop itself needed 2 rounds to see the revision go
Activating -> Healthy, proving the FQDN query doesn't self-heal by the caller waiting
longer elsewhere. An empty FQDN routes into the t/4513 fail-closed gate (correctly —
probing the fallback app URL would vacuously pass against the OLD, still-serving
revision, the exact t/4504 shape), so every deploy rolled back despite the new revision
being perfectly healthy.

This closes the gap the same way Get-MountReadinessVerdict.ps1 closes the analogous SMB
mount-attach propagation gap: a bounded retry before falling back. A transient
not-yet-assigned FQDN clears within a few rounds; a revision that never gets one (e.g.
provisioning genuinely failed) still falls through to the existing fail-closed path once
MaxAttempts is exhausted.

PURE: Get-RevisionFqdnVerdict takes only the probed FQDN and attempt bookkeeping, no I/O.
Wait-RevisionFqdn is the injected-probe retry loop (same DI pattern as Wait-MountReady /
Wait-RevisionActivation), so the loop logic itself is unit-tested without touching Azure.
#>

function Get-RevisionFqdnVerdict {
    [CmdletBinding()]
    param(
        [AllowNull()][AllowEmptyString()][string] $Fqdn,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int] $Attempt,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int] $MaxAttempts
    )
    if (-not [string]::IsNullOrWhiteSpace($Fqdn)) {
        return [pscustomobject]@{ Verdict = 'resolved'; Fqdn = $Fqdn; Attempt = $Attempt }
    }
    if ($Attempt -ge $MaxAttempts) {
        return [pscustomobject]@{ Verdict = 'unresolved'; Fqdn = $null; Attempt = $Attempt }
    }
    return [pscustomobject]@{ Verdict = 'retry'; Fqdn = $null; Attempt = $Attempt }
}

<#
.SYNOPSIS
The bounded revision-FQDN resolution loop the deploy workflow runs right after creating
the new revision, before the health check probes it (t/4822).

.DESCRIPTION
Each round runs the injected Probe scriptblock (expected to return the FQDN string, or
null/empty when not yet assigned) and classifies it with Get-RevisionFqdnVerdict. Stops
on the first 'resolved', or after MaxAttempts rounds with 'unresolved'. Sleeps
IntervalSeconds between rounds, never after the last one. Mirrors Wait-MountReady's
contract: an exception from Probe is NOT caught here — a genuine defect must propagate
on the first attempt rather than being retried as "not yet assigned".
#>
function Wait-RevisionFqdn {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $Probe,
        [ValidateRange(1, 20)][int] $MaxAttempts = 6,
        [ValidateRange(0, 60)][int] $IntervalSeconds = 5
    )
    $attempt = 0
    $verdict = $null
    do {
        $attempt++
        $fqdn = & $Probe
        $verdict = Get-RevisionFqdnVerdict -Fqdn $fqdn -Attempt $attempt -MaxAttempts $MaxAttempts
        Write-Host "revision-fqdn round ${attempt}/${MaxAttempts}: verdict=$($verdict.Verdict)"
        if ($verdict.Verdict -ne 'retry') { break }
        Start-Sleep -Seconds $IntervalSeconds
    } while ($attempt -lt $MaxAttempts)

    [pscustomobject]@{
        Verdict  = $verdict.Verdict
        Fqdn     = $verdict.Fqdn
        Attempts = $attempt
    }
}
