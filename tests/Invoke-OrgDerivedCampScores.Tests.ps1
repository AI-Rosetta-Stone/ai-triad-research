# Tag: taxonomy (t/1560 Stage 5)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-OrgDerivedCampScores — Stage 5 of t/1560.
.DESCRIPTION
    AC #4 explicitly requires the zero-edges edge case (org with no
    approved camp edges → explicit-null, not silent 0). Also covers
    the approved/proposed stratum split (CL t/1560#2 — only approved
    ever lands in the derived field), the POV-BDI target filter,
    within-camp denominator semantics, and the three-state contract.
    File I/O is mocked via Get-OrganizationEdgesStore /
    Get-OrganizationsStore so tests run offline.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:workDir = Join-Path ([System.IO.Path]::GetTempPath()) "orgderived-t1560-$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $script:workDir -Force
    $script:edgesPath = Join-Path $script:workDir 'organization_edges.json'
}

AfterAll {
    if ($script:workDir -and (Test-Path $script:workDir)) {
        Remove-Item -Recurse -Force $script:workDir -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-OrgDerivedCampScores (t/1560 Stage 5)' -Tag 'taxonomy' {

    Context 'Zero-edges case (AC #4 explicit requirement)' {

        It 'Org with 0 approved camp edges gets all-null net_ratio in Approved output' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @() } | ConvertTo-Json | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-100'; name='Zero Org' }) }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.InputEdges       | Should -Be 0
                $r.EdgesAfterFilter | Should -Be 0
                @($r.Approved.Keys).Count | Should -Be 0 -Because 'no data → no key entered; three-state absent'
                $r.Distribution.acc.no_data | Should -Be 1
                $r.Distribution.saf.no_data | Should -Be 1
                $r.Distribution.skp.no_data | Should -Be 1
            }
        }
    }

    Context 'Approved vs proposed stratum split (t/1560#2 CL rule)' {

        It 'Proposed rows appear in Candidate but NEVER in Approved' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-200'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'  }
                    [PSCustomObject]@{ source='org-200'; target='saf-beliefs-002'; type='ADVOCATES_FOR'; status='proposed'  }
                    [PSCustomObject]@{ source='org-200'; target='saf-desires-003'; type='OPPOSES';      status='proposed'  }
                    [PSCustomObject]@{ source='org-200'; target='saf-beliefs-004'; type='ADVOCATES_FOR'; status='rejected'  }
                    [PSCustomObject]@{ source='org-200'; target='saf-beliefs-005'; type='ADVOCATES_FOR'; status='disputed'  }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-200'; name='Split Org' }) }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.Approved['org-200'].saf.Advocates  | Should -Be 1 -Because 'only the one approved row counts'
                $r.Approved['org-200'].saf.Opposes    | Should -Be 0
                $r.Approved['org-200'].saf.N          | Should -Be 1
                $r.Approved['org-200'].saf.NetRatio   | Should -Be 1.0

                $r.Candidate['org-200'].saf.Advocates | Should -Be 2 -Because '1 approved + 1 proposed; rejected/disputed excluded'
                $r.Candidate['org-200'].saf.Opposes   | Should -Be 1
                $r.Candidate['org-200'].saf.N         | Should -Be 3
            }
        }
    }

    Context 'POV-BDI target filter (t/1560#2 CL rule)' {

        It 'sit-* / pol-* / other org targets excluded from the rollup' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-300'; target='sit-100';         type='ADVOCATES_FOR'; status='approved' }  # excluded (sit-)
                    [PSCustomObject]@{ source='org-300'; target='pol-050';         type='ADVOCATES_FOR'; status='approved' }  # excluded (pol-)
                    [PSCustomObject]@{ source='org-300'; target='org-301';         type='ALLIED_WITH';   status='approved' }  # excluded (org- + wrong type)
                    [PSCustomObject]@{ source='org-300'; target='acc-beliefs-001'; type='ADVOCATES_FOR'; status='approved' }  # kept
                    [PSCustomObject]@{ source='org-300'; target='cc-100';          type='ADVOCATES_FOR'; status='approved' }  # excluded (legacy cc-)
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-300' }) }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.EdgesAfterFilter          | Should -Be 1
                $r.Approved['org-300'].acc.N | Should -Be 1
                $r.Approved['org-300'].saf.N | Should -Be 0
                $r.Approved['org-300'].saf.NetRatio | Should -Be $null -Because 'n=0 → explicit null, three-state'
            }
        }
    }

    Context 'Within-camp denominator (t/1560#2 CL correction)' {

        It 'net_ratio uses per-camp n, not org-total n' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                # 3 saf advocates, 1 saf oppose, 5 acc advocates.
                # Within-camp: saf net = (3-1)/4 = 0.5, acc net = 5/5 = 1.0.
                # Across-camp (WRONG per CL): saf = 2/9, acc = 5/9.
                @{ edges = @(
                    [PSCustomObject]@{ source='org-400'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='saf-beliefs-002'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='saf-desires-003'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='saf-desires-004'; type='OPPOSES';      status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='acc-beliefs-001'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='acc-beliefs-002'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='acc-beliefs-003'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='acc-desires-004'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-400'; target='acc-desires-005'; type='ADVOCATES_FOR'; status='approved' }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-400' }) }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.Approved['org-400'].saf.N        | Should -Be 4
                $r.Approved['org-400'].saf.NetRatio | Should -Be 0.5 -Because '(3-1)/4 within-camp'
                $r.Approved['org-400'].acc.N        | Should -Be 5
                $r.Approved['org-400'].acc.NetRatio | Should -Be 1.0
                $r.Approved['org-400'].skp.N        | Should -Be 0
                $r.Approved['org-400'].skp.NetRatio | Should -Be $null
            }
        }
    }

    Context 'Distribution histogram' {

        It 'Buckets net_ratio into strong_neg / mild_neg / neutral / mild_pos / strong_pos / no_data' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                # 4 orgs, each with a different saf profile:
                # - org-A: 2 OPPOSES only → net_ratio = -1.0 (strong_neg)
                # - org-B: 2 ADVOCATES + 1 OPPOSES → net_ratio = 1/3 ≈ 0.33 (mild_pos)
                # - org-C: 1 ADVOCATES + 1 OPPOSES → net_ratio = 0 (neutral)
                # - org-D: no camp edges → no_data
                @{ edges = @(
                    [PSCustomObject]@{ source='org-A'; target='saf-beliefs-001'; type='OPPOSES';      status='approved' }
                    [PSCustomObject]@{ source='org-A'; target='saf-beliefs-002'; type='OPPOSES';      status='approved' }
                    [PSCustomObject]@{ source='org-B'; target='saf-beliefs-003'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-B'; target='saf-beliefs-004'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-B'; target='saf-beliefs-005'; type='OPPOSES';      status='approved' }
                    [PSCustomObject]@{ source='org-C'; target='saf-beliefs-006'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-C'; target='saf-beliefs-007'; type='OPPOSES';      status='approved' }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @(
                        [PSCustomObject]@{ id='org-A' }
                        [PSCustomObject]@{ id='org-B' }
                        [PSCustomObject]@{ id='org-C' }
                        [PSCustomObject]@{ id='org-D' }
                    )}
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.Distribution.saf.strong_neg | Should -Be 1
                $r.Distribution.saf.mild_pos   | Should -Be 1
                $r.Distribution.saf.neutral    | Should -Be 1
                $r.Distribution.saf.no_data    | Should -Be 1
            }
        }
    }

    Context 'Recency supersession on opposite-polarity pairs (t/4475 7a)' {

        It 'newer ADVOCATES_FOR beats an older OPPOSES on the same node' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-600'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-new') }
                    [PSCustomObject]@{ source='org-600'; target='saf-beliefs-001'; type='OPPOSES';       status='approved'; source_refs=@('doc-old') }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-600' }) }
                }
                Mock _getSourceDatePublished {
                    param($DocId)
                    if ($DocId -eq 'doc-new') { [datetime]'2026-06-01' } else { [datetime]'2023-01-01' }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.Approved['org-600'].saf.Advocates | Should -Be 1 -Because 'the newer ADVOCATES_FOR wins'
                $r.Approved['org-600'].saf.Opposes   | Should -Be 0 -Because 'the older OPPOSES is superseded, not counted'
                $r.Superseded['org-600'].saf         | Should -Be 1
            }
        }

        It 'newer OPPOSES beats an older ADVOCATES_FOR on the same node' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-601'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-old2') }
                    [PSCustomObject]@{ source='org-601'; target='saf-beliefs-001'; type='OPPOSES';       status='approved'; source_refs=@('doc-new2') }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-601' }) }
                }
                Mock _getSourceDatePublished {
                    param($DocId)
                    if ($DocId -eq 'doc-new2') { [datetime]'2026-06-01' } else { [datetime]'2023-01-01' }
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath 6>$null

                $r.Approved['org-601'].saf.Advocates | Should -Be 0 -Because 'the older ADVOCATES_FOR is superseded'
                $r.Approved['org-601'].saf.Opposes   | Should -Be 1 -Because 'the newer OPPOSES wins'
                $r.Superseded['org-601'].saf         | Should -Be 1
            }
        }

        It 'an undated pair counts both and WARNs — unresolved, for a reviewer' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-602'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-undated-a') }
                    [PSCustomObject]@{ source='org-602'; target='saf-beliefs-001'; type='OPPOSES';       status='approved'; source_refs=@('doc-undated-b') }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-602' }) }
                }
                Mock _getSourceDatePublished { $null }
                $Warnings = $null
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath -WarningVariable Warnings -WarningAction SilentlyContinue 6>$null

                $r.Approved['org-602'].saf.Advocates | Should -Be 1 -Because 'undated — both count, no supersession'
                $r.Approved['org-602'].saf.Opposes   | Should -Be 1
                $r.Superseded['org-602'].saf         | Should -Be 0 -Because 'nothing was superseded, just unresolved'
                @($Warnings | Where-Object { "$_" -like '*opposite-polarity edges unresolved*' }).Count | Should -Be 1
            }
        }

        It 'a same-date pair counts both and WARNs — tied evidence cannot be resolved' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-603'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-tied-a') }
                    [PSCustomObject]@{ source='org-603'; target='saf-beliefs-001'; type='OPPOSES';       status='approved'; source_refs=@('doc-tied-b') }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-603' }) }
                }
                Mock _getSourceDatePublished { [datetime]'2025-01-01' }
                $Warnings = $null
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath -WarningVariable Warnings -WarningAction SilentlyContinue 6>$null

                $r.Approved['org-603'].saf.Advocates | Should -Be 1 -Because 'tied dates — both count'
                $r.Approved['org-603'].saf.Opposes   | Should -Be 1
                $r.Superseded['org-603'].saf         | Should -Be 0
                @($Warnings | Where-Object { "$_" -like '*opposite-polarity edges unresolved*' }).Count | Should -Be 1
            }
        }

        It 'no opposite-polarity pair on the node → output unchanged, no supersession, no WARN' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-604'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-solo') }
                    [PSCustomObject]@{ source='org-604'; target='saf-beliefs-002'; type='ADVOCATES_FOR'; status='approved'; source_refs=@('doc-solo2') }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @([PSCustomObject]@{ id='org-604' }) }
                }
                Mock _getSourceDatePublished { [datetime]'2025-01-01' }
                $Warnings = $null
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath -WarningVariable Warnings -WarningAction SilentlyContinue 6>$null

                $r.Approved['org-604'].saf.Advocates | Should -Be 2
                $r.Approved['org-604'].saf.Opposes   | Should -Be 0
                $r.Superseded['org-604'].saf         | Should -Be 0
                @($Warnings).Count | Should -Be 0
            }
        }
    }

    Context '-OrgId filter' {

        It 'Restricts processing to specified org ids' {
            InModuleScope AITriad -Parameters @{ EdgesPath = $script:edgesPath } {
                param($EdgesPath)
                @{ edges = @(
                    [PSCustomObject]@{ source='org-500'; target='saf-beliefs-001'; type='ADVOCATES_FOR'; status='approved' }
                    [PSCustomObject]@{ source='org-501'; target='acc-beliefs-002'; type='ADVOCATES_FOR'; status='approved' }
                )} | ConvertTo-Json -Depth 5 | Set-Content $EdgesPath -Encoding utf8NoBOM
                Mock Get-OrganizationsStore {
                    [PSCustomObject]@{ organizations = @(
                        [PSCustomObject]@{ id='org-500' }
                        [PSCustomObject]@{ id='org-501' }
                    )}
                }
                $r = Invoke-OrgDerivedCampScores -OrgEdgesPath $EdgesPath -OrgId 'org-500' 6>$null

                @($r.Distribution.saf.strong_pos + $r.Distribution.saf.no_data) | Should -Be 1 -Because 'only org-500 processed'
                @($r.Approved.Keys).Count | Should -Be 1
                $r.Approved.ContainsKey('org-500') | Should -BeTrue
                $r.Approved.ContainsKey('org-501') | Should -BeFalse
            }
        }
    }
}
