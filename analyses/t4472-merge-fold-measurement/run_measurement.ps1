# t/4472 AC: "On >= 5 multi-chunk docs, the before/after merged key_point count and evidence
# spans per claim are reported." Read-only measurement; no corpus write.
#
# Runs the SAME 5 synthetic multi-chunk fixtures through both the pre-t/4472 merge logic
# (Merge-ChunkSummariesOld, loaded verbatim from origin/main) and the new semantic-clustering
# logic (Merge-ChunkSummaries, this PR), using the REAL local embedding model for both --
# this is a direct behavioral diff on identical input, not a noisy live-corpus comparison,
# and needs no AI spend (embeddings are local, all-MiniLM-L6-v2).
param(
    [string]$OldMergePath = (Join-Path $PSScriptRoot 'Merge-ChunkSummariesOld.ps1')
)

$ModulePath = Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'AITriad.psm1'
Import-Module $ModulePath -Force -WarningAction SilentlyContinue

$fixtures = Get-Content (Join-Path $PSScriptRoot 'fixtures.json') -Raw | ConvertFrom-Json

$mod = Get-Module AITriad
# Everything (dot-source of the old function + both merge calls per fixture) runs inside ONE
# invocation of the module's own session state -- Get-SummaryProp/Invoke-BatchEmbeddings/
# New-ContextRotStage are AITriad Private functions, invisible from outside the module's
# scope, and a dot-source done in one '& $mod {...}' call does not persist into a SEPARATE
# later '& $mod {...}' call (confirmed empirically here).
$rows = & $mod {
    param($OldPath, $Docs)
    . $OldPath

    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($doc in $Docs) {
        $chunkResults = @($doc.chunks)

        $oldMerged = Merge-ChunkSummariesOld -ChunkResults $chunkResults -WarningAction SilentlyContinue
        $newMerged = Merge-ChunkSummaries -ChunkResults $chunkResults -WarningAction SilentlyContinue

        $oldKpCount = 0; $newKpCount = 0
        foreach ($camp in @('accelerationist', 'safetyist', 'skeptic')) {
            $oldKpCount += @($oldMerged['pov_summaries'][$camp].key_points).Count
            $newKpCount += @($newMerged['pov_summaries'][$camp].key_points).Count
        }
        $oldClaimCount = @($oldMerged['factual_claims']).Count
        $newClaimCount = @($newMerged['factual_claims']).Count

        # A folded primary comes back as an [ordered] hashtable (CloneWithOverrides), not a
        # PSCustomObject; an un-folded one stays whatever ConvertFrom-Json produced. Under
        # Set-StrictMode, a plain '.evidence_spans' access throws when the shape lacks the
        # property/key at all. Get-SummaryProp (this module's own safe accessor, usable here
        # because this whole block runs inside the module's scope) handles both shapes and
        # returns $null instead of throwing.
        $newEvidenceSpansOnKp = 0
        foreach ($camp in @('accelerationist', 'safetyist', 'skeptic')) {
            foreach ($kp in @($newMerged['pov_summaries'][$camp].key_points)) {
                $kpEvidenceSpans = Get-SummaryProp $kp 'evidence_spans'
                $newEvidenceSpansOnKp += @($kpEvidenceSpans).Count
            }
        }
        $newEvidenceSpansOnClaims = 0
        foreach ($c in @($newMerged['factual_claims'])) {
            $claimEvidenceSpans = Get-SummaryProp $c 'evidence_spans'
            $newEvidenceSpansOnClaims += @($claimEvidenceSpans).Count
        }

        $preMergeKp = 0
        foreach ($ch in $chunkResults) {
            foreach ($camp in @('accelerationist', 'safetyist', 'skeptic')) {
                $preMergeKp += @($ch.pov_summaries.$camp.key_points).Count
            }
        }
        $preMergeClaims = 0
        foreach ($ch in $chunkResults) { $preMergeClaims += @($ch.factual_claims).Count }

        $out.Add([pscustomobject]@{
            doc_id                      = $doc.doc_id
            pre_merge_key_points        = $preMergeKp
            old_merged_key_points       = $oldKpCount
            new_merged_key_points       = $newKpCount
            pre_merge_claims            = $preMergeClaims
            old_merged_claims           = $oldClaimCount
            new_merged_claims           = $newClaimCount
            new_evidence_spans_on_kp    = $newEvidenceSpansOnKp
            new_evidence_spans_on_claim = $newEvidenceSpansOnClaims
        })
    }
    $out
} $OldMergePath $fixtures.docs

$rows | Format-Table -AutoSize | Out-String | Write-Host
$rows | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $PSScriptRoot 'results.json') -Encoding utf8NoBOM
Write-Host "Written to $(Join-Path $PSScriptRoot 'results.json')"
