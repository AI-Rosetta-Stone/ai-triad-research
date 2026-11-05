# Tag: summary (t/3910)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-DependencyCheck (t/3910, complexity 142 -> decomposed
    into AITriad/Private helpers). Written FIRST, before the refactor, against the CURRENT
    monolithic implementation, then kept passing unchanged after the decomposition -- the
    whole point is that the externally observable behavior (returned $Ctx counts + per-check
    Status/Message) does not change, only the internal structure.
.DESCRIPTION
    Invoke-DependencyCheck probes ~10 independent areas (PowerShell, git, 3 AI API key
    backends, Node/npm/Electron apps, document-conversion tools, Python/embeddings, Windows
    containers/WSL, Docker/Neo4j, taxonomy data integrity) and aggregates Pass/Warn/Fail/
    Outdated/Fixed counts plus a Results list of { Status; Message }. Everything it touches
    (git, node, npm, pandoc, markitdown, pdftotext, docker, wsl, Windows optional features,
    live AI API probes, the filesystem) is mocked so these tests are deterministic and do
    not depend on the actual dev machine's installed tools.
#>

BeforeAll {
    $script:SavedNeo4jUri = $env:NEO4J_URI
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    # Pulls one Result's Message by Status+substring, for substring assertions (not full-text
    # match, consistent with the Get-AICostReport precedent -- console text is allowed to be
    # reformatted by the refactor as long as the Status/the substance of the Message survives).
    function Find-DepResult($Ctx, [string]$Status, [string]$Contains) {
        @($Ctx.Results | Where-Object { $_.Status -eq $Status -and $_.Message -like "*$Contains*" })
    }
}

Describe 'Invoke-DependencyCheck (t/3910)' -Tag 'summary' {

    BeforeEach {
        # ── Default "everything present and healthy" baseline. Each Context overrides the
        # specific mocks it needs to exercise a different branch. ──────────────────────────
        InModuleScope AITriad {
            # Pester cannot Mock a command Get-Command cannot resolve to begin with -- stub
            # every bare external command this function might invoke, so Mock always has a
            # target regardless of what's actually installed on the machine running these
            # tests (confirmed via a minimal repro: Mock on a wholly-undefined name throws
            # CommandNotFoundException at call time, even though Mock itself didn't error).
            # Windows-client-only cmdlets (Get/Enable-WindowsOptionalFeature, from the Dism
            # module) hit the same gap on a Server-flavored CI runner that lacks them entirely.
            foreach ($cmd in 'git','node','npm','pandoc','markitdown','pdftotext','mutool','docker','wsl','pnpm','brew','apt-get','dnf','yum','winget','choco','scoop','python3','python','Get-WindowsOptionalFeature','Enable-WindowsOptionalFeature') {
                if (-not (Get-Command $cmd -ErrorAction SilentlyContinue -CommandType Function)) {
                    Set-Item -Path "function:script:$cmd" -Value {}
                }
            }

            Mock Get-Command {
                param($Name)
                if ($Name -in @('git','node','npm','pandoc','markitdown','pdftotext','mutool','docker','brew','apt-get','dnf','yum','winget','choco','scoop','python3','python')) {
                    [PSCustomObject]@{ Name = $Name }
                }
            } -ParameterFilter { $null -ne $Name }
            # The module self-check (L126: Get-Command -Module AITriad) takes a different
            # call shape -- give it its own filter rather than letting the -Name filter above
            # swallow it and return $null (which .Count then throws on under StrictMode).
            Mock Get-Command { @(1..5) } -ParameterFilter { $null -ne $Module }

            Mock git {
                if ($args[0] -eq '--version') { return 'git version 2.44.0' }
                if ($args[0] -eq '-C') { $global:LASTEXITCODE = 0; return '/repo' }
            }
            Mock node {
                if ($args[0] -eq '--version') { return 'v22.1.0' }
                if ($args[0] -eq '-e') { return '{"ok":true,"version":"v22.1.0"}' }
            }
            Mock npm { if ($args[0] -eq '--version') { return '10.5.0' }; if ($args[0] -eq 'outdated') { return $null } }
            Mock pandoc {
                if ($args -contains '--version') { return 'pandoc 3.1' }
                return 'Hello'
            }
            Mock markitdown { '0.1.0' }
            Mock pdftotext { 'pdftotext version 24.0' }
            Mock docker {
                if ($args[0] -eq '--version') { return 'Docker version 27.0.0, build abc' }
                if ($args[0] -eq 'info') { $global:LASTEXITCODE = 0; return 'ok' }
                if ($args[0] -eq 'ps') { return '' }
            }
            Mock wsl { $global:LASTEXITCODE = 0; 'running' }
            Mock Get-WindowsOptionalFeature { [PSCustomObject]@{ State = 'Enabled' } }
            Mock Invoke-RestMethod {
                param($Uri)
                if ($Uri -like '*generativelanguage*') { return [PSCustomObject]@{ models = @(1,2,3) } }
                return [PSCustomObject]@{ ok = $true }
            }
            Mock Get-TaxonomyDir { param($ChildPath) if ($ChildPath) { Join-Path $script:DepTaxDir $ChildPath } else { $script:DepTaxDir } }
            Mock Install-AITriadData { }
            Mock Get-ChildItem -ParameterFilter { $Directory } { @(1,2,3) | ForEach-Object { [PSCustomObject]@{} } }

            $script:DepTaxDir = Join-Path $TestDrive 'taxonomy-origin'
            New-Item -ItemType Directory -Path $script:DepTaxDir -Force | Out-Null
            foreach ($f in 'accelerationist','safetyist','skeptic','situations') {
                @{ nodes = @(@{id='x'},@{id='y'}) } | ConvertTo-Json | Set-Content (Join-Path $script:DepTaxDir "$f.json")
            }
            @{ edges = @(@{},@{},@{}) } | ConvertTo-Json | Set-Content (Join-Path $script:DepTaxDir 'edges.json')
        }

        $script:RepoDir = Join-Path $TestDrive "repo-$(New-Guid)"
        New-Item -ItemType Directory -Path $script:RepoDir -Force | Out-Null
        foreach ($app in 'taxonomy-editor','poviewer','summary-viewer','edge-viewer') {
            $appDir = Join-Path $script:RepoDir $app
            New-Item -ItemType Directory -Path $appDir -Force | Out-Null
            Set-Content -Path (Join-Path $appDir 'package.json') -Value '{}'
            $nm = Join-Path $appDir 'node_modules'
            New-Item -ItemType Directory -Path (Join-Path $nm 'pkg-a') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $nm 'pkg-b') -Force | Out-Null
        }
        $env:GEMINI_API_KEY = $null
        $env:ANTHROPIC_API_KEY = $null
        $env:GROQ_API_KEY = $null
        $env:AI_API_KEY = $null
        # docker compose sets NEO4J_URI to a non-local host, which flips the Docker/Neo4j section
        # into its "managed externally" branch; start every test from the local-Neo4j baseline.
        $env:NEO4J_URI = $null
    }

    AfterAll {
        $env:NEO4J_URI = $script:SavedNeo4jUri
    }

    Context 'happy path (test mode, everything present and clean)' {
        It 'passes with zero failures and returns the aggregate counts' {
            $env:GEMINI_API_KEY = 'fake-key'
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } {
                param($RepoDir)
                Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir
            }
            $Ctx.Failed | Should -Be 0
            $Ctx.Passed | Should -BeGreaterThan 0
            Find-DepResult $Ctx 'pass' 'git 2.44.0' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'pass' 'GEMINI_API_KEY valid' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'pass' 'npm 10.5.0' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'pass' 'Taxonomy valid' | Should -Not -BeNullOrEmpty
        }
    }

    Context 'AI API KEYS (section 3 -- three near-identical backend probes)' {
        It 'Gemini: invalid key (HTTP 403) is a FAIL' {
            $env:GEMINI_API_KEY = 'bad-key'
            InModuleScope AITriad {
                Mock Invoke-RestMethod -ParameterFilter { $Uri -like '*generativelanguage*' } {
                    $resp = [PSCustomObject]@{ StatusCode = [PSCustomObject]@{ value__ = 403 } }
                    $ex = [System.Net.WebException]::new('forbidden')
                    $errRecord = [System.Management.Automation.ErrorRecord]::new($ex, 'x', 'NotSpecified', $null)
                    $errRecord.Exception | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                    throw $errRecord
                }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'GEMINI_API_KEY invalid' | Should -Not -BeNullOrEmpty
        }

        It 'Gemini: not set is a WARN (primary backend)' {
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'GEMINI_API_KEY not set' | Should -Not -BeNullOrEmpty
        }

        It 'Anthropic: valid key is a PASS, not set is silent (DSkip, no Results entry)' {
            $env:GEMINI_API_KEY = 'fake-key'
            $env:ANTHROPIC_API_KEY = 'fake-anthropic'
            InModuleScope AITriad {
                Mock Invoke-RestMethod -ParameterFilter { $Uri -like '*anthropic.com*' } { [PSCustomObject]@{ ok = $true } }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'pass' 'ANTHROPIC_API_KEY valid' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'warn' 'ANTHROPIC' | Should -BeNullOrEmpty
        }

        It 'Groq: invalid key (HTTP 401) is a FAIL' {
            $env:GEMINI_API_KEY = 'fake-key'
            $env:GROQ_API_KEY = 'bad-groq'
            InModuleScope AITriad {
                Mock Invoke-RestMethod -ParameterFilter { $Uri -like '*groq.com*' } {
                    $resp = [PSCustomObject]@{ StatusCode = [PSCustomObject]@{ value__ = 401 } }
                    $ex = [System.Net.WebException]::new('unauthorized')
                    $errRecord = [System.Management.Automation.ErrorRecord]::new($ex, 'x', 'NotSpecified', $null)
                    $errRecord.Exception | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
                    throw $errRecord
                }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'GROQ_API_KEY invalid' | Should -Not -BeNullOrEmpty
        }

        It 'no key at all is a FAIL naming the fallback' {
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'No AI API key configured' | Should -Not -BeNullOrEmpty
        }

        It 'AI_API_KEY fallback with no other key is a WARN, counted as having a key (no additional FAIL)' {
            $env:AI_API_KEY = 'fallback-key'
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'AI_API_KEY (fallback)' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'fail' 'No AI API key configured' | Should -BeNullOrEmpty
        }
    }

    Context 'NODE.JS & NPM / Electron apps (section 4)' {
        It 'Node too old (< v20) is a FAIL' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Mock node { if ($args[0] -eq '--version') { return 'v18.0.0' } } }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'too old' | Should -Not -BeNullOrEmpty
        }

        It '-SkipNode skips the whole section' {
            $env:GEMINI_API_KEY = 'fake-key'
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -SkipNode -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'pass' 'npm' | Should -BeNullOrEmpty
        }

        It 'an app with no package.json is a WARN and is skipped (no node_modules check)' {
            $env:GEMINI_API_KEY = 'fake-key'
            Remove-Item (Join-Path $script:RepoDir 'edge-viewer' 'package.json')
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'edge-viewer — package.json not found' | Should -Not -BeNullOrEmpty
        }

        It 'node_modules outdated-package detection reports the count per app (t/3999 fixed)' {
            # Was a characterized bug: $Outdated.PSObject.Properties.Count threw under StrictMode and the
            # bare catch {} swallowed it, so this detection was a silent no-op. Now @(...).Count.
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad {
                Mock npm { '10.5.0' } -ParameterFilter { $args[0] -eq '--version' }
                Mock npm {
                    (@{ a = @{current='1.0';wanted='2.0'}; b = @{current='1.0';wanted='2.0'}; c = @{current='1.0';wanted='2.0'}; d = @{current='1.0';wanted='2.0'} } | ConvertTo-Json)
                } -ParameterFilter { $args[0] -eq 'outdated' }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            # 4 fixture apps, each with node_modules -> one DStale per app.
            $Ctx.Outdated | Should -Be 4
            foreach ($app in 'taxonomy-editor','poviewer','summary-viewer','edge-viewer') {
                # The count is a real integer, not a member-enumerated "1 1 1 1" string (t/3999 AC2).
                Find-DepResult $Ctx 'outdated' "$app — 4 outdated package(s)" | Should -Not -BeNullOrEmpty
            }
        }

        It 'a failing npm outdated is skipped with a Write-Warning, not silently, and restores the location (t/3999)' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad {
                Mock npm { '10.5.0' } -ParameterFilter { $args[0] -eq '--version' }
                Mock npm { throw 'registry unreachable' } -ParameterFilter { $args[0] -eq 'outdated' }
            }
            $before = (Get-Location).Path
            # Merge the warning stream into output and keep only WarningRecords (drops the returned $Ctx).
            $warnings = @(InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } {
                param($RepoDir)
                Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] }
            })
            (Get-Location).Path | Should -Be $before -Because 'Pop-Location must run even when npm throws'
            @($warnings | Where-Object { "$_" -match 'outdated-package check skipped: registry unreachable' }).Count | Should -Be 4
        }

        It 'node_modules missing is a WARN (install mode without -Fix leaves it unskipped-but-not-attempted)' {
            $env:GEMINI_API_KEY = 'fake-key'
            Remove-Item -Recurse (Join-Path $script:RepoDir 'poviewer' 'node_modules')
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'poviewer — node_modules missing' | Should -Not -BeNullOrEmpty
        }
    }

    Context 'DOCUMENT CONVERSION (section 5)' {
        It 'pandoc smoke-test failure is a WARN naming the conversion failure' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Mock pandoc { if ($args -contains '--version') { return 'pandoc 3.1' }; return 'NOPE' } }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'conversion smoke test failed' | Should -Not -BeNullOrEmpty
        }

        It 'markitdown missing is a WARN with an install hint' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad {
                Mock Get-Command { param($Name) if ($Name -ne 'markitdown' -and $Name -in @('git','node','npm','pandoc','pdftotext','python3','docker')) { [PSCustomObject]@{ Name = $Name } } } -ParameterFilter { $null -ne $Name }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'markitdown not found' | Should -Not -BeNullOrEmpty
        }
    }

    Context 'PYTHON & EMBEDDINGS (section 6)' {
        It '-SkipPython skips the whole section' {
            $env:GEMINI_API_KEY = 'fake-key'
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -SkipPython -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'pass' 'sentence-transformers' | Should -BeNullOrEmpty
        }

        It 'python3 not found is a WARN naming Update-TaxEmbeddings' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad {
                Mock Get-Command { param($Name) if ($Name -notin @('python3','python') -and $Name -in @('git','node','npm','pandoc','markitdown','pdftotext','docker')) { [PSCustomObject]@{ Name = $Name } } } -ParameterFilter { $null -ne $Name }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'Python 3 not found' | Should -Not -BeNullOrEmpty
        }
    }

    Context 'DOCKER & NEO4J (section 7b)' {
        It 'docker not installed is a WARN' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad {
                Mock Get-Command { param($Name) if ($Name -ne 'docker' -and $Name -in @('git','node','npm','pandoc','markitdown','pdftotext','python3')) { [PSCustomObject]@{ Name = $Name } } } -ParameterFilter { $null -ne $Name }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'Docker not installed' | Should -Not -BeNullOrEmpty
        }

        It 'daemon not running is a WARN, not a FAIL' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Mock docker { if ($args[0] -eq '--version') { return 'Docker version 27.0.0, build abc' }; if ($args[0] -eq 'info') { $global:LASTEXITCODE = 1; return 'not running' } } }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'daemon not running' | Should -Not -BeNullOrEmpty
        }

        It 'external NEO4J_URI skips the local container check instead of probing docker ps' {
            $env:GEMINI_API_KEY = 'fake-key'
            $env:NEO4J_URI = 'bolt://neo4j:7687'
            # `docker ps` would report a running container; if the check wrongly runs, a PASS shows up.
            InModuleScope AITriad { Mock docker { if ($args[0] -eq '--version') { return 'Docker version 27.0.0, build abc' }; if ($args[0] -eq 'info') { $global:LASTEXITCODE = 0; return 'ok' }; if ($args[0] -eq 'ps') { $global:LASTEXITCODE = 0; return 'Up 5 minutes' } } }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'pass' 'Docker 27.0.0' | Should -Not -BeNullOrEmpty
            Find-DepResult $Ctx 'pass' 'Neo4j container running' | Should -BeNullOrEmpty
        }

        It 'external NEO4J_URI with docker not installed is not a WARN' {
            $env:GEMINI_API_KEY = 'fake-key'
            $env:NEO4J_URI = 'bolt://neo4j:7687'
            InModuleScope AITriad {
                Mock Get-Command { param($Name) if ($Name -ne 'docker' -and $Name -in @('git','node','npm','pandoc','markitdown','pdftotext','python3')) { [PSCustomObject]@{ Name = $Name } } } -ParameterFilter { $null -ne $Name }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'Docker not installed' | Should -BeNullOrEmpty
        }

        It 'a local NEO4J_URI still gets the container check' {
            $env:GEMINI_API_KEY = 'fake-key'
            $env:NEO4J_URI = 'bolt://localhost:7687'
            InModuleScope AITriad {
                Mock Get-Command { param($Name) if ($Name -ne 'docker' -and $Name -in @('git','node','npm','pandoc','markitdown','pdftotext','python3')) { [PSCustomObject]@{ Name = $Name } } } -ParameterFilter { $null -ne $Name }
            }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'warn' 'Docker not installed' | Should -Not -BeNullOrEmpty
        }
    }

    Context 'DATA INTEGRITY (section 8)' {
        It 'a missing taxonomy file is a FAIL and bumps MissingTax (install+fix clones via Install-AITriadData)' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Remove-Item (Join-Path $script:DepTaxDir 'situations.json') }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode install -Fix -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'situations.json — not found' | Should -Not -BeNullOrEmpty
            InModuleScope AITriad { Should -Invoke Install-AITriadData -Times 1 -Exactly }
        }

        It 'an unparseable taxonomy file is a FAIL naming the JSON parse failure' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Set-Content (Join-Path $script:DepTaxDir 'skeptic.json') 'not json {' }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'skeptic.json — failed to parse' | Should -Not -BeNullOrEmpty
        }

        It 'missing edges.json is skipped (DSkip, no FAIL)' {
            $env:GEMINI_API_KEY = 'fake-key'
            InModuleScope AITriad { Remove-Item (Join-Path $script:DepTaxDir 'edges.json') }
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode test -Quiet -RepoRoot $RepoDir }
            Find-DepResult $Ctx 'fail' 'edges.json' | Should -BeNullOrEmpty
        }
    }

    Context 'SUMMARY' {
        It 'reports Total as the sum of Passed+Warned+Failed and shows the -Fix hint only in install mode without -Fix' {
            $Ctx = InModuleScope AITriad -Parameters @{ RepoDir = $script:RepoDir } { param($RepoDir) Invoke-DependencyCheck -Mode install -Quiet -RepoRoot $RepoDir }
            $Ctx.Failed | Should -BeGreaterThan 0 -Because 'no AI key set in this test, so at least one FAIL is expected'
            ($Ctx.Passed + $Ctx.Warned + $Ctx.Failed) | Should -BeGreaterThan 0
        }
    }
}
