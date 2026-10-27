# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Bounded-retry classifier for the deploy pipeline's mount-readiness probe (t/4513).

.DESCRIPTION
t/4504: revision `taxonomy-editor--deploy-a564db3-10951`'s pre-traffic smoke failed 30/33 checks
49-90s after the revision was created — `GET /api/taxonomy/accelerationist` returned 500
(`Taxonomy file not found: /mnt/shared/taxonomy/Origin/accelerationist.json`), while the sibling
revision serving prod throughout read the same file on the same share without error. "Health
check new revision" (Get-RevisionActivationVerdict.ps1) had already passed by then — it probes
`/health`/`/healthz` (server up, data loaded), neither of which reads an arbitrary taxonomy file.
Diagnosis (t/4504#11) ruled out Bicep/config/secret differences; the working theory is a brand-new
replica's Azure Files (`azureFile`, native ACA volume mount) SMB attach having a short propagation
window before reads are fully reliable.

This probe closes that gap: after the health check passes and before the pre-traffic smoke runs,
read one small known-stable file through the new revision's own FQDN, with a bounded retry. A
transient attach race clears within a couple of retries; a real missing/broken mount does not, and
fails the deploy the same way an unhealthy health check does today (no silent skip, t/4249's rule).

PURE: Get-MountReadinessVerdict takes only attempt bookkeeping and the probe's bool result, no I/O.
Wait-MountReady is the injected-probe retry loop (same DI pattern as Wait-RevisionActivation,
Get-RevisionActivationVerdict.ps1), so the loop logic itself is unit-tested without touching Azure.
#>

function Get-MountReadinessVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][bool] $ProbeSucceeded,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int] $Attempt,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int] $MaxAttempts
    )
    if ($ProbeSucceeded) {
        return [pscustomobject]@{ Verdict = 'ready'; Attempt = $Attempt }
    }
    if ($Attempt -ge $MaxAttempts) {
        return [pscustomobject]@{ Verdict = 'failed'; Attempt = $Attempt }
    }
    return [pscustomobject]@{ Verdict = 'retry'; Attempt = $Attempt }
}

<#
.SYNOPSIS
The bounded mount-readiness loop the deploy workflow runs between the health check and the
pre-traffic smoke (t/4513).

.DESCRIPTION
Each round runs the injected Probe scriptblock and classifies its $true/$false result with
Get-MountReadinessVerdict. Stops on the first 'ready', or after MaxAttempts rounds with 'failed'.
Sleeps IntervalSeconds between rounds, never after the last one.

t/4513 incident (run 40358394585) revised the contract: this loop does NOT catch an exception
from Probe. A genuine defect (e.g. a command that doesn't resolve, CommandNotFoundException)
propagates out on the FIRST attempt rather than being retried 13 times as "not ready" -- the
caller's own try/catch, one level up, is what distinguishes a gate defect from a real not-ready
mount. Only a probe that itself returns $false for a transient condition (timeout, connection
refused, HTTP error -- all caught internally by the probe's own HTTP layer) is a retryable round.
#>
function Wait-MountReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $Probe,
        [ValidateRange(1, 20)][int] $MaxAttempts = 3,
        [ValidateRange(0, 60)][int] $IntervalSeconds = 5
    )
    $attempt = 0
    $verdict = $null
    do {
        $attempt++
        $succeeded = [bool](& $Probe)
        $verdict = Get-MountReadinessVerdict -ProbeSucceeded $succeeded -Attempt $attempt -MaxAttempts $MaxAttempts
        Write-Host "mount-readiness round ${attempt}/${MaxAttempts}: succeeded=$succeeded verdict=$($verdict.Verdict)"
        if ($verdict.Verdict -ne 'retry') { break }
        Start-Sleep -Seconds $IntervalSeconds
    } while ($attempt -lt $MaxAttempts)

    [pscustomobject]@{
        Verdict  = $verdict.Verdict
        Attempts = $attempt
    }
}
