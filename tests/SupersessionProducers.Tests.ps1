# Tag: supersession (t/4356 PR B, C2: AI producers exclude superseded nodes)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Two halves:
#   1. A structural completeness guard. Every file under scripts/AITriad that calls the AI and reads a POV
#      taxonomy file directly must use a supersession helper, or carry an allowlist reason. A new producer
#      can't bypass the filter silently, which is how most of C2 was missed (t/4356#6: a cache filter alone
#      covered few producers).
#   2. Behaviour: the prompt builders drop superseded nodes, superseded ids cited in new output go to the
#      survivor, and situations are never filtered (TS loader parity).

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:ModuleDir = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad'

    # Reads a POV file directly (literal camp file, a $Pov*.json path, or a camp file map).
    $script:PovReadRx = '(accelerationist|safetyist|skeptic)\.json|\$Pov(Key|Name)?\.json|\$PovFileMap|\$Pov\.File|\$TaxFiles\b|\$TaxonomyFiles\b'
    $script:AiCommands = @('Invoke-AIApi', 'Invoke-AIByUsage', 'Invoke-AIWithRetry')
    $script:Helpers = @('Set-TaxonomyDocumentSelectable', 'Select-SelectableTaxonomyNode', 'Test-TaxonomyNodeSuperseded',
        'Read-PovTaxonomyNodes', 'Get-SupersededNodeIdSet', 'ConvertTo-SurvivorNodeId')
    # Prompt builders that read POV files but call the AI from another file.
    $script:PromptBuilders = @('Private/Read-BatchSummaryTaxonomy.ps1', 'Private/Invoke-SummaryPipeline.ps1', 'Private/InvokeHierarchyProposalSteps.ps1')
    # file -> why it is exempt. Each must still match the scan (no stale entries).
    $script:Allow = [ordered]@{
        'Public/Get-ConflictEvolution.ps1'  = 'looks up the nodes a stored conflict already links (historical record, exact by design)'
        'Public/Invoke-PolicyRefinement.ps1' = 'looks up the stored member nodes of each policy and writes the files back whole'
        'Public/New-SyntheticCorpus.ps1'      = 'prompts are built by scripts/generate_corpus.py from CL artifacts; the POV match is its own corpus_<pov>.json output path'
    }

    function script:Get-ProducerScan {
        foreach ($f in Get-ChildItem $script:ModuleDir -Recurse -Filter *.ps1) {
            $rel = $f.FullName.Substring((Resolve-Path $script:ModuleDir).Path.Length + 1) -replace '\\', '/'
            if ($rel -eq 'Private/TaxonomySupersession.ps1') { continue }
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$null)
            $cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
            $text = [System.IO.File]::ReadAllText($f.FullName)
            [pscustomobject]@{
                File      = $rel
                CallsAi   = [bool]@($cmds | Where-Object { $_ -in $script:AiCommands }).Count
                ReadsPov  = $text -match $script:PovReadRx
                UsesHelper = [bool]@($cmds | Where-Object { $_ -in $script:Helpers }).Count
            }
        }
    }

    function script:N([string]$Id, [string]$By) { $h = [ordered]@{ id = $Id; label = "L $Id"; category = 'Beliefs' }; if ($By) { $h.superseded_by = $By }; [pscustomobject]$h }
}

AfterAll { Remove-Module AITriad -Force -ErrorAction SilentlyContinue }

Describe 'Producer completeness: no AI producer reads POV files without the supersession filter' -Tag 'supersession' {
    BeforeAll { $script:Scan = @(Get-ProducerScan) }

    It 'finds the known producers (the scan itself works)' {
        @($script:Scan | Where-Object { $_.CallsAi -and $_.ReadsPov }).Count | Should -BeGreaterThan 10
    }

    It 'every AI-calling POV reader uses a supersession helper or is allowlisted with a reason' {
        $missing = @($script:Scan | Where-Object { $_.CallsAi -and $_.ReadsPov -and -not $_.UsesHelper -and -not $script:Allow.Contains($_.File) } | ForEach-Object File)
        $missing | Should -BeNullOrEmpty -Because 'a new producer must filter superseded nodes (Set-TaxonomyDocumentSelectable / Select-SelectableTaxonomyNode / Test-TaxonomyNodeSuperseded) or be allowlisted here with a reason'
    }

    It 'every prompt builder without its own AI call uses a helper' {
        foreach ($p in $script:PromptBuilders) {
            ($script:Scan | Where-Object File -eq $p).UsesHelper | Should -BeTrue -Because $p
        }
    }

    It 'has no stale allowlist entry' {
        foreach ($k in $script:Allow.Keys) {
            $row = $script:Scan | Where-Object File -eq $k
            $row | Should -Not -BeNullOrEmpty -Because "$k must still exist"
            ($row.CallsAi -and $row.ReadsPov -and -not $row.UsesHelper) | Should -BeTrue -Because "$k no longer needs the exemption; remove it"
        }
    }
}

Describe 'Selection helpers' -Tag 'supersession' {
    It 'Set-TaxonomyDocumentSelectable narrows a camp file and leaves situations whole' {
        InModuleScope AITriad -Parameters @{ A = (N 'a' 'b'); B = (N 'b'); S = (N 's' 't') } {
            param($A, $B, $S)
            $doc = [pscustomobject]@{ nodes = @($A, $B) }
            Set-TaxonomyDocumentSelectable -Document $doc -Name 'accelerationist.json'
            @($doc.nodes | ForEach-Object id) | Should -Be @('b')
            $sit = [pscustomobject]@{ nodes = @($S) }
            Set-TaxonomyDocumentSelectable -Document $sit -Name 'situations'
            @($sit.nodes | ForEach-Object id) | Should -Be @('s')
        }
    }

    It 'Select-SelectableTaxonomyNode emits nodes, so @() at a call site holds the nodes, not one array' {
        # Regression: a comma-wrapped return made $AllNodes = @(Select ...) a one-element array (caught in PR B).
        InModuleScope AITriad -Parameters @{ A = (N 'a'); B = (N 'b'); C = (N 'c' 'a') } {
            param($A, $B, $C)
            $r = @(Select-SelectableTaxonomyNode -Nodes @($A, $B, $C))
            $r.Count | Should -Be 2
            $r[0].id | Should -BeExactly 'a'
        }
    }

    It 'Select-SelectableTaxonomyNode -Pov passes a situations list through' {
        InModuleScope AITriad -Parameters @{ S = (N 's' 't') } {
            param($S)
            @(Select-SelectableTaxonomyNode -Nodes @($S) -Pov 'situations' | ForEach-Object id) | Should -Be @('s')
            @(Select-SelectableTaxonomyNode -Nodes @($S) -Pov 'skeptic').Count | Should -Be 0
        }
    }
}

Describe 'Producers see only selectable nodes' -Tag 'supersession' {
    BeforeAll {
        $script:Tax = Join-Path $TestDrive 'tax'
        New-Item -ItemType Directory -Path $script:Tax -Force | Out-Null
        @{ nodes = @((N 'acc-beliefs-001' 'acc-beliefs-002'), (N 'acc-beliefs-002')) } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:Tax 'accelerationist.json')
        @{ nodes = @((N 'saf-beliefs-001')) } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:Tax 'safetyist.json')
        @{ nodes = @((N 'skp-beliefs-001')) } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:Tax 'skeptic.json')
        @{ nodes = @((N 'sit-001' 'sit-002'), (N 'sit-002')) } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:Tax 'situations.json')
        $d = $script:Tax
        Mock -ModuleName AITriad Get-TaxonomyDir { param($ChildPath) if ($ChildPath) { Join-Path $d $ChildPath } else { $d } }.GetNewClosure()
    }

    It 'Build-CompactTaxonomy (summary RAG fallback) leaves out a superseded node' {
        $out = InModuleScope AITriad { Build-CompactTaxonomy }
        $out | Should -Not -Match 'acc-beliefs-001'
        $out | Should -Match 'acc-beliefs-002'
        $out | Should -Match 'sit-001' -Because 'situations are never filtered'
    }

    It 'Read-BatchSummaryTaxonomy (batch summary prompt) leaves out a superseded node' {
        $ctx = InModuleScope AITriad -Parameters @{ D = $script:Tax } { param($D) Read-BatchSummaryTaxonomy -TaxonomyDir $D -FileName @('accelerationist.json', 'situations.json') 6>$null }
        @($ctx['accelerationist.json'].nodes | ForEach-Object id) | Should -Be @('acc-beliefs-002')
        @($ctx['situations.json'].nodes).Count | Should -Be 2
    }
}

Describe 'Superseded ids cited in new AI output go to the survivor (TL t/4356#7 decision 2)' -Tag 'supersession' {
    BeforeAll {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                accelerationist = [pscustomobject]@{ nodes = @(
                        [pscustomobject]@{ id = 'acc-beliefs-001'; superseded_by = 'acc-beliefs-002' },
                        [pscustomobject]@{ id = 'acc-beliefs-002' }) }
            }
            $script:TaxonomyCacheLastCheck = [DateTime]::UtcNow.AddHours(1)
            Update-TaxonomySupersessionCache
        }
    }

    It 'ConvertTo-SurvivorNodeId rewrites a superseded id with a WARN and leaves others alone' {
        InModuleScope AITriad {
            $w = $null
            ConvertTo-SurvivorNodeId -Id 'acc-beliefs-001' -WarningVariable w -WarningAction SilentlyContinue | Should -BeExactly 'acc-beliefs-002'
            "$w" | Should -Match 'superseded'
            ConvertTo-SurvivorNodeId -Id 'acc-beliefs-002' | Should -BeExactly 'acc-beliefs-002'
            ConvertTo-SurvivorNodeId -Id 'not-a-node' | Should -BeExactly 'not-a-node'
        }
    }

    It 'the summary id check attributes a superseded citation to the survivor instead of unmapping it' {
        InModuleScope AITriad {
            Mock Get-TaxonomyNodeIdSet {
                $s = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($i in 'acc-beliefs-001', 'acc-beliefs-002') { [void]$s.Add($i) }
                , $s
            }
            Mock Write-Host { }
            $kp = [pscustomobject]@{ point = 'p'; taxonomy_node_id = 'acc-beliefs-001'; stance = 'supports' }
            $sum = [pscustomobject]@{
                pov_summaries     = [pscustomobject]@{ accelerationist = [pscustomobject]@{ key_points = @($kp) }; safetyist = [pscustomobject]@{ key_points = @() }; skeptic = [pscustomobject]@{ key_points = @() } }
                unmapped_concepts = @()
            }
            $moved = Move-HallucinatedNodeIdsToUnmapped -SummaryObject $sum 3>$null
            @($moved).Count | Should -Be 0
            $kp.taxonomy_node_id | Should -BeExactly 'acc-beliefs-002'
        }
    }
}
