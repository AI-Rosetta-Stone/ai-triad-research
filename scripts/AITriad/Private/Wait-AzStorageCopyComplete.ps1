# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Wait-AzStorageCopyComplete {
    <#
    .SYNOPSIS
        Polls an async `az storage blob copy start` / `az storage file copy start` until it
        settles, instead of treating "copy started" as "copy done" (Quality, t/4440#2 item 1).
    .DESCRIPTION
        Both blob and file copies are asynchronous: the `start` command returns immediately
        with status 'pending', and the copy completes server-side afterward. A caller that
        verifies right after `start` is checking a copy that may not have finished yet.
        -GetStatus is a scriptblock the caller supplies (e.g. `az storage blob show ... --query
        properties.copy.status` for blobs, `az storage file show ... --query copy.status` for
        files) so this helper stays agnostic to which store it's polling.
    .PARAMETER GetStatus
        Scriptblock returning the current copy status string ('pending', 'success', 'failed',
        'aborted'), or $null/empty if the destination can't be queried yet.
    .PARAMETER TimeoutSeconds
        Give up and return 'timeout' after this long. Default 300.
    .PARAMETER PollIntervalSeconds
        Delay between polls. Default 2.
    .OUTPUTS
        [string] the final status: 'success', 'failed', 'aborted', or 'timeout'.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][scriptblock]$GetStatus,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 300,
        [ValidateRange(1, 60)][int]$PollIntervalSeconds = 2
    )
    Set-StrictMode -Version Latest

    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $Status = & $GetStatus
        if ($Status -in @('success', 'failed', 'aborted')) { return $Status }
        Start-Sleep -Seconds $PollIntervalSeconds
    } while ((Get-Date) -lt $Deadline)
    return 'timeout'
}
