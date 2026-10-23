<#
.SYNOPSIS
    Pure parser: given a `gh api .../commits/{sha}/check-runs` response (already ConvertFrom-Json'd),
    return a hashtable of check-run name -> conclusion (or status if still running), keeping only the
    most-recently-started run per name. No I/O -- takes the parsed object, never calls gh itself.

.DESCRIPTION
    Extracted from t/4285's Get-AutoDeployAdvisoryVerdict.ps1 (t/4414 consolidation, e/358#2,
    p/344#374) when that workflow was retired -- this parser has no advisory-specific logic and
    is also used by continuous-deploy.yml (t/4414) to read ci-gate/CodeQL conclusions.
#>
function ConvertFrom-CheckRunsResponse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$CheckRunsResponse
    )
    $byName = @{}
    foreach ($r in @($CheckRunsResponse.check_runs)) {
        $startedAt = [datetime]$r.started_at
        if (-not $byName.ContainsKey($r.name) -or $startedAt -gt $byName[$r.name].StartedAt) {
            $byName[$r.name] = [PSCustomObject]@{
                Conclusion = if ($r.conclusion) { $r.conclusion } else { $r.status }
                StartedAt  = $startedAt
            }
        }
    }
    return $byName
}
