# Tag: write-funnel (t/4356 PR C, C5)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# The PowerShell POV write funnel must produce exactly what the TS writer produces,
# JSON.stringify(o, null, 2) + "\n", on a read-modify-write round trip (TL t/4356#1, #2, #3, #4), and must
# fail loudly, never fall back, when Node is missing (TL t/4356#7 C-a). The expected bytes are produced by
# Node from the ORIGINAL text, so the test compares against the TS rule itself, not a PowerShell imitation.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

    # The TS writer's bytes for a given JSON text.
    function script:Get-TsCanonical([string]$Text) {
        $in = Join-Path $TestDrive "ts-in-$([guid]::NewGuid()).json"
        [System.IO.File]::WriteAllText($in, $Text, [System.Text.UTF8Encoding]::new($false))
        $out = Join-Path $TestDrive "ts-out-$([guid]::NewGuid()).json"
        & $script:Node -e "const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8')),null,2)+'\n')" $in $out
        [System.IO.File]::ReadAllBytes($out)
    }

    # A target path whose suffix matches the registry key for a POV file.
    function script:New-PovTarget([string]$Name = 'accelerationist.json') {
        $dir = Join-Path $TestDrive "data-$([guid]::NewGuid())" 'taxonomy' 'Origin'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Join-Path $dir $Name
    }

    # Every arm the TL listed: floats, non-ASCII, escapes, timestamps, superseded_by, plus array shapes.
    $script:Sample = @'
{
  "_schema_version": "1.0.0",
  "last_modified": "2026-10-06",
  "nodes": [
    {
      "id": "acc-beliefs-001",
      "label": "Café 中文 🚀 ünïcode",
      "description": "Quote \" backslash \\ newline \n tab \t ctrl \u0001 slash / html </script>",
      "superseded_by": "acc-beliefs-002",
      "weights": [0.1, 1.0, 1e-7, 123456789.123, -0.5, 3.141592653589793, 100, 0, 2.5e+21],
      "created_at": "2026-01-01T00:00:00.440Z",
      "updated_at": "2026-03-04T05:06:07Z",
      "change_history": [ { "date": "2026-02-02T10:20:30.100Z", "action": "edit" } ],
      "pov_tags": ["critical"],
      "empty": [],
      "nested": { "deep": { "deeper": { "n": null, "t": true, "f": false } } }
    },
    { "id": "acc-beliefs-002", "label": "survivor", "description": "", "pov_tags": [] }
  ]
}
'@
}

AfterAll { Remove-Module AITriad -Force -ErrorAction SilentlyContinue }

Describe 'Write-PovTaxonomyFile: canonical TS bytes on a round trip' -Tag 'write-funnel' {
    It 'an untouched read-modify-write equals the TS writer byte for byte (floats, non-ASCII, escapes, timestamps, superseded_by)' {
        $target = New-PovTarget
        [System.IO.File]::WriteAllText($target, $script:Sample, [System.Text.UTF8Encoding]::new($false))
        $expected = Get-TsCanonical $script:Sample
        InModuleScope AITriad -Parameters @{ T = $target } {
            param($T)
            $doc = Read-PovTaxonomyFile -Path $T
            Write-PovTaxonomyFile -Path $T -Data $doc
        }
        $actual = [System.IO.File]::ReadAllBytes($target)
        [Convert]::ToBase64String($actual) | Should -BeExactly ([Convert]::ToBase64String($expected))
        $text = [System.IO.File]::ReadAllText($target)
        $text | Should -Match '"created_at": "2026-01-01T00:00:00.440Z"' -Because 'timestamps stay strings (no .44Z drift)'
        $text | Should -Match '"superseded_by": "acc-beliefs-002"'
        $text | Should -Match '"pov_tags": \[\s+"critical"\s+\]' -Because 'a one-element array stays an array'
        $text.Contains("`r") | Should -BeFalse
        $actual[0] | Should -Not -Be 0xEF -Because 'no BOM'
    }

    It 'a modified field changes only that field' {
        $target = New-PovTarget
        [System.IO.File]::WriteAllText($target, $script:Sample, [System.Text.UTF8Encoding]::new($false))
        InModuleScope AITriad -Parameters @{ T = $target } {
            param($T)
            $doc = Read-PovTaxonomyFile -Path $T
            $doc.nodes[1].description = 'edited'
            Write-PovTaxonomyFile -Path $T -Data $doc
        }
        $expected = Get-TsCanonical ($script:Sample.Replace('"label": "survivor", "description": ""', '"label": "survivor", "description": "edited"'))
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($target)) | Should -BeExactly ([Convert]::ToBase64String($expected))
    }

    It 'round-trips the real <Name> byte-identically' -ForEach @(@{ Name = 'accelerationist.json' }, @{ Name = 'safetyist.json' }) {
        $src = InModuleScope AITriad -Parameters @{ N = $Name } { param($N) Get-TaxonomyDir $N }
        if (-not $src -or -not (Test-Path $src)) { Set-ItResult -Skipped -Because 'no ai-triad-data checkout resolves here (CI has none)'; return }
        $target = New-PovTarget $Name
        Copy-Item -LiteralPath $src -Destination $target
        $before = [System.IO.File]::ReadAllBytes($target)
        InModuleScope AITriad -Parameters @{ T = $target } { param($T) Write-PovTaxonomyFile -Path $T -Data (Read-PovTaxonomyFile -Path $T) }
        $after = [System.IO.File]::ReadAllBytes($target)
        $after.Length | Should -Be $before.Length
        [System.Linq.Enumerable]::SequenceEqual($before, $after) | Should -BeTrue -Because "$Name is canonical at the data repo's head (registry: byte-identical)"
    }
}

Describe 'Write-PovTaxonomyFile: refuses rather than reformats' -Tag 'write-funnel' {
    It 'throws an ActionableError and writes nothing when node is missing (no ConvertTo-Json fallback)' {
        $target = New-PovTarget
        [System.IO.File]::WriteAllText($target, $script:Sample, [System.Text.UTF8Encoding]::new($false))
        $before = [System.IO.File]::ReadAllBytes($target)
        Mock -ModuleName AITriad Get-Command { $null } -ParameterFilter { $Name -eq 'node' }
        $err = $null
        try { InModuleScope AITriad -Parameters @{ T = $target } { param($T) Write-PovTaxonomyFile -Path $T -Data (Read-PovTaxonomyFile -Path $T) } }
        catch { $err = $_ }
        $err | Should -Not -BeNullOrEmpty
        "$err" | Should -Match 'Goal:'
        "$err" | Should -Match 'node is not on PATH'
        [System.Linq.Enumerable]::SequenceEqual($before, [System.IO.File]::ReadAllBytes($target)) | Should -BeTrue
    }

    It 'refuses <Name> (registry format <Format>) and leaves it untouched' -ForEach @(
        @{ Name = 'edges.json'; Format = 'edges-hybrid' }
        @{ Name = 'embeddings.json'; Format = 'producer-python' }
    ) {
        $target = New-PovTarget $Name
        [System.IO.File]::WriteAllText($target, '{"x": 1.0}', [System.Text.UTF8Encoding]::new($false))
        $err = $null
        try { InModuleScope AITriad -Parameters @{ T = $target } { param($T) Write-PovTaxonomyFile -Path $T -Data ([pscustomobject]@{ x = 1 }) } }
        catch { $err = $_ }
        "$err" | Should -Match 'exited 4'
        "$err" | Should -Match $Format
        [System.IO.File]::ReadAllText($target) | Should -BeExactly '{"x": 1.0}'
    }

    It 'refuses a file with no registry entry' {
        $target = New-PovTarget 'not-registered.json'
        $err = $null
        try { InModuleScope AITriad -Parameters @{ T = $target } { param($T) Write-PovTaxonomyFile -Path $T -Data ([pscustomobject]@{ x = 1 }) } }
        catch { $err = $_ }
        "$err" | Should -Match 'exited 3'
        Test-Path $target | Should -BeFalse
    }
}

# C5 completeness (t/4356 C2): no function that reads a POV or situations file may write JSON with
# ConvertTo-Json straight into a write sink. POV files go through Write-PovTaxonomyFile; anything else this
# matches must be a different file, allowlisted below with a reason. Stale entries fail.
Describe 'Write funnel completeness: no direct ConvertTo-Json writer of a POV file' -Tag 'write-funnel' {
    BeforeAll {
        $script:ModuleDir = (Resolve-Path (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad')).Path
        $script:PovRx = '(accelerationist|safetyist|skeptic|situations)\.json|\$Pov(Key|Name)?\.json|\$PovFileMap|\$SitPath|\$Pov\.File'
        # '<file>::<function>' -> what it actually writes (never a POV file).
        $script:Allow = [ordered]@{
            'Public/Build-NodeSourceIndex.ps1::Build-NodeSourceIndex'       = 'writes node_source_index.json'
            'Public/Get-TaxonomySnapshot.ps1::Get-TaxonomySnapshot'         = 'writes the snapshot metadata file'
            'Public/Invoke-CcToSitMigration.ps1::Invoke-CcToSitMigration'   = 'completed one-way migration (t/1308): rewrites situations.json as text; ConvertTo-Json only writes the cc->sit mapping file'
            'Public/Invoke-HierarchyProposal.ps1::Invoke-HierarchyProposal' = 'writes the hierarchy proposal and review files'
            'Public/Invoke-PolicyRefinement.ps1::Invoke-PolicyRefinement'   = 'writes policy_actions.json (the registry); its POV writes use the funnel'
            'Public/New-SyntheticCorpus.ps1::New-SyntheticCorpus'           = 'writes the synthetic corpus files'
            'Public/Show-TriadDialogue.ps1::Show-TriadDialogue'             = 'writes the debate transcript'
        }
        $script:Hits = foreach ($f in Get-ChildItem $script:ModuleDir -Recurse -Filter *.ps1) {
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$null)
            foreach ($fn in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
                $text = $fn.Extent.Text
                if ($text -notmatch $script:PovRx) { continue }
                $piped = @($fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.PipelineAst] }, $true) | Where-Object {
                        $names = @($_.PipelineElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandAst] } | ForEach-Object { $_.GetCommandName() })
                        ($names -contains 'ConvertTo-Json') -and @($names | Where-Object { $_ -in 'Set-Content', 'Write-Utf8NoBom', 'Out-File' }).Count -gt 0
                    }).Count -gt 0
                $assigned = $false
                if ($text -match '\$(\w+)\s*=\s*[^\r\n]*ConvertTo-Json -Depth') { $assigned = $text -match ('(Write-Utf8NoBom|Set-Content)[^\r\n]*-Value \(?\$' + $Matches[1]) }
                if ($piped -or $assigned) { ($f.FullName.Substring($script:ModuleDir.Length + 1) -replace '\\', '/') + '::' + $fn.Name }
            }
        }
    }

    It 'finds the non-POV writers it knows about (the scan works)' {
        @($script:Hits).Count | Should -BeGreaterThan 3
    }

    It 'every match is an allowlisted non-POV writer' {
        $new = @($script:Hits | Where-Object { -not $script:Allow.Contains($_) })
        $new | Should -BeNullOrEmpty -Because 'write POV and situations files with Write-PovTaxonomyFile (canonical TS format, t/4356); if this is a different file, allowlist it here with what it writes'
    }

    It 'has no stale allowlist entry' {
        foreach ($k in $script:Allow.Keys) { $script:Hits | Should -Contain $k -Because "$k no longer matches; remove it" }
    }
}

# The funnel carries Write-Utf8NoBom's guards (t/4356 C2), so moving a writer onto it drops none of them.
Describe 'Write-PovTaxonomyFile: carries the t/2902 guard and the 10 MB block' -Tag 'write-funnel' {
    BeforeEach {
        $script:GuardTarget = New-PovTarget
        [System.IO.File]::WriteAllText($script:GuardTarget, '{"nodes": []}' + "`n", [System.Text.UTF8Encoding]::new($false))
    }

    It 'calls Assert-DataWriteAllowed once, forwarding -AllowDirty' {
        Mock -ModuleName AITriad Assert-DataWriteAllowed { }
        InModuleScope AITriad -Parameters @{ T = $script:GuardTarget } { param($T) Write-PovTaxonomyFile -Path $T -Data ([pscustomobject]@{ nodes = @() }) -AllowDirty }
        Should -Invoke -ModuleName AITriad Assert-DataWriteAllowed -Times 1 -Exactly -ParameterFilter { $AllowDirty }
    }

    It '-RequireCleanTree uses Assert-CleanDataTree instead, and a refusal writes nothing' {
        Mock -ModuleName AITriad Assert-DataWriteAllowed { }
        Mock -ModuleName AITriad Assert-CleanDataTree { throw 'dirty-tree guard: target already carries uncommitted changes' }
        $before = [System.IO.File]::ReadAllText($script:GuardTarget)
        { InModuleScope AITriad -Parameters @{ T = $script:GuardTarget } { param($T) Write-PovTaxonomyFile -Path $T -Data ([pscustomobject]@{ nodes = @(1) }) -RequireCleanTree } } | Should -Throw '*dirty-tree guard*'
        Should -Invoke -ModuleName AITriad Assert-DataWriteAllowed -Times 0 -Exactly
        [System.IO.File]::ReadAllText($script:GuardTarget) | Should -BeExactly $before
    }

    It 'throws an ActionableError on content over 10 MB and writes nothing' {
        Mock -ModuleName AITriad Assert-DataWriteAllowed { }
        $before = [System.IO.File]::ReadAllText($script:GuardTarget)
        $big = [pscustomobject]@{ nodes = @([pscustomobject]@{ id = 'x'; description = ('a' * (10MB + 10)) }) }
        $err = $null
        try { InModuleScope AITriad -Parameters @{ T = $script:GuardTarget; D = $big } { param($T, $D) Write-PovTaxonomyFile -Path $T -Data $D } } catch { $err = $_ }
        "$err" | Should -Match 'Goal:'
        "$err" | Should -Match 'corrupted content'
        [System.IO.File]::ReadAllText($script:GuardTarget) | Should -BeExactly $before
    }
}
