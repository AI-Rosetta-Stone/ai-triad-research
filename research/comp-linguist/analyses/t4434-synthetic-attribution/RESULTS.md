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

## Results (run 2026-10-27; data `ai-triad-data` 5d0d5363; `synthetic_mrr.py` → `results.json`, `qualitative.json`)

### Sanity check: failed against the August numbers; the cause is taxonomy drift, not the harness

Arm A came out at 0.3042, 0.1988 and 0.5254, against stage0's 2026-08-10 figures of 0.4538, 0.2691 and 0.6284. That is outside the pre-registered ±0.02.

To tell harness error from data change, I re-ran the **unmodified** `stage0_mrr.py` on today's data. Its description-only rows came out **identical: 0.3042, 0.1988 and 0.5254**. So arm A is a faithful reproduction of the stage0 method. The fall since August comes from the taxonomy: the same-POV pools are now 229 acc, 389 saf and 381 skp nodes, and descriptions have been rewritten. I report the arms below because every comparison is paired within one run on one dataset, so the drift moves A and B/C/D together.

This is a deviation from the stop-on-failure clause. I'm stating it, not hiding it.

### Data facts
- **Synthetic corpus.** Entries are timestamped **2026-06-12 to 2026-07-22**; the files were assembled on **2026-07-22**, and the file-level `models` field lists gemini-3.6-flash and claude-sonnet-4-5, while the entries record gemini-2.5-flash. t/4434#1 gave the date as "2026-06-12". That is the first generation batch, not the corpus date.
- **Size.** 37,514 statements over 831 nodes. Non-pruned rows: acc 8,255, saf 14,216, skp 15,043.
- **Row alignment.** Rebuilt and verified against `index_<pov>.json`. The spot check re-encoded 20 rows per POV, minimum cosine 1.0.
- **Coverage.** Every gold node has statements (25/25 PRIMARY, 664/664 SECONDARY). Same-POV pool coverage is 0.86 PRIMARY and 0.83 SECONDARY; uncovered *distractors* fall back to their A score.
- **Leakage:** 0 statements at cos ≥ 0.98 to any golden claim, so there's no leak-removed re-run.

### PRIMARY, human-labelled, n=25, same-POV pool (registered decision view)

| Arm | MRR | ΔMRR vs A [95% CI] | Hit@1 | Hit@5 | Hit@10 |
|---|---|---|---|---|---|
| A description | 0.3042 | — | 0.20 | 0.40 | 0.68 |
| B max statement | 0.2174 | −0.087 [−0.244, +0.072] | 0.08 | 0.28 | 0.56 |
| C top-3 mean | 0.2948 | −0.009 [−0.175, +0.163] | 0.12 | 0.52 | 0.60 |
| D max(A,B) | 0.2168 | −0.087 [−0.244, +0.071] | 0.08 | 0.28 | 0.52 |

### PRIMARY, all-node pool (sensitivity)

| Arm | MRR | ΔMRR [95% CI] | Hit@1 | Hit@5 | Hit@10 |
|---|---|---|---|---|---|
| A | 0.1988 | — | 0.16 | 0.20 | 0.36 |
| B | 0.1528 | −0.046 [−0.190, +0.097] | 0.08 | 0.20 | 0.32 |
| C | 0.2215 | +0.023 [−0.125, +0.178] | 0.12 | 0.32 | 0.48 |
| D | 0.1497 | −0.049 [−0.193, +0.094] | 0.08 | 0.20 | 0.28 |

### SECONDARY, pipeline-attributed, n=664, same-POV (confounded toward A; direction only)

| Arm | MRR | ΔMRR [95% CI] | Hit@1 | Hit@5 | Hit@10 |
|---|---|---|---|---|---|
| A | 0.5254 | — | 0.377 | 0.721 | 0.813 |
| B | 0.3105 | −0.215 [−0.250, −0.179] | 0.166 | 0.471 | 0.645 |
| C | 0.3895 | −0.136 [−0.171, −0.100] | 0.226 | 0.598 | 0.761 |
| D | 0.3202 | −0.205 [−0.240, −0.170] | 0.173 | 0.488 | 0.664 |

## Verdict (registered rule applied; bar not moved)

**Not promising.** No arm reaches ΔMRR ≥ +0.03 with a CI excluding 0 on PRIMARY same-POV.
- **B and D (max-sim) are worse** on every view: −0.087 on PRIMARY, and clearly worse on SECONDARY. The SECONDARY confound inflates A, but a gap of −0.21 is larger than that confound plausibly explains.
- **C ties A on PRIMARY** (−0.009) and is the only arm positive anywhere (+0.023 all-node), and that CI spans 0.
- **Not shown is not "no effect":** at n=25 the CIs are ±0.16 wide.

**Likely mechanism for the max-sim loss.** A node with about 45 statements gets its *best* match over 45 paraphrases, written at temperature 1.0 and spanning archetypes. That raises every covered distractor's score more than the gold node's, because a generic statement in some distractor's set usually lands close to any claim. Top-3 averaging damps this, which fits C beating B.

**Qualitative** (20 SECONDARY claims, `qualitative.json`): the arm-B top-1 statement belongs to the gold node in 4/20 cases. In several misses the winning statement is topically *closer* to the claim than the gold node is. For example, the interpretability-as-public-good claim's gold is `acc-intentions-022`, about open-weight legal shielding. So part of SECONDARY's penalty to B is the confounded labels themselves. That fits the decision resting on PRIMARY.

## What this does and doesn't decide
- **It decides:** don't replace or max-combine the description vector with synthetic max-sim for **claim → node attribution** (`argumentNetwork/processClaims.ts`).
- **It doesn't decide the PI's actual question,** which is about **prompt rendering** (step 2): for a node *already selected*, does showing its best-matching statement instead of the DOLCE description give better prompts? That's a readability and coherence question, not a ranking one, and these numbers don't bear on it. The qualitative sample shows best-match statements are often concrete and on-topic, which keeps step 2 worth testing.
- **No hand-labelled confirmation subset is proposed,** because the result isn't promising. If C is revisited, it needs the larger human gold set that stage0 already called a prerequisite (t/4480 builds one for document key_points; debate claims would need the same).
