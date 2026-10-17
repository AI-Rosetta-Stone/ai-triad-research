# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Connect-CdpSession {
    [CmdletBinding()]
    param(
        [Parameter()][int]$Port = 9222,
        [Parameter()][string]$HostName = 'localhost',
        [Parameter()][int]$TimeoutSec = 10
    )

    Set-StrictMode -Version Latest

    $targets = Invoke-RestMethod -Uri "http://${HostName}:${Port}/json/list" -TimeoutSec $TimeoutSec
    $target = @($targets | Where-Object { $_.type -eq 'page' }) | Select-Object -First 1
    if (-not $target) {
        throw (New-ActionableError -Goal 'Connect to Electron app via CDP' `
            -Problem "No page target found on port $Port" `
            -Location 'Connect-CdpSession' `
            -NextSteps @("Ensure the Electron app is running with --remote-debugging-port=$Port",
                         'Run: npx electron . --remote-debugging-port=9222') `
            -AsErrorRecord)
    }

    $wsUrl = $target.webSocketDebuggerUrl
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSec))
    try {
        $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).GetAwaiter().GetResult()
    } catch {
        throw (New-ActionableError -Goal 'Connect CDP WebSocket' `
            -Problem "WebSocket connect failed: $($_.Exception.Message)" `
            -Location 'Connect-CdpSession' `
            -NextSteps @("Verify the app is still running on port $Port",
                         "Check that $wsUrl is accessible") `
            -AsErrorRecord)
    }

    [PSCustomObject]@{
        PSTypeName = 'CdpSession'
        WebSocket  = $ws
        NextId     = 1
        Buffer     = [byte[]]::new(4194304)
        Port       = $Port
    }
}

function Invoke-CdpCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSCustomObject]$Session,
        [Parameter(Mandatory)][string]$Method,
        [Parameter()][hashtable]$Params = @{},
        [Parameter()][int]$TimeoutSec = 10
    )

    Set-StrictMode -Version Latest

    $id = $Session.NextId
    $Session.NextId = $Session.NextId + 1

    $msg = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $segment = [System.ArraySegment[byte]]::new($bytes)
    $cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSec))

    $Session.WebSocket.SendAsync(
        $segment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        $cts.Token
    ).GetAwaiter().GetResult() | Out-Null

    while ($true) {
        $response = Read-CdpMessage -Session $Session -TimeoutSec $TimeoutSec
        if ($response.PSObject.Properties['id'] -and $response.id -eq $id) {
            if ($response.PSObject.Properties['error']) {
                throw "CDP error ($Method): $($response.error.message)"
            }
            return $response.result
        }
    }
}

function Read-CdpMessage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSCustomObject]$Session,
        [Parameter()][int]$TimeoutSec = 10
    )

    $cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSec))
    $sb = [System.Text.StringBuilder]::new()

    do {
        $segment = [System.ArraySegment[byte]]::new($Session.Buffer)
        $result = $Session.WebSocket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
        $sb.Append([System.Text.Encoding]::UTF8.GetString($Session.Buffer, 0, $result.Count)) | Out-Null
    } while (-not $result.EndOfMessage)

    $sb.ToString() | ConvertFrom-Json
}

function Disconnect-CdpSession {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSCustomObject]$Session
    )

    if ($Session.WebSocket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(5))
        try {
            $Session.WebSocket.CloseAsync(
                [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
                '',
                $cts.Token
            ).GetAwaiter().GetResult() | Out-Null
        } catch {
            Write-Verbose "CDP close warning: $($_.Exception.Message)"
        }
    }
    $Session.WebSocket.Dispose()
}
