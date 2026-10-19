<#
.SYNOPSIS
Pure predicate for t/4285's continuous-deploy advisory check: given the current state, decide
whether an auto-deploy of `main` would run (and why), or be skipped (and why). No I/O.
#>
function Get-AutoDeployAdvisoryVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$HeadSha,
        [Parameter(Mandatory)][string]$LastDeployedSha,
        # Array of @{ Context = <string>; Conclusion = <string> } for every entry in
        # required-contexts.json, evaluated against $HeadSha. 'posts: app-aggregate' contexts
        # (e.g. CodeQL) are passed the same way — the caller resolves how to read them.
        [Parameter(Mandatory)][array]$RequiredContextResults,
        [Parameter(Mandatory)][bool]$HoldActive,
        # Paths changed between $LastDeployedSha and $HeadSha (git diff --name-only).
        [Parameter(Mandatory)][string[]]$ChangedPaths,
        # r1Paths + r1Globs from tier-paths.json, already expanded to literal/glob strings.
        [Parameter(Mandatory)][string[]]$InfraPaths,
        [datetime]$LastAutoDeployAt,
        [int]$MinIntervalMinutes = 120,
        [Parameter(Mandatory)][datetime]$Now
    )

    if ($HeadSha -eq $LastDeployedSha) {
        return [PSCustomObject]@{
            Verdict        = 'Skip'
            SkipReason     = 'no-new-commits'
            Detail         = "HEAD ($HeadSha) is already the deployed SHA"
            HeadSha        = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($HoldActive) {
        return [PSCustomObject]@{
            Verdict        = 'Skip'
            SkipReason     = 'hold'
            Detail         = 'Deploy-hold switch is active'
            HeadSha        = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    $redContexts = @($RequiredContextResults | Where-Object { $_.Conclusion -ne 'success' })
    if (@($redContexts).Count -gt 0) {
        $names = ($redContexts | ForEach-Object { "$($_.Context)=$($_.Conclusion)" }) -join ', '
        return [PSCustomObject]@{
            Verdict        = 'Skip'
            SkipReason     = 'red-required-context'
            Detail         = "Not all required contexts are success: $names"
            HeadSha        = $HeadSha
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
            Verdict        = 'Skip'
            SkipReason     = 'infra-change'
            Detail         = "Diff touches infra path(s): $($touchedInfra -join ', ')"
            HeadSha        = $HeadSha
            LastDeployedSha = $LastDeployedSha
        }
    }

    if ($LastAutoDeployAt) {
        $elapsedMinutes = ($Now - $LastAutoDeployAt).TotalMinutes
        if ($elapsedMinutes -lt $MinIntervalMinutes) {
            $remaining = [math]::Ceiling($MinIntervalMinutes - $elapsedMinutes)
            return [PSCustomObject]@{
                Verdict        = 'Skip'
                SkipReason     = 'rate-cap'
                Detail         = "Last auto-deploy was $([math]::Round($elapsedMinutes, 1)) min ago; $remaining min left of the $MinIntervalMinutes-min floor"
                HeadSha        = $HeadSha
                LastDeployedSha = $LastDeployedSha
            }
        }
    }

    return [PSCustomObject]@{
        Verdict        = 'WouldDeploy'
        SkipReason     = $null
        Detail         = "All conditions met: new commits, no hold, all required contexts green, no infra diff, rate cap clear"
        HeadSha        = $HeadSha
        LastDeployedSha = $LastDeployedSha
    }
}
