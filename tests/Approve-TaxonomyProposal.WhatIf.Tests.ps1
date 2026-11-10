# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Pester test suite for Approve-TaxonomyProposal -WhatIf/-Confirm behavior (t/288, t/116 blocker).
# Tests that ShouldProcess gate prevents proposal application during -WhatIf.

BeforeAll {
    # Import AITriad module - use full path to worktree scripts directory
    $RepoRoot = Split-Path $PSScriptRoot -Parent | Split-Path -Parent  # Go up: tests -> batch-3 -> .worktrees
    $RepoRoot = Split-Path $RepoRoot -Parent  # Now at repo root
    $ModulePath = Join-Path $RepoRoot 'scripts/AITriad/AITriad.psd1'
    
    if (-not (Test-Path $ModulePath)) {
        throw "Cannot find AITriad module at $ModulePath"
    }
    Import-Module $ModulePath -Force -ErrorAction Stop
}

Describe 'Approve-TaxonomyProposal -WhatIf ShouldProcess gate (t/288, t/116)' {
    Context 'ApproveAll path' {
        It '-ApproveAll -WhatIf does not apply proposals' {
            # Create fixture proposal under TestDrive: (isolated temp location)
            $ProposalFile = Join-Path $TestDrive 'proposals.json'
            @{
                proposals = @(
                    @{ id = 'p1'; action = 'CREATE'; suggested_id = 'test-1'; pov = 'acc'; category = 'challenge'; label = 'Test 1' },
                    @{ id = 'p2'; action = 'CREATE'; suggested_id = 'test-2'; pov = 'saf'; category = 'opportunity'; label = 'Test 2' }
                )
            } | ConvertTo-Json -Depth 20 | Set-Content $ProposalFile

            # Mock Invoke-ProposalApply (the function that applies proposals to taxonomy)
            Mock Invoke-ProposalApply -ModuleName AITriad { @{ Success = $true; Error = $null } }

            # Run with -WhatIf; ShouldProcess must prevent Invoke-ProposalApply from being called
            $ErrorActionPreference = 'SilentlyContinue'
            Approve-TaxonomyProposal -Path $ProposalFile -ApproveAll -WhatIf | Out-Null

            # Verify Invoke-ProposalApply was never called (ShouldProcess gate prevented it)
            Should -Invoke Invoke-ProposalApply -Times 0 -ModuleName AITriad -Scope It
        }

        It '-ApproveAll without -WhatIf applies proposals' {
            $ProposalFile = Join-Path $TestDrive 'proposals2.json'
            @{
                proposals = @(
                    @{ id = 'p1'; action = 'CREATE'; suggested_id = 'test-1'; pov = 'acc'; category = 'challenge'; label = 'Test 1' }
                )
            } | ConvertTo-Json -Depth 20 | Set-Content $ProposalFile

            Mock Invoke-ProposalApply -ModuleName AITriad { @{ Success = $true; Error = $null } }

            # Run without -WhatIf (with -Confirm:$false to skip interactive prompt)
            $ErrorActionPreference = 'SilentlyContinue'
            Approve-TaxonomyProposal -Path $ProposalFile -ApproveAll -Confirm:$false | Out-Null

            # Verify Invoke-ProposalApply WAS called (proposals were applied)
            Should -Invoke Invoke-ProposalApply -Times 1 -ModuleName AITriad -Scope It
        }
    }

    Context 'Index path' {
        It '-Index -Approve -WhatIf does not apply proposal' {
            $ProposalFile = Join-Path $TestDrive 'proposals3.json'
            @{
                proposals = @(
                    @{ id = 'p1'; action = 'CREATE'; suggested_id = 'test-1'; pov = 'acc'; category = 'challenge'; label = 'Test' }
                )
            } | ConvertTo-Json -Depth 20 | Set-Content $ProposalFile

            Mock Invoke-ProposalApply -ModuleName AITriad { @{ Success = $true; Error = $null } }

            # Run with -Index 0 -Approve -WhatIf
            $ErrorActionPreference = 'SilentlyContinue'
            Approve-TaxonomyProposal -Path $ProposalFile -Index 0 -Approve -WhatIf | Out-Null

            # ShouldProcess must prevent Invoke-ProposalApply from being called
            Should -Invoke Invoke-ProposalApply -Times 0 -ModuleName AITriad -Scope It
        }

        It '-Index -Approve without -WhatIf applies proposal' {
            $ProposalFile = Join-Path $TestDrive 'proposals4.json'
            @{
                proposals = @(
                    @{ id = 'p1'; action = 'CREATE'; suggested_id = 'test-1'; pov = 'acc'; category = 'challenge'; label = 'Test' }
                )
            } | ConvertTo-Json -Depth 20 | Set-Content $ProposalFile

            Mock Invoke-ProposalApply -ModuleName AITriad { @{ Success = $true; Error = $null } }

            # Run without -WhatIf (with -Confirm:$false to skip prompt)
            $ErrorActionPreference = 'SilentlyContinue'
            Approve-TaxonomyProposal -Path $ProposalFile -Index 0 -Approve -Confirm:$false | Out-Null

            # Verify Invoke-ProposalApply was called
            Should -Invoke Invoke-ProposalApply -Times 1 -ModuleName AITriad -Scope It
        }
    }
}
