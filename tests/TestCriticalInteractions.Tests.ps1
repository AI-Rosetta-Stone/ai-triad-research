# Tag: health (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-CriticalInteractions' -Tag 'health' {

    BeforeAll {
        Mock Invoke-RemoteCheck -ModuleName AITriad -MockWith {
            [PSCustomObject]@{
                Success = $true; StatusCode = 200; ResponseMs = 10; Error = $null
                Body = [PSCustomObject]@{
                    available = $true; status = 'ok'; version = '1.0'; anonymous = $true; tier = 'free'
                    nodes = @([PSCustomObject]@{ id = 'acc-B-001'; label = 'Test'; category = 'Beliefs'; description = 'desc'
                        graph_attributes = [PSCustomObject]@{ epistemic_type = 'empirical' } })
                    branch = 'main'; files = @(); actions = @()
                    requests = 0; tokensToday = 0
                    errorCount = 0; feedbackCount = 0
                    totalEvents = 0; uniqueUsers = 0
                    uptime = 3600
                    github = [PSCustomObject]@{ rateLimit = [PSCustomObject]@{ remaining = 100 } }
                }
            }
        }
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            $ex = [System.Net.Http.HttpRequestException]::new('Forbidden')
            $resp = [PSCustomObject]@{ StatusCode = [System.Net.HttpStatusCode]::Forbidden }
            $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp
            throw $ex
        }
    }

    It 'Is exported and discoverable' {
        Get-Command Test-CriticalInteractions -Module AITriad | Should -Not -BeNullOrEmpty
    }

    It 'Runs all P0 API tests and returns results' {
        $results = Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -Level API -Priority P0 -Detailed 6>$null
        @($results).Count | Should -BeGreaterThan 0
        foreach ($r in $results) {
            $r.Priority | Should -Be 'P0'
            $r.PSObject.TypeNames | Should -Contain 'CuiTestResult'
        }
    }

    It 'Filters by domain' {
        $results = Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -Level API -Domain Taxonomy -Detailed 6>$null
        @($results).Count | Should -BeGreaterThan 0
        foreach ($r in $results) {
            $r.Domain | Should -Be 'Taxonomy'
        }
    }

    It 'Filters by single CuiId' {
        $results = Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -Level API -CuiId 'CUI-TAX-001' -Detailed 6>$null
        @($results).Count | Should -Be 1
        $results[0].CuiId | Should -Be 'CUI-TAX-001'
    }

    It 'Throws ActionableError for invalid CuiId' {
        # t/4155: assert the rendered labels, not just "something threw". Before the fix the
        # error object was never returned, so this threw a bare ScriptHalted with no message.
        $Thrown = $null
        try { Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -CuiId 'CUI-FAKE-999' -Detailed 6>$null 2>$null }
        catch { $Thrown = $_ }
        $Thrown | Should -Not -BeNullOrEmpty -Because 'Invalid CUI ID should throw'
        $Message = $Thrown.Exception.Message
        $Message | Should -Match 'Goal:'
        $Message | Should -Match "CUI ID 'CUI-FAKE-999' not found"
        $Message | Should -Match 'Location:'
        $Message | Should -Match 'Resolve:'
    }

    It 'Returns results for all priorities when no filter' {
        $results = Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -Level API -Detailed 6>$null
        $priorities = @($results | ForEach-Object { $_.Priority } | Sort-Object -Unique)
        $priorities | Should -Contain 'P0'
        $priorities | Should -Contain 'P1'
    }

    It 'Produces summary output in non-Detailed mode' {
        $output = Test-CriticalInteractions -BaseUrl 'http://localhost:3000' -Level API -Priority P0 6>$null
        @($output).Count | Should -BeGreaterThan 0
    }
}

Describe 'Convert-CuiIdToFunctionName' -Tag 'health' {

    It 'Converts standard CUI IDs to function names' {
        InModuleScope AITriad {
            Convert-CuiIdToFunctionName -CuiId 'CUI-TAX-001' | Should -Be 'Test-CuiTax001'
            Convert-CuiIdToFunctionName -CuiId 'CUI-DEB-005' | Should -Be 'Test-CuiDeb005'
            Convert-CuiIdToFunctionName -CuiId 'CUI-AUTH-003' | Should -Be 'Test-CuiAuth003'
            Convert-CuiIdToFunctionName -CuiId 'CUI-ADM-001' | Should -Be 'Test-CuiAdm001'
            Convert-CuiIdToFunctionName -CuiId 'CUI-COM-002' | Should -Be 'Test-CuiCom002'
            Convert-CuiIdToFunctionName -CuiId 'CUI-DATA-003' | Should -Be 'Test-CuiData003'
            Convert-CuiIdToFunctionName -CuiId 'CUI-CAL-001' | Should -Be 'Test-CuiCal001'
            Convert-CuiIdToFunctionName -CuiId 'CUI-AI-002' | Should -Be 'Test-CuiAi002'
        }
    }

    It 'Returns null for invalid CUI IDs' {
        InModuleScope AITriad {
            Convert-CuiIdToFunctionName -CuiId 'INVALID' | Should -BeNullOrEmpty
            Convert-CuiIdToFunctionName -CuiId 'CUI-X' | Should -BeNullOrEmpty
        }
    }
}
