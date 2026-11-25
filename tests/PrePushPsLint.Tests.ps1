# Tag: devops (t/607)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
    t/607: the pre-push run of CI's repo-wide PowerShell lints (operations/devops/Invoke-PrePushPsLint.ps1,
    wired as the `ps-lint` step of operations/devops/pre-push-checks.sh).
    a) acceptance: a test file gaining an unregistered model id literal (the id m) is refused with
       ModelLiteralLint's own message. The fixture line is assembled at run time, so this file itself
       holds no such literal (ModelLiteralLint scans tests/, comments included);
    b) a push with no lint input changed runs nothing;
    c) Pester not at CI's pin (or the pin unreadable): WARN naming the install command, exit 3 (never a pass);
    d) the pins: every tests/*Lint*.Tests.ps1 is listed or excluded with a reason; every filtered Describe
       exists; a filter that matches nothing fails; the hook's trigger list equals the suites' Paths.
#>

BeforeDiscovery {
    # -Skip is evaluated at discovery, before BeforeAll: the Pester-pin check has to run here.
    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $m = Select-String -LiteralPath (Join-Path $root '.github' 'workflows' 'ci.yml') -Pattern "^\s*PESTER_VERSION:\s*'?([0-9][0-9.]*)'?\s*$" | Select-Object -First 1
    $HavePin = [bool]($m -and (Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [version]$m.Matches[0].Groups[1].Value }))
}

BeforeAll {
    $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
    if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:Runner = Join-Path $script:RepoRoot 'operations' 'devops' 'Invoke-PrePushPsLint.ps1'
    $script:Hook = Join-Path $script:RepoRoot 'operations' 'devops' 'pre-push-checks.sh'
    . $script:Runner   # loads SUITES, EXCLUDED and the pure functions; the run is skipped when dot-sourced
    $script:CiPester = Get-CiPesterVersion -RepoRoot $script:RepoRoot

    function script:Invoke-Runner {
        param([string]$Root, [string[]]$Files)
        $out = & pwsh -NoProfile -NonInteractive -File $script:Runner -RepoRoot $Root @Files 2>&1 | Out-String
        [pscustomobject]@{ Exit = $LASTEXITCODE; Out = $out }
    }
    function script:New-ScratchRoot {
        $d = Join-Path ([IO.Path]::GetTempPath()) "prepush-pslint-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path (Join-Path $d '.github' 'workflows') -Force | Out-Null
        $d
    }
}

Describe 'Invoke-PrePushPsLint: the pins (t/607, Lead p/233#163)' -Tag 'devops' {
    It 'reads CI''s Pester pin from ci.yml (no second literal)' {
        $script:CiPester | Should -Match '^\d+\.\d+\.\d+$'
        (Select-String -LiteralPath $script:Runner -Pattern '5\.7\.1' -SimpleMatch -Quiet) | Should -BeFalse -Because 'the pin lives in ci.yml only'
    }

    It 'every tests/*Lint*.Tests.ps1 is in SUITES or EXCLUDED with a reason, and every listed suite file exists' {
        $listed = @($script:Suites.File)
        foreach ($f in $listed) { Join-Path $script:RepoRoot $f | Should -Exist }
        foreach ($k in $script:Excluded.Keys) { [string]$script:Excluded[$k] | Should -Not -BeNullOrEmpty -Because "$k needs a reason" }
        # Case-sensitive 'Lint': -Filter is case-insensitive on Windows and matched 'CriticalInteraction'.
        $lintFiles = @(Get-ChildItem (Join-Path $script:RepoRoot 'tests') -Filter '*.Tests.ps1' -File |
                Where-Object { $_.Name -cmatch 'Lint' } | ForEach-Object { "tests/$($_.Name)" })
        $lintFiles.Count | Should -BeGreaterThan 0
        $missing = @($lintFiles | Where-Object { $_ -notin $listed -and -not $script:Excluded.ContainsKey($_) })
        $missing | Should -BeNullOrEmpty -Because 'a new repo-scan lint must be run before a push, or excluded with a reason, in Invoke-PrePushPsLint.ps1'
    }

    It 'every filtered Describe name exists verbatim in its suite file (a rename cannot empty the filter)' {
        foreach ($s in @($script:Suites | Where-Object { $_.Describes.Count })) {
            $text = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot $s.File)
            foreach ($d in $s.Describes) {
                $text.Contains("Describe '$d'") | Should -BeTrue -Because "$($s.File) must still have Describe '$d'"
            }
        }
    }

    It "the hook's PSLINT_TRIGGERS equals the suites' Paths, reduced to their covering prefixes" {
        $line = (Select-String -LiteralPath $script:Hook -Pattern "^PSLINT_TRIGGERS='([^']*)'").Matches[0].Groups[1].Value
        $triggers = @($line -split '\s+' | Where-Object { $_ })
        $paths = @($script:Suites | ForEach-Object { $_.Paths } | Sort-Object -Unique)
        foreach ($p in $paths) {
            @($triggers | Where-Object { $p.StartsWith($_, [StringComparison]::Ordinal) }).Count | Should -BeGreaterThan 0 -Because "suite path $p must trigger the hook"
        }
        foreach ($t in $triggers) { $t | Should -BeIn $paths -Because "trigger $t must be a path some suite reads" }
    }

    It 'maps every path a lint reads to that lint (scripts/ offenders are never missed on a tests-only plan, or the reverse)' {
        (Get-PrePushLintSuites -ChangedFiles 'tests/X.Tests.ps1').Name | Should -Be @('ModelLiteralLint')
        (Get-PrePushLintSuites -ChangedFiles 'scripts/AITriad/Public/X.ps1').Name |
            Should -Be @('ModelLiteralLint', 'BareThrowLint', 'CorpusJsonReadLint', 'NoModelPrefixBackendGuess')
        (Get-PrePushLintSuites -ChangedFiles 'ai-models.json').Name | Should -Be @('ModelLiteralLint')
        (Get-PrePushLintSuites -ChangedFiles '.trivyignore').Name | Should -Be @('TrivyIgnoreRevisitLint')
        (Get-PrePushLintSuites -ChangedFiles 'tests\fixtures\corpus-read-rewrite-baseline.json').Name | Should -Contain 'CorpusJsonReadLint'
    }
}

Describe 'Invoke-PrePushPsLint: what runs' -Tag 'devops' {
    It 'b) a push with no lint input changed plans no ps-lint step and selects no suite' {
        $plan = & $script:Sh $script:Hook --plan 'docs/x.md' '.github/workflows/ci.yml' 'taxonomy-editor/src/a.tsx' 2>&1 | Out-String
        $plan | Should -Not -Match 'ps-lint'
        @(Get-PrePushLintSuites -ChangedFiles 'docs/x.md', 'deploy/azure/x.ps1').Count | Should -Be 0
        (script:Invoke-Runner -Root $script:RepoRoot -Files 'docs/x.md').Exit | Should -Be 0
    }

    It 'a tests/ or scripts/ change plans the ps-lint step with the changed files' {
        $plan = & $script:Sh $script:Hook --plan 'tests/A.Tests.ps1' 'scripts/B.ps1' 2>&1 | Out-String
        $plan | Should -Match "powershell\|ps-lint\|\ttests/A\.Tests\.ps1\tscripts/B\.ps1"
    }

    It 'c) Pester not at the pin: WARN with the install command, exit 3 (never a pass)' {
        $root = script:New-ScratchRoot
        try {
            Set-Content -LiteralPath (Join-Path $root '.github' 'workflows' 'ci.yml') -Value "env:`n  PESTER_VERSION: '0.0.1'`n"
            $r = script:Invoke-Runner -Root $root -Files 'tests/X.Tests.ps1'
            $r.Exit | Should -Be 3
            $r.Out | Should -Match 'Pester 0\.0\.1 \(CI''s pin\) is not installed'
            $r.Out | Should -Match 'Install-Module Pester -RequiredVersion 0\.0\.1'
        } finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
    }

    It 'c) the pin unreadable (no ci.yml): WARN, exit 3' {
        $root = script:New-ScratchRoot
        try {
            $r = script:Invoke-Runner -Root $root -Files 'tests/X.Tests.ps1'
            $r.Exit | Should -Be 3
            $r.Out | Should -Match 'could not read PESTER_VERSION'
        } finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
    }

    It 'd) a Describe filter that matches nothing fails (exit 1), never passes silently' -Skip:(-not $HavePin) {
        $root = script:New-ScratchRoot
        try {
            Copy-Item -LiteralPath (Join-Path $script:RepoRoot '.github' 'workflows' 'ci.yml') -Destination (Join-Path $root '.github' 'workflows')
            New-Item -ItemType Directory -Path (Join-Path $root 'tests') -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $root 'tests' 'ModelLiteralLint.Tests.ps1') -Value "Describe 'Renamed away' { It 'x' { 1 | Should -Be 1 } }"
            $r = script:Invoke-Runner -Root $root -Files 'tests/X.Tests.ps1'
            $r.Exit | Should -Be 1
            $r.Out | Should -Match 'the Describe filter ran 0 tests'
        } finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
    }

    It 'a) ACCEPTANCE: a test file gaining an unregistered model id is refused, with ModelLiteralLint''s message' -Skip:(-not $HavePin) {
        $root = script:New-ScratchRoot
        try {
            # The tree ModelLiteralLint reads: tests/, scripts/ (the AITriad module and ModelLiteralScan.ps1),
            # lib/ai-config/, ai-models.json, plus ci.yml for the Pester pin.
            foreach ($p in 'tests', 'scripts', 'lib/ai-config') {
                $dest = Join-Path $root $p
                New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $script:RepoRoot $p) -Destination $dest -Recurse
            }
            Copy-Item -LiteralPath (Join-Path $script:RepoRoot 'ai-models.json') -Destination $root
            Copy-Item -LiteralPath (Join-Path $script:RepoRoot '.github' 'workflows' 'ci.yml') -Destination (Join-Path $root '.github' 'workflows')
            Set-Content -LiteralPath (Join-Path $root 'tests' 'ZzPrePushAcceptance.Tests.ps1') -Value @(
                # Assembled, so no literal of that shape sits in this file for the real lint to flag.
                ("Describe 'fixture' {{ It 'uses a model' {{ Invoke-Something -{0} '{1}' }} }}" -f 'Model', 'm'))
            $r = script:Invoke-Runner -Root $root -Files 'tests/ZzPrePushAcceptance.Tests.ps1'
            $r.Exit | Should -Be 1 -Because $r.Out
            $r.Out | Should -Match "ZzPrePushAcceptance\.Tests\.ps1:1 names unregistered id 'm'"
            $r.Out | Should -Match 'ps-lint FAILED'
            # Lead p/233#164: the one-line notice before the run names the suites and the expected time.
            $r.Out | Should -Match 'pre-push: ps-lint running ModelLiteralLint ~\d+s; expected ~\d+s \(Pester '
        } finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
    }
}
