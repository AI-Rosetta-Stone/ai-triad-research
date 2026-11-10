# Tag: health (t/4934)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Get-JsonField / Test-JsonField (t/4934, t/103) and the smoke-phase
    readers routed through them.
.DESCRIPTION
    Smoke bodies are PSCustomObjects (ConvertFrom-Json) or Hashtables (-AsHashtable).
    $x.PSObject.Properties['k'] is blind to Hashtable keys, so the old reads silently
    missed. Both shapes x present/missing, plus the non-container inputs, and the
    "Hashtable body" regressions that fail on main for each routed reader.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-JsonField / Test-JsonField (t/4934)' -Tag 'health' {

    Context 'both body shapes, present and missing' {
        It '<Shape>: present field is found and read' -TestCases @(
            @{ Shape = 'PSCustomObject'; Make = { [PSCustomObject]@{ ok = $true; n = 3 } } }
            @{ Shape = 'Hashtable';      Make = { @{ ok = $true; n = 3 } } }
            @{ Shape = 'ordered';        Make = { [ordered]@{ ok = $true; n = 3 } } }
        ) {
            param($Shape, $Make)
            InModuleScope AITriad -Parameters @{ Make = $Make } {
                param($Make)
                $b = & $Make
                Test-JsonField $b 'n' | Should -BeTrue
                Get-JsonField  $b 'n' | Should -Be 3
            }
        }

        It '<Shape>: missing field is absent and reads as -Default' -TestCases @(
            @{ Shape = 'PSCustomObject'; Make = { [PSCustomObject]@{ ok = $true } } }
            @{ Shape = 'Hashtable';      Make = { @{ ok = $true } } }
        ) {
            param($Shape, $Make)
            InModuleScope AITriad -Parameters @{ Make = $Make } {
                param($Make)
                $b = & $Make
                Test-JsonField $b 'missing' | Should -BeFalse
                Get-JsonField  $b 'missing' | Should -BeNullOrEmpty
                Get-JsonField  $b 'missing' -Default 7 | Should -Be 7
            }
        }

        It 'Hashtable .NET members (Count, Keys) are NOT fields — the old PSObject.Properties trap' {
            InModuleScope AITriad {
                $b = @{ a = 1 }
                Test-JsonField $b 'Count' | Should -BeFalse
                Test-JsonField $b 'Keys'  | Should -BeFalse
            }
        }

        It 'a present field holding null is present, and reads as null (not -Default)' {
            InModuleScope AITriad {
                foreach ($b in @([PSCustomObject]@{ x = $null }, @{ x = $null })) {
                    Test-JsonField $b 'x' | Should -BeTrue
                    Get-JsonField $b 'x' -Default 'd' | Should -BeNullOrEmpty
                }
            }
        }
    }

    Context 'non-container inputs have no fields' {
        It '<Label> → absent, never throws' -TestCases @(
            @{ Label = '$null';  Value = $null }
            @{ Label = 'string'; Value = 'abc' }
            @{ Label = 'int';    Value = 5 }
        ) {
            param($Label, $Value)
            InModuleScope AITriad -Parameters @{ Value = $Value } {
                param($Value)
                Test-JsonField $Value 'Length' | Should -BeFalse
                Get-JsonField  $Value 'Length' -Default 'd' | Should -Be 'd'
            }
        }
    }

    Context 'array values' {
        It '<N>-item array: @(Get-JsonField).Count is right; -NoEnumerate keeps the array' -TestCases @(
            @{ N = 0 }, @{ N = 1 }, @{ N = 3 }
        ) {
            param($N)
            InModuleScope AITriad -Parameters @{ N = $N } {
                param($N)
                $Arr = [object[]]@(1..3 | Select-Object -First $N)
                foreach ($b in @([PSCustomObject]@{ a = $Arr }, @{ a = $Arr })) {
                    @(Get-JsonField $b 'a').Count | Should -Be $N
                    $v = Get-JsonField $b 'a' -NoEnumerate
                    $null -eq $v | Should -BeFalse -Because '[] must not collapse to null with -NoEnumerate'
                    $v.GetType().IsArray | Should -BeTrue -Because '[x] must not collapse to x with -NoEnumerate'
                    $v.Count | Should -Be $N
                }
            }
        }
    }

    Context 'Get-SummaryProp delegates (no near-duplicate)' {
        It 'reads both shapes the same as Get-JsonField' {
            InModuleScope AITriad {
                Get-SummaryProp ([ordered]@{ camp = 'safetyist' }) 'camp' | Should -Be 'safetyist'
                Get-SummaryProp ([PSCustomObject]@{ camp = 'skeptic' }) 'camp' | Should -Be 'skeptic'
                Get-SummaryProp @{ a = 1 } 'missing' | Should -BeNullOrEmpty
                Get-SummaryProp $null 'x' | Should -BeNullOrEmpty
            }
        }
    }
}

Describe 'Smoke readers on Hashtable bodies (t/4934 regressions — each fails on main)' -Tag 'health' {

    It 'Get-SmokeTotalEventCount reads summary.totalEvents from a Hashtable body' {
        InModuleScope AITriad {
            $check = [PSCustomObject]@{ Success = $true; Body = @{ summary = @{ totalEvents = 42 } } }
            Get-SmokeTotalEventCount $check | Should -Be 42
        }
    }

    It 'Get-SmokeTotalEventCount: absent field / failed read stay $null' {
        InModuleScope AITriad {
            Get-SmokeTotalEventCount ([PSCustomObject]@{ Success = $true;  Body = @{ summary = @{} } }) | Should -BeNullOrEmpty
            Get-SmokeTotalEventCount ([PSCustomObject]@{ Success = $false; Body = @{ summary = @{ totalEvents = 1 } } }) | Should -BeNullOrEmpty
        }
    }

    It 'Get-SmokeAnalyticsWriteResult passes on a Hashtable {ok:true}, fails on {ok:false}' {
        InModuleScope AITriad {
            $mk = { param($ok) [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 1; Error = $null; Body = @{ ok = $ok } } }
            (Get-SmokeAnalyticsWriteResult (& $mk $true)).Pass  | Should -BeTrue
            (Get-SmokeAnalyticsWriteResult (& $mk $false)).Pass | Should -BeFalse
        }
    }

    It 'Get-SmokeAnalyticsDwellResult counts view.dwell in a Hashtable eventTypes; absent → fail' {
        InModuleScope AITriad {
            $mk = { param($types) [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 1; Body = @{ eventTypes = $types } } }
            (Get-SmokeAnalyticsDwellResult (& $mk @{ 'view.dwell' = 2 })).Pass | Should -BeTrue
            (Get-SmokeAnalyticsDwellResult (& $mk @{ 'other' = 2 })).Pass      | Should -BeFalse
        }
    }

    It 'Get-SmokeOpedFilesDetail reads assets / missing from a Hashtable body' {
        InModuleScope AITriad {
            $check = [PSCustomObject]@{ ContentType = 'application/json'; StatusCode = 200 }
            Get-SmokeOpedFilesDetail -Pass $true -JsonOk $true -BodyOk $true -Check $check -Json @{ assets = @('a', 'b') } |
                Should -Be 'all assets present (2 files)'
            Get-SmokeOpedFilesDetail -Pass $false -JsonOk $true -BodyOk $false -Check $check -Json @{ missing = @('x', 'y') } |
                Should -Be 'MISSING: x, y (status=200)'
        }
    }

    It 'Test-DataPresenceAssertion finds CountField in a Hashtable body; absent → fail' {
        InModuleScope AITriad {
            (Test-DataPresenceAssertion -Body @{ nodes = @(1, 2) } -CountField 'nodes').Count | Should -Be 2
            $r = Test-DataPresenceAssertion -Body @{ other = @(1) } -CountField 'nodes'
            $r.Pass   | Should -BeFalse
            $r.Reason | Should -BeExactly "Field 'nodes' absent from response body"
        }
    }

    It 'Test-DataPresenceAssertion: an empty Hashtable object is 0 rows, a populated one is 1' {
        InModuleScope AITriad {
            (Test-DataPresenceAssertion -Body @{} -CountField '').Pass        | Should -BeFalse
            (Test-DataPresenceAssertion -Body @{ id = 'e1' } -CountField '').Count | Should -Be 1
        }
    }
}
