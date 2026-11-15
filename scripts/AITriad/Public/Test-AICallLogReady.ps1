# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-AICallLogReady {
    <#
    .SYNOPSIS
        Preflight for a spend guard: will Invoke-AIApi calls from here be written to the AI call log?
    .DESCRIPTION
        t/150. True only when ALL hold:
          - AI_CALL_LOG_ENABLED is truthy (the log is default-off);
          - the Invoke-AIApi the CALLER resolves exists; and
          - that Invoke-AIApi's module instance has its default call logger registered.
        A guard that prices spend from the log (t/106) should refuse to start a paid run when this is
        $false, because unlogged calls would read as zero spend. -Detailed returns the reasons.
    .PARAMETER Detailed
        Return a [pscustomobject] { Ready; Enabled; InvokeAIApiResolved; DefaultLoggerRegistered; Reason }
        instead of a bool.
    .EXAMPLE
        if (-not (Test-AICallLogReady)) { throw 'AI call log not ready; refusing the paid run.' }
    #>
    [CmdletBinding()]
    param([switch]$Detailed)

    $enabled = Test-AICallLogEnabled
    # Resolve the command the way the caller will: the global/script-visible Invoke-AIApi.
    $cmd = Get-Command Invoke-AIApi -CommandType Function -ErrorAction SilentlyContinue | Select-Object -First 1
    $registered = $false
    if ($cmd -and $cmd.Module) {
        $registered = [bool](& $cmd.Module { Test-AIDefaultCallLoggerRegistered })
    }

    $reason = if (-not $enabled) { 'AI_CALL_LOG_ENABLED is not set to a truthy value (1|true|yes|on).' }
              elseif (-not $cmd) { 'Invoke-AIApi is not resolvable; import AITriad (it exports Invoke-AIApi).' }
              elseif (-not $registered) { "The Invoke-AIApi in module '$($cmd.Module.Name)' has no default call logger (writer not found next to AIEnrich.psm1)." }
              else { 'Ready.' }
    $ready = $enabled -and [bool]$cmd -and $registered

    if ($Detailed) {
        return [pscustomobject]@{
            Ready = $ready; Enabled = $enabled; InvokeAIApiResolved = [bool]$cmd
            DefaultLoggerRegistered = $registered; Reason = $reason
        }
    }
    return $ready
}
