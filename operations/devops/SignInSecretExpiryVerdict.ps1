# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# t/4294: proactive expiry warning for the Microsoft (Entra/AAD) sign-in client secret, so a
# rotation happens BEFORE users hit AADSTS7000222 ("the provided client secret keys are
# expired"). Pure predicate (this file) + thin impure shim (Test-SignInSecretExpiry.ps1), the
# same split as Get-KnownGoodLivenessVerdict.ps1 / ScheduledWorkflowLivenessVerdict.ps1.
#
# Three verdicts, never two (t/4496 GATE-UNREADABLE convention): a credential list the check
# could not read is UNREADABLE with a reason, NEVER clean. "Couldn't look" and "looked, fine"
# must not render the same.

function Get-SignInSecretExpiryVerdict {
    <#
    .SYNOPSIS
        Pure. Judges whether any sign-in client-secret credential expires within WarnDays.
    .DESCRIPTION
        No network, no filesystem, no clock: the caller passes the credential list (the
        `az ad app credential list` shape, reduced to displayName + endDateTime -- never a
        secret value or hint) and the current instant.

        Only credentials whose displayName matches -DisplayNamePattern (default `easyauth-*`,
        the name Rotate-SignInSecret.ps1 gives every credential it creates) are judged. Other
        credentials on the app registration are not the sign-in secret, and are reported as
        ignored.

        Verdicts:
          UNREADABLE  -ReadError is set, the list is $null, no credential matches the pattern
                      (the check can't tell which credential is the sign-in secret), or a
                      matching credential's endDateTime doesn't parse.
          WARN        at least one matching credential expires within WarnDays, or has
                      already expired. An expired leftover from a finished rotation also
                      warns: deleting it is the action that clears the alert.
          CLEAN       every matching credential expires more than WarnDays from Now.
    .PARAMETER Credentials
        Objects with displayName and endDateTime properties. $null means "not read".
    .PARAMETER ReadError
        Why the list could not be read (e.g. the az stderr). Any non-empty value forces
        UNREADABLE, whatever -Credentials holds.
    .PARAMETER Now
        The current instant. DateTimeOffset, so a non-UTC machine can't skew the comparison.
    .PARAMETER WarnDays
        How many days ahead to warn. Default 30 (t/4294).
    .PARAMETER DisplayNamePattern
        -like pattern for the credentials that are the sign-in secret. Default 'easyauth-*'.
    .OUTPUTS
        PSCustomObject: Status (WARN|CLEAN|UNREADABLE), Reason, Message, WarnDays,
        Expiring (displayName, endDateTime, daysLeft), Checked (same shape, all judged
        credentials), IgnoredCount.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'Credentials',
        Justification = 'Credential METADATA only (displayName, endDateTime); never a secret value.')]
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$Credentials,

        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$ReadError,

        [Parameter(Mandatory)]
        [datetimeoffset]$Now,

        [Parameter()]
        [ValidateRange(1, 365)]
        [int]$WarnDays = 30,

        [Parameter()]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayNamePattern = 'easyauth-*'
    )

    Set-StrictMode -Version Latest

    function Format-ExpiryVerdict {
        param(
            [string]$Status,
            [string]$Reason,
            [string]$Message = "UNREADABLE: $Reason. This is NOT a clean result.",
            [object[]]$Expiring = @(),
            [object[]]$Checked = @(),
            [int]$Ignored = 0
        )
        [PSCustomObject]@{
            Status       = $Status
            Reason       = $Reason
            Message      = $Message
            WarnDays     = $WarnDays
            Expiring     = @($Expiring)
            Checked      = @($Checked)
            IgnoredCount = $Ignored
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ReadError)) {
        return Format-ExpiryVerdict -Status 'UNREADABLE' -Reason $ReadError.Trim() -Message "UNREADABLE: could not read the sign-in app credential list ($($ReadError.Trim())). This is NOT a clean result."
    }
    if ($null -eq $Credentials) {
        return Format-ExpiryVerdict -Status 'UNREADABLE' -Reason 'the sign-in app credential list was not read (null)'
    }

    $all = @($Credentials | Where-Object { $null -ne $_ })
    $matching = @($all | Where-Object {
            $_.PSObject.Properties['displayName'] -and $_.displayName -like $DisplayNamePattern
        })
    $ignored = @($all).Count - @($matching).Count

    if (@($matching).Count -eq 0) {
        $reason = "no credential named '$DisplayNamePattern' on the app registration ($(@($all).Count) other credential(s)), so the sign-in secret can't be identified"
        return Format-ExpiryVerdict -Status 'UNREADABLE' -Reason $reason -Ignored $ignored
    }

    $checked = [System.Collections.Generic.List[object]]::new()
    foreach ($cred in $matching) {
        $rawEnd = if ($cred.PSObject.Properties['endDateTime']) { $cred.endDateTime } else { $null }
        $end = [datetimeoffset]::MinValue
        $parsed = $false
        if ($rawEnd -is [datetimeoffset]) { $end = $rawEnd; $parsed = $true }
        elseif ($rawEnd -is [datetime]) { $end = [datetimeoffset]$rawEnd; $parsed = $true }
        elseif ($rawEnd -is [string] -and $rawEnd) {
            $parsed = [datetimeoffset]::TryParse($rawEnd, [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$end)
        }
        if (-not $parsed) {
            $reason = "credential '$($cred.displayName)' has an unparseable endDateTime '$rawEnd'"
            return Format-ExpiryVerdict -Status 'UNREADABLE' -Reason $reason -Checked @($checked) -Ignored $ignored
        }
        $checked.Add([PSCustomObject]@{
                displayName = [string]$cred.displayName
                endDateTime = $end.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                daysLeft    = [int][math]::Floor(($end - $Now).TotalDays)
            })
    }

    $expiring = @($checked | Where-Object { $_.daysLeft -le $WarnDays } | Sort-Object daysLeft)
    if (@($expiring).Count -gt 0) {
        $parts = @($expiring | ForEach-Object {
                if ($_.daysLeft -lt 0) { "$($_.displayName) EXPIRED $(-$_.daysLeft) day(s) ago ($($_.endDateTime))" }
                else { "$($_.displayName) expires in $($_.daysLeft) day(s) ($($_.endDateTime))" }
            })
        $reason = $parts -join '; '
        return Format-ExpiryVerdict -Status 'WARN' -Reason $reason -Message "WARN: sign-in client secret expiring within $WarnDays days: $reason" -Expiring $expiring -Checked @($checked) -Ignored $ignored
    }

    $soonest = @($checked | Sort-Object daysLeft)[0]
    $reason = "soonest is $($soonest.displayName), $($soonest.daysLeft) day(s) left ($($soonest.endDateTime))"
    return Format-ExpiryVerdict -Status 'CLEAN' -Reason $reason -Message "CLEAN: no sign-in client secret expires within $WarnDays days; $reason" -Checked @($checked) -Ignored $ignored
}
