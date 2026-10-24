# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Compiled scoring kernel for Get-RelevantTaxonomyNodes (t/4468). Scoring a query against every node's synthetic
# vectors is ~14M multiply-adds per query window (36k synthetic vectors x 384 dims); covering a whole ~60k-char
# chunk takes ~67 windows, which a PowerShell loop cannot do in reasonable time.
#
# Per window, the score is EXACTLY the former per-node PowerShell formula (Get-RagWindowScoreFallback below):
#   synthetic node: mean of the top-N cosine similarities over its vectors (vectors with a zero norm skipped);
#   single-vector node: cosine similarity (0 when a norm is zero).
# Two ways to combine windows (CL t/4468#2 item 2; the offline A/B decides the default):
#   MaxSim     - a node's score is its max over windows (cosine scale);
#   RankFusion - reciprocal-rank fusion over the per-window rankings, sum of 1/(K + rank) (scale-free; every
#                section contributes). K = 60, the conventional RRF constant (stipulated).
# With one window both orderings equal the old one, and MaxSim equals the old scores (pinned by
# tests/RagQueryWindows.Tests.ps1).
# Versioned type name (the GroundingLock.ps1 pattern): Add-Type cannot redefine a type in one AppDomain and the
# module is re-imported many times per session, so a changed definition gets a new name.

$script:RagKernelTypeName = 'AITriad.RagKernelV1.Scorer'
$script:RagRrfK = 60
$script:RagKernelTypeSource = @'
using System;

namespace AITriad.RagKernelV1
{
    public static class Scorer
    {
        // windows: query vectors [W][D]. nodes: per node, its vectors [V][D] (one vector for a single-vector node).
        // topN: per node, how many of its best per-vector similarities to average (1 for a single-vector node).
        // Returns [W][N]: the per-window score of every node.
        public static double[][] ScoreMatrix(double[][] windows, double[][][] nodes, int[] topN)
        {
            if (windows == null || nodes == null || topN == null || nodes.Length != topN.Length)
                throw new ArgumentException("windows, nodes and topN are required, and nodes/topN must align");
            int w = windows.Length;
            double[][] m = new double[w][];
            double[][] normB = new double[nodes.Length][];
            for (int n = 0; n < nodes.Length; n++)
            {
                normB[n] = new double[nodes[n].Length];
                for (int v = 0; v < nodes[n].Length; v++)
                {
                    double s = 0.0; double[] b = nodes[n][v];
                    for (int i = 0; i < b.Length; i++) s += b[i] * b[i];
                    normB[n][v] = s;
                }
            }
            int maxV = 1;
            for (int n = 0; n < nodes.Length; n++) if (nodes[n].Length > maxV) maxV = nodes[n].Length;
            double[] sims = new double[maxV];
            for (int a = 0; a < w; a++)
            {
                double[] q = windows[a];
                int dim = q.Length;
                double qn = 0.0;
                for (int i = 0; i < dim; i++) qn += q[i] * q[i];
                double qNorm = Math.Sqrt(qn);
                double[] row = new double[nodes.Length];
                for (int n = 0; n < nodes.Length; n++)
                {
                    double[][] vecs = nodes[n];
                    bool single = topN[n] <= 1 && vecs.Length == 1;
                    int count = 0;
                    for (int v = 0; v < vecs.Length; v++)
                    {
                        double[] b = vecs[v];
                        if (b.Length != dim) continue;
                        double dot = 0.0;
                        for (int i = 0; i < dim; i++) dot += q[i] * b[i];
                        double d = qNorm * Math.Sqrt(normB[n][v]);
                        if (d > 0) sims[count++] = dot / d;
                        else if (single) sims[count++] = 0.0;
                    }
                    double score;
                    if (count == 0) score = 0.0;
                    else if (single) score = sims[0];
                    else
                    {
                        Array.Sort(sims, 0, count);   // ascending; the top-N are at the end
                        int take = Math.Min(topN[n], count);
                        double sum = 0.0;
                        for (int j = 0; j < take; j++) sum += sims[count - 1 - j];
                        score = sum / take;
                    }
                    row[n] = score;
                }
                m[a] = row;
            }
            return m;
        }

        // Max over windows, per node.
        public static double[] MaxOverWindows(double[][] m, int nodeCount)
        {
            double[] r = new double[nodeCount];
            if (m.Length == 0) return r;
            for (int n = 0; n < nodeCount; n++)
            {
                double best = double.NegativeInfinity;
                for (int a = 0; a < m.Length; a++) if (m[a][n] > best) best = m[a][n];
                r[n] = best;
            }
            return r;
        }

        // Reciprocal-rank fusion: per window, rank nodes by score (1 = best; ties broken by node index), then
        // sum 1/(k + rank) over windows.
        public static double[] RankFusion(double[][] m, int nodeCount, int k)
        {
            double[] r = new double[nodeCount];
            int[] idx = new int[nodeCount];
            for (int a = 0; a < m.Length; a++)
            {
                double[] row = m[a];
                for (int n = 0; n < nodeCount; n++) idx[n] = n;
                Array.Sort(idx, (x, y) => { int c = row[y].CompareTo(row[x]); return c != 0 ? c : x.CompareTo(y); });
                for (int rank = 0; rank < nodeCount; rank++) r[idx[rank]] += 1.0 / (k + rank + 1);
            }
            return r;
        }
    }
}
'@

function Initialize-RagKernelType {
    # Compiles the scoring kernel once per process, on first use (not at module import). $null when it can't
    # (CL t/4468#2 item 4): the caller then falls back to the single-window PowerShell scorer with a WARN.
    [CmdletBinding()]
    param()
    try {
        if (-not ([System.Management.Automation.PSTypeName]$script:RagKernelTypeName).Type) {
            Add-Type -Language CSharp -TypeDefinition $script:RagKernelTypeSource -ErrorAction Stop
        }
        ([System.Management.Automation.PSTypeName]$script:RagKernelTypeName).Type
    }
    catch {
        Write-Warning "Get-RelevantTaxonomyNodes: the RAG scoring kernel could not be compiled ($($_.Exception.Message)); falling back to the single-window PowerShell scorer, so only the query's first window is scored (t/4468)."
        $null
    }
}

function Get-RagWindowScoreFallback {
    # The former per-node PowerShell formula for ONE query vector (the fallback when the kernel is unavailable,
    # and the reference the kernel is pinned against). Returns the node's score, or $null to skip the node
    # (a single vector of the wrong dimension, as before).
    param([double[]]$QueryVector, [object[]]$NodeVectors, [int]$TopN, [bool]$Synthetic)
    $Dim = $QueryVector.Count
    $QueryNormSq = 0.0
    for ($i = 0; $i -lt $Dim; $i++) { $QueryNormSq += $QueryVector[$i] * $QueryVector[$i] }
    $QueryNormSqrt = [Math]::Sqrt($QueryNormSq)
    if ($Synthetic) {
        $Sims = [System.Collections.Generic.List[double]]::new()
        foreach ($SynVec in $NodeVectors) {
            $Dot = 0.0; $NormB = 0.0
            for ($i = 0; $i -lt $Dim; $i++) { $Dot += $QueryVector[$i] * $SynVec[$i]; $NormB += $SynVec[$i] * $SynVec[$i] }
            $D = $QueryNormSqrt * [Math]::Sqrt($NormB)
            if ($D -gt 0) { $Sims.Add($Dot / $D) }
        }
        $SortedSims = @($Sims | Sort-Object -Descending)
        $N = [Math]::Min($TopN, $SortedSims.Count)
        if ($N -le 0) { return 0.0 }
        $Sum = 0.0
        for ($j = 0; $j -lt $N; $j++) { $Sum += $SortedSims[$j] }
        return $Sum / $N
    }
    $NodeVec = $NodeVectors[0]
    if (@($NodeVec).Count -ne $Dim) { return $null }
    $Dot = 0.0; $NormB = 0.0
    for ($i = 0; $i -lt $Dim; $i++) { $Dot += $QueryVector[$i] * $NodeVec[$i]; $NormB += $NodeVec[$i] * $NodeVec[$i] }
    $D = $QueryNormSqrt * [Math]::Sqrt($NormB)
    if ($D -gt 0) { $Dot / $D } else { 0.0 }
}
