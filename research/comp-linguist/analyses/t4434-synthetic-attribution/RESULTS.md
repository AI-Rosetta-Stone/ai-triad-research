# t/4434 AC2 step 1: synthetic statements as a claim-attribution match surface

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Ticket:** t/4434 (plan at t/4434#1) · **Spend:** none (local all-MiniLM-L6-v2)

## Pre-registration (written and committed before any arm was computed)

**Question.** When attributing a debate claim to a taxonomy node, does matching the claim against a node's synthetic statements rank the gold node higher than matching against the node's description vector?

**Datasets.** The "515-claim golden set" named in t/4434#1 and in `docs/claim-matching-experiments-report.md` has since been rebuilt. The tracked file `_golden_test_set.json` now holds 664 claims (built 2026-06-12). This experiment uses the two datasets that the most recent golden-set harness, `analyses/stage0-composition-mrr/stage0_mrr.py` (t/2440), uses:
- **PRIMARY (decision basis): human-labelled, n=25.** From `_golden_validation_results.json`. The gold node is `corrected_node` when the verdict is `incorrect`, and `original_node` when it is `correct`. Verdicts `uncertain` and `novel` are excluded.
- **SECONDARY (direction only): pipeline-attributed, n=664.** The gold node is `attributed_node`. **This set is confounded in favour of arm A**, because the production system attributed these claims by description-vector similarity. A win for B/C/D on it understates the effect, and a loss overstates it.

**Candidate pool.** The same-POV pool (registered) is all nodes of the claim's POV, all BDI categories, as in stage0. The all-node pool is a sensitivity check, because 16 of the 25 human gold nodes are cross-POV. The report's original "same-POV Belief-only" pool cannot apply here, since the gold set includes Desires and Intentions.

**Arms.** In every arm the claim vector is `claim_text`, L2-normalised.
- **A (baseline):** the description-only node vector, the live composition, built with `embed_taxonomy._compose_field_texts` weights (1,0,0,0,0) exactly as stage0 does. Sanity check: A must reproduce stage0's description-only MRR (PRIMARY same-POV 0.4538, all-node 0.2691; SECONDARY 0.6284) within ±0.02, allowing for taxonomy drift since 2026-08-10. If it doesn't, stop and report.
- **B:** the maximum cosine similarity over the node's synthetic statements.
- **C:** the mean of the node's top-3 statement similarities.
- **D:** max(A, B).
- **Nodes with no synthetic statements** (added after the corpus was built) fall back to the arm-A score in B, C and D. Coverage is reported per pool.

**Metrics.** MRR, Hit@1, Hit@5 and Hit@10, with n.

**Inference.** Paired bootstrap (10,000 resamples of claims, seed 4434) on MRR(arm) − MRR(A), giving a 95% percentile CI.

**Decision rule.** An arm is **promising** if, on PRIMARY same-POV, ΔMRR ≥ +0.03 and the 95% CI excludes 0. A gain only on SECONDARY is never sufficient. With n=25 the CI will be wide, so a non-promising result means *not shown*, not *no effect*.

**Leakage check.** Synthetic statements were generated from node text, and production attributions were made from node text. If any statement has cosine ≥ 0.98 to a golden claim, re-run B/C/D with those statements removed and report both.

**Qualitative.** For 20 random SECONDARY claims (seed 4434), record the gold node's best-matching statement and the arm-B top-1 statement. This is input for step 2 (prompt surface).

**Limitation, stated in advance.** SECONDARY attributions are system-generated and not human-verified (report §3.1). PRIMARY is small (n=25) and enriched for hard cases: 15 of the 25 were originally mis-attributed.

## Results

_(appended after the run)_
