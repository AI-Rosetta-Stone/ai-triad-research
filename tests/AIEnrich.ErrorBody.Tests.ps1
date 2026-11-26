# Tag: enrichment (t/3196)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/3196: Invoke-AIApi's all-retries-exhausted error path must log the HTTP response BODY.
    Invoke-RestMethod (HttpClient) surfaces the body on $_.ErrorDetails.Message — the previous
    read only looked at Exception.Response.GetResponseStream() (WebRequest shape) and silently
    caught nothing, so a 4xx's real reason was invisible (this masked the t/3123 400). The body
    must be logged AND scrubbed via Protect-SensitiveText.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-AIApi error-body capture (t/3196)' -Tag 'enrichment' {

    It 'logs the HttpClient ErrorDetails.Message body (redacted) on a failed call' {
        Mock Start-Sleep { } -ModuleName AIEnrich   # no retry backoff delay
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $ex = [System.Exception]::new('Response status code does not indicate success: 400 (Bad Request).')
            $er = [System.Management.Automation.ErrorRecord]::new(
                $ex, 'HttpError400', [System.Management.Automation.ErrorCategory]::InvalidResult, $null)
            # Invoke-RestMethod puts the response body here for HttpClient errors. Includes a
            # synthetic leaked key to prove redaction. Split so the source literal can't trip
            # secret scanning.
            $er.ErrorDetails = [System.Management.Automation.ErrorDetails]::new(
                '{"error":{"message":"model not found or not supported","status":"INVALID_ARGUMENT"},"leaked":"' + ('AIza' + 'SyLEAKEDkeyNOTREAL0123456789abcd') + '"}')
            throw $er
        }

        $warn = @()
        Invoke-AIApi -Prompt 'test' -Model 'claude-sonnet-4-6' -ApiKey 'sk-secret-explicit-key-xyz' `
            -WarningVariable warn -WarningAction SilentlyContinue 3>$null 2>$null | Out-Null

        $msg = ($warn | ForEach-Object { $_.ToString() }) -join ' '
        # The body reached a log line...
        $msg | Should -Match 'Response body'
        # ...carrying the real reason...
        $msg | Should -Match 'model not found'
        # ...with the embedded key redacted...
        $msg | Should -Not -Match 'AIzaSyLEAKED'
        # ...and the explicit -ApiKey redacted too.
        $msg | Should -Not -Match 'sk-secret-explicit-key-xyz'
    }
}
