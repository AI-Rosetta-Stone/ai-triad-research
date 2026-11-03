# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Unit coverage for Test-TemporalBoundsOverlap / ConvertTo-TemporalBoundRange (t/4474).
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '../scripts/AITriad/AITriad.psm1') -Force
}

Describe 'Test-TemporalBoundsOverlap (t/4474)' -Tag 'qbaf' {

    It 'two disjoint ranges do not overlap' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA '2023-2025' -BoundB '2030-2035' | Should -BeFalse
        }
    }

    It 'two overlapping ranges overlap' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA '2023-2027' -BoundB '2026-2030' | Should -BeTrue
        }
    }

    It 'an open "by <year>" bound overlaps a range that starts before it' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA 'by 2026' -BoundB '2020-2025' | Should -BeTrue
        }
    }

    It 'an open "by <year>" bound does not overlap a range entirely after it' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA 'by 2026' -BoundB '2030-2035' | Should -BeFalse
        }
    }

    It 'a bare single-year bound is treated as a one-year point' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA '2024' -BoundB '2023-2025' | Should -BeTrue
            Test-TemporalBoundsOverlap -BoundA '2024' -BoundB '2030-2035' | Should -BeFalse
        }
    }

    It 'is conservative (compatible/no gate) when either bound is null -- never a false positive on absent data' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA $null      -BoundB '2030-2035' | Should -BeTrue
            Test-TemporalBoundsOverlap -BoundA '2023-2025' -BoundB $null      | Should -BeTrue
            Test-TemporalBoundsOverlap -BoundA $null      -BoundB $null      | Should -BeTrue
        }
    }

    It 'is conservative when a bound is unparseable free text or "timeless"' {
        InModuleScope AITriad {
            Test-TemporalBoundsOverlap -BoundA 'timeless'       -BoundB '2030-2035' | Should -BeTrue
            Test-TemporalBoundsOverlap -BoundA 'the near future' -BoundB '2030-2035' | Should -BeTrue
        }
    }
}
