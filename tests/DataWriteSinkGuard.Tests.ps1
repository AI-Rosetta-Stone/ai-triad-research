# Tag: summary (t/2902)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Data-write sink guard (t/2902 Part 2) — the load-bearing gate that keeps the
    dirty-tree-sweep class CLOSED as the system grows.
.DESCRIPTION
    Modeled on lib/edges/edgesWriterGuard.test.ts. Every whole-file write of an
    ai-triad-data file MUST funnel through a guarded sink so the dirty-tree-sweep
    guard (Assert-DataWriteAllowed / Assert-CleanDataTree, or Python
    assert_clean_data_tree) runs before disk. This gate scans scripts/ and FAILS
    when a source file writes a data path with a RAW sink
    ([IO.File]::WriteAllText/Move, Move-Item, Set-Content/Add-Content, Out-File;
    Python write_text/json.dump) WITHOUT referencing a sanctioned guard/sink —
    catching a NEW writer that reintroduces the sweep, even one every per-writer
    test would miss (the coverage-tracks-growth property per-callsite wiring can't give).

    Noisy-over-silent: a legitimate non-data raw writer that trips the heuristic is
    silenced with an EXEMPT_FILES entry + a one-line reason (co-located here so the
    exemption travels with the gate).
#>

BeforeAll {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Trees that can contain data-repo writers.
    $script:ScanDirs   = @('scripts')
    $script:SourceExts = @('.ps1', '.psm1', '.py')
    $script:SkipDirs   = @('archive', '.worktrees', 'dist', 'node_modules', '.git',
                           '.claude', 'Project-Template', 'TalmudicDebate', 'CuiTests', 'en-US')

    # Files allowed to call a raw sink while touching data — each with its reason.
    # Paths are repo-relative, forward slashes.
    $script:ExemptFiles = @{
        # The guarded sinks THEMSELVES (they implement the write + call the guard).
        'scripts/AITriad/Private/Write-Utf8NoBom.ps1'      = 'the content-string sink (calls the guard, then Set-Content)'
        'scripts/AITriad/Private/Write-EdgesFile.ps1'      = 'the edges serializer (delegates to Write-Utf8NoBom)'
        'scripts/AITriad/Private/Assert-DataWriteAllowed.ps1' = 'the guard itself'
        'scripts/AITriad/Public/Assert-CleanDataTree.ps1'  = 'the guard itself'
        'scripts/data_tree_guard.py'                       = 'the Python guard itself'

        # Legitimate NON-data / regenerate-fresh / new-output writers that reference a
        # data token (so they read data) but do NOT rewrite a data-of-record file in
        # place — verified during t/2902 Part 2. Each is a genuine exception, not a
        # sweep risk.
        'scripts/embed_taxonomy.py'                        = 'regenerates embeddings.json fresh from taxonomy nodes + writes a similarity cache + stdout dumps (not a read-mutate round-trip of the same file)'
        'scripts/evaluate_embeddings.py'                   = 'json.dump to stdout / report only — no data-file write-back'
        'scripts/generate_corpus.py'                       = 'stdout dumps + NEW corpus/index/embedding exports (fresh generation, not read-mutate)'
        'scripts/migrate-t1583-tier-conversion.ps1'        = 'one-shot migration script'
        'scripts/AITriad/Public/Compare-Taxonomy.ps1'      = 'writes an HTML diff report to a temp path (non-data output)'
        'scripts/AITriad/Public/Export-AggregatedCruxes.ps1' = 'writes a NEW aggregated-cruxes export file (not an in-place rewrite)'
        'scripts/AITriad/Public/Get-TaxonomySnapshot.ps1'  = 'writes a NEW snapshot-meta.json in the snapshot output dir'
        'scripts/AITriad/Public/Invoke-AITDebate.ps1'      = 'writes debate config to a GetTempFileName() temp (non-data)'
        'scripts/AITriad/Public/Set-PovNodeTags.ps1'       = 'Set-Content writes the pov-tags-cli request JSON + captures its stderr to GetTempFileName() temps (non-data, both removed after the call); the actual taxonomy write happens via Save-JsonNodeFieldEdits'' guarded sink, not a raw sink here (t/3969)'
        'scripts/AITriad/Public/New-OpEd.ps1'              = 'writes op-ed Markdown output (new file, non-data-of-record)'
        'scripts/AITriad/Public/New-SyntheticCorpus.ps1'   = 'append-checkpoint + fresh corpus generation + NEW metadata (not a whole-file data rewrite)'
        'scripts/AITriad/Public/Test-DebatePersistence.ps1' = 'writes a random persist-probe .tmp (test probe, non-data)'
        'scripts/AITriad/Private/AICallLog.ps1'            = 'append-only AI call-log JSONL (Add-Content); references Get-DataRoot only to locate the log file — never read-mutate-rewrites a data-of-record file (t/3241)'
        'scripts/AITriad/Private/GroundingLock.ps1'        = 'advisory lockfile bookkeeping only (t/4193): [IO.File]::Move renames the <data>.lock file for the stale-break and its non-overwriting restore; it names entity_mentions.json/policy_actions.json only as the files the lock PROTECTS and never writes a data-of-record file (the callers write those through the guarded funnel)'
        'scripts/run-fol-debate-eval.ps1'                  = 'read-only FOL-on-debate eval harness (t/3354); Set-Content writes only run-manifest.json + clauses.jsonl + classified-clauses.jsonl + resolved-clauses.jsonl + formalized-clauses.jsonl + contradictions.jsonl + fn-rate-report.json + summary-contradictions.jsonl + correlation-index.json to -OutputDir, which is fail-closed asserted OUTSIDE the data root via Test-IsUnderDataRoot (design §1) — references data tokens (debates/summaries/conflicts) as read-only inputs, never writes ../ai-triad-data'
    }

    # A data-of-record path token (basename or data-dir accessor). Kept specific so
    # non-data outputs (reports/PDF/config/snapshots) do not trip the gate.
    $script:DataToken = '(?<![\w-])(?:situations|edges|policy_actions|embeddings|entities|organizations|organization_edges|conflicts)\.json|\.debate-index\.json|\.summarise-queue\.json|Get-(?:Summaries|Taxonomy|Situations|Conflicts|Debates|Sources|Data)(?:Dir|Root)\b|\bsumm_dir\b|\btax_dir\b|taxonomy[\\/]Origin'

    # Raw write sinks by language.
    $script:PsSink = '\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText|Move)\b|\bMove-Item\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b'
    $script:PySink = '\.write_text\s*\(|\bjson\.dump\s*\('

    # Sanctioned funnels — a file that references one routes its data writes through the guard.
    $script:PsSanctioned = 'Write-Utf8NoBom|Write-EdgesFile|Assert-DataWriteAllowed|Assert-CleanDataTree'
    $script:PySanctioned = 'assert_clean_data_tree|is_data_tree_clean'

    function Test-SourceContent {
        <# Returns the sink line numbers that are VIOLATIONS for one file's content. #>
        param([string]$Content, [bool]$IsPython)
        $sink       = if ($IsPython) { $script:PySink } else { $script:PsSink }
        $sanctioned = if ($IsPython) { $script:PySanctioned } else { $script:PsSanctioned }

        if ($Content -notmatch $script:DataToken) { return @() }   # not a data writer
        if ($Content -match $sanctioned) { return @() }            # funnels through the guard
        $violations = @()
        $lines = $Content -split "`n"
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match $sink) { $violations += ($i + 1) }
        }
        return $violations
    }

    function Get-DataWriteViolations {
        $viol = @()
        $reached = @()
        foreach ($d in $script:ScanDirs) {
            $root = Join-Path $RepoRoot $d
            if (-not (Test-Path $root)) { continue }
            $files = Get-ChildItem -Path $root -Recurse -File | Where-Object {
                $ext = $_.Extension.ToLower()
                if ($script:SourceExts -notcontains $ext) { return $false }
                if ($_.Name -match '\.Tests\.ps1$') { return $false }
                if ($_.Name -match '^test_.*\.py$') { return $false }
                $rel = $_.FullName.Substring($RepoRoot.Length + 1) -replace '\\', '/'
                foreach ($sd in $script:SkipDirs) { if ($rel -match "(^|/)$([regex]::Escape($sd))(/|$)") { return $false } }
                return $true
            }
            foreach ($f in $files) {
                $rel = $f.FullName.Substring($RepoRoot.Length + 1) -replace '\\', '/'
                if ($script:ExemptFiles.ContainsKey($rel)) { continue }
                $content = Get-Content -Raw -Path $f.FullName
                if (-not $content) { continue }
                $isPy = $f.Extension -ieq '.py'
                # positive control: a file that funnels a data write through the guard
                $san = if ($isPy) { $script:PySanctioned } else { $script:PsSanctioned }
                if (($content -match $script:DataToken) -and ($content -match $san)) { $reached += $rel }
                $bad = Test-SourceContent -Content $content -IsPython $isPy
                foreach ($ln in $bad) { $viol += [PSCustomObject]@{ File = $rel; Line = $ln } }
            }
        }
        return [PSCustomObject]@{ Violations = $viol; Reached = $reached }
    }
}

Describe 'Data-write sink guard (t/2902)' -Tag 'summary' {

    It 'no source file writes a data path with a raw sink outside the guarded funnel' {
        $result = Get-DataWriteViolations
        $report = ($result.Violations | ForEach-Object { "  $($_.File):$($_.Line)" }) -join "`n"
        $result.Violations | Should -BeNullOrEmpty -Because @"
Found data-repo write(s) that bypass the guarded sink:
$report

Every whole-file write of an ai-triad-data file MUST funnel through the dirty-tree-sweep
guard. Fix: route the write through Write-Utf8NoBom / Write-EdgesFile (PowerShell) or call
Assert-DataWriteAllowed (PS) / assert_clean_data_tree (Python) immediately before the raw
sink. If this is a genuine NON-data write, add the file to `ExemptFiles` in this test with a
one-line reason. (t/2902; mirrors lib/edges/edgesWriterGuard.test.ts.)
"@
    }

    It 'reaches known guarded data writers (guards against a vacuous pass)' {
        $result = Get-DataWriteViolations
        @($result.Reached).Count | Should -BeGreaterThan 0
    }

    It 'the detector fires on a bypassing writer and passes a compliant one (both arms)' {
        # Bypassing: data token + raw sink, no sanctioned funnel.
        $bypassPs = '$p = Get-SummariesDir; [System.IO.File]::WriteAllText($p, $json)'
        (Test-SourceContent -Content $bypassPs -IsPython $false) | Should -Not -BeNullOrEmpty
        $bypassPy = "data = json.loads(open(summ_dir).read())`njson.dump(data, open(fpath,'w'))"
        (Test-SourceContent -Content $bypassPy -IsPython $true) | Should -Not -BeNullOrEmpty

        # Compliant: same write, but the file references the guard.
        $okPs = 'Assert-DataWriteAllowed -Path $p; $p = Get-SummariesDir; [System.IO.File]::WriteAllText($p, $json)'
        (Test-SourceContent -Content $okPs -IsPython $false) | Should -BeNullOrEmpty
        $okPy = "from data_tree_guard import assert_clean_data_tree`nassert_clean_data_tree(fpath)`njson.dump(data, open(fpath,'w'))"
        (Test-SourceContent -Content $okPy -IsPython $true) | Should -BeNullOrEmpty

        # Non-data raw write is ignored (no data token).
        $nonData = 'Set-Content -Path $reportPath -Value $html'
        (Test-SourceContent -Content $nonData -IsPython $false) | Should -BeNullOrEmpty
    }
}
