<#
.SYNOPSIS
Pure predicate for t/4285's continuous-deploy advisory check: given the current state, decide
whether an auto-deploy of `main` would run (and why), or be skipped (and why). No I/O.

.NOTES
"Green" (TL ruling, p/331#2106, after p/331#2104's finding) is `ci-gate` SUCCESS, plus CodeQL
SUCCESS *if present* — CodeQL is push-path-filtered (`**.ts`/`.tsx`/`.js`/`.jsx`) so it's
legitimately absent on e.g. a Bicep-only commit; absent is fine, but present-and-failed or
present-and-pending blocks. `joint-gv-guard` and `consult-hold-guard` are intentionally NOT
re-checked here: they only trigger on `pull_request` events and structurally never run again on
a push-triggered main SHA (confirmed empirically on 3 real main commits, p/331#2104) — they
already gated the originating PR before merge. That's why every commit in range must instead
come from a merged PR (below): a commit with no PR association skipped those gates entirely.
#>
function Get-AutoDeployAdvisoryVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$HeadSha,
        [Parameter(Mandatory)][string]$LastDeployedSha,
        [Parameter(Mandatory)][string]$CiGateConclusion,
        # $null/empty means CodeQL did not run on this SHA (path-filtered) — treated as fine.
        [string]$CodeQlConclusion,
        [Parameter(Mandatory)][bool]$HoldActive,
        # Commits strictly between $LastDeployedSha and $HeadSha that have no associated merged
        # PR (TL ruling, p/331#2106) — e.g. a commit pushed directly to main. Empty = all clear.
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$CommitsWithoutMergedPR,
        # Paths changed between $LastDeployedSha and $HeadSha (git diff --name-only).
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ChangedPaths,
        # r1Paths + r1Globs from tier-paths.json, already expanded to literal/glob strings.
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$InfraPaths,
        [datetime]$LastAutoDeployAt,
        [int]$MinIntervalMinutes = 120,
        [Parameter(Mandatory)][datetime]$Now
    )

    if ($HeadSha -eq $LastDeployedSha) {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'no-new-commits'
            Detail          = "HEAD ($HeadSha) is already the deployed SHA"
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($HoldActive) {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'hold'
            Detail          = 'Deploy-hold switch is active'
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if (@($CommitsWithoutMergedPR).Count -gt 0) {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'no-pr-association'
            Detail          = "Commit(s) with no associated merged PR (never ran joint-gv-guard/consult-hold-guard): $($CommitsWithoutMergedPR -join ', ')"
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($CiGateConclusion -ne 'success') {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'red-required-context'
            Detail          = "ci-gate is not success: $CiGateConclusion"
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($CodeQlConclusion -and $CodeQlConclusion -ne 'success') {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'red-required-context'
            Detail          = "CodeQL ran on this SHA and is not success: $CodeQlConclusion"
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    $touchedInfra = @()
    foreach ($changed in $ChangedPaths) {
        foreach ($infra in $InfraPaths) {
            # Literal path match, or a simple trailing-wildcard glob (e.g. 'Move-PiCredential*.ps1').
            $isMatch = if ($infra -match '\*') { $changed -like $infra } else { $changed -eq $infra }
            if ($isMatch) { $touchedInfra += $changed; break }
        }
    }
    if (@($touchedInfra).Count -gt 0) {
        return [PSCustomObject]@{
            Verdict         = 'Skip'
            SkipReason      = 'infra-change'
            Detail          = "Diff touches infra path(s): $($touchedInfra -join ', ')"
            HeadSha         = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($LastAutoDeployAt) {
        $elapsedMinutes = ($Now - $LastAutoDeployAt).TotalMinutes
        if ($elapsedMinutes -lt $MinIntervalMinutes) {
            $remaining = [math]::Ceiling($MinIntervalMinutes - $elapsedMinutes)
            return [PSCustomObject]@{
                Verdict         = 'Skip'
                SkipReason      = 'rate-cap'
                Detail          = "Last auto-deploy was $([math]::Round($elapsedMinutes, 1)) min ago; $remaining min left of the $MinIntervalMinutes-min floor"
                HeadSha         = $HeadSha
                LastDeployedSha = $LastDeployedSha
            }
        }
    }

    return [PSCustomObject]@{
        Verdict         = 'WouldDeploy'
        SkipReason      = $null
        Detail          = "All conditions met: new commits all from merged PRs, no hold, ci-gate green (CodeQL green or absent), no infra diff, rate cap clear"
        HeadSha         = $HeadSha
        LastDeployedSha = $LastDeployedSha
    }
}

<#
.SYNOPSIS
Pure parser: given a `gh api .../commits/{sha}/check-runs` response (already ConvertFrom-Json'd),
return a hashtable of check-run name -> conclusion (or status if still running), keeping only the
most-recently-started run per name. No I/O — takes the parsed object, never calls gh itself.
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
