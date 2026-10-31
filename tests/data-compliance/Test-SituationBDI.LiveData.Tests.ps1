# Tag: taxonomy, DataCompliance (t/1312, relocated t/2332)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Live-data compliance trip-wire for the situation BDI-decomposition check.
    Asserts the current situations corpus (../ai-triad-data) is fully decomposed.
.NOTES
    RELOCATED from the required `test-powershell` merge gate to a data-triggered /
    scheduled job (t/2324 TL decision; t/2331 DevOps job; t/2332 PowerShell move).

    WHY THIS IS NOT A CODE GATE: this asserts an exact live-corpus count, which is a
    property of the DATA repo, not of any code change. Sitting it in the code merge
    gate coupled every unrelated code PR to data-corpus completeness — a single
    non-decomposed situation (sit-471..475, t/2323) reds the whole fleet. It now runs
    where the data actually changes; regressions alert the data/PS owner instead of
    blocking code merges. The check *logic* stays covered in the code gate via a
    fixture-based test (tests/Test-OntologyCompliance.SituationBDI.Tests.ps1, t/2332).

    UPDATING THE BASELINE is still the intended way to record backfill progress:
    - 411->412 (t/1655): corpus grew by one net compliant non-deprecated situation.
    - 412->435 (t/1805): workflow-app v1.0.0 wrote sit-448..470 un-enriched; decomposed
      via enrichment.situation-bdi-decomposition, merged with CL sign-off.
    - 435->440 (t/2323): sit-471..475 added with flat-string interpretations; decomposed
      via enrichment.situation-bdi-decomposition.
    - 440->442 (t/3009): sit-476/477 added by pipeline sync (78c943cf) with flat-string
      interpretations; CL-authored per-POV BDI decomposition (t/3009#1). Recurring
      pipeline gap tracked as t/3011 (decompose-on-emit).
    - 442->450 (t/3673): corpus grew by 8 non-deprecated situations, sit-478..485, all
      added with flat-string interpretations. sit-478 was decomposed the same day
      (e0c34cc3); the remaining SEVEN (sit-479..485, from fdf393b3 "+39 nodes ... sit 7")
      sat non-decomposed and red-ed this trip-wire for 4 days before anyone noticed.
      Decomposed via enrichment.situation-bdi-decomposition (CL, data ffacb957);
      TL second-verified on the committed tree (450/450, Fail=0).
      FOURTH occurrence of the class. The boundary gate (t/3011) DID detect it on push
      and was not heard: job green via continue-on-error, alert idempotent onto an
      already-open issue, scheduled check red and unwatched. Enforcement + alerting
      fixes tracked as t/3671; scheduled-run visibility as t/3672.
    - 450->454 (t/3886): sit-486..489 added with flat-string interpretations. They
      entered main via f9cb8ef4 (workflow-app committing the dirty shared tree, 09-29:
      sit-486/487) and 7fee2c54 (a hand-composed agent commit, 10-01: sit-488/489); the
      process that WROTE them flat is not established. Decomposed via
      enrichment.situation-bdi-decomposition (CL, data db332c7f; TL delegation t/3886#3).
      FIFTH occurrence. The push gate flagged both pushes on data issue #6 and the
      scheduled check went red; neither was acted on until 10-04, because the alert path
      was still warn-only. Producer fix tracked as t/3894.
    - 454->456 (sit-490/491, data 9eb99f88): decomposed on emit via
      Set-SituationBdiInterpretation (t/3011); no backfill needed; CL sign-off on #3333.
      First bump in this test's history that needed no backfill -- t/3011's decompose-on-emit
      fix is doing its job.
    - 456->458 (sit-492/493, data PR #78 / 5006b0fa "digital resurrection"): both nodes
      carried full per-POV interpretations (belief/desire/intention/summary x3 camps) in
      the same creation commit; no backfill needed. A later commit (e81fca8b, CL t/4620
      session-start audit) only corrected sit-493's description text, not its decomposition.
      CL sign-off (p/210#171).
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:Ontology = Test-OntologyCompliance -Quiet -PassThru -ErrorAction Continue 2>$null
    $script:BdiCheck = $script:Ontology.Checks |
        Where-Object { $_.Category -eq 'BDI' -and $_.Check -like '*BDI decomposition*' } |
        Select-Object -First 1
}

Describe 'Situation BDI-decomposition live-data baseline (t/1312, relocated t/2332)' -Tag 'taxonomy', 'DataCompliance' {

    It 'The BDI-decomposition check is present against the live corpus' {
        $script:BdiCheck | Should -Not -BeNullOrEmpty
    }

    It 'Live-data baseline: 458 / 458 non-deprecated situations pass, 1 exempt (post-#78 bump)' {
        $script:BdiCheck.Status | Should -Be 'pass'
        $script:BdiCheck.Detail | Should -Match '458 / 458'
        $script:BdiCheck.Detail | Should -Match '1 exempt via \[DEPRECATED\] prefix'
    }

    It 'Deprecation is signalled by the [DEPRECATED] description prefix (CL Q1 answer)' {
        # Verify the live corpus carries at least one [DEPRECATED] situation so the
        # exemption path is exercised against real data.
        InModuleScope AITriad {
            $tax = Get-TaxonomyDir
            $sitPath = Join-Path $tax 'situations.json'
            Test-Path $sitPath | Should -Be $true
            $sit = Get-Content -Raw -Path $sitPath -Encoding utf8 | ConvertFrom-Json
            $deprecated = @($sit.nodes | Where-Object {
                $_.PSObject.Properties['description'] -and
                ([string]$_.description).TrimStart().StartsWith('[DEPRECATED]')
            })
            $deprecated.Count | Should -BeGreaterThan 0
        }
    }
}
