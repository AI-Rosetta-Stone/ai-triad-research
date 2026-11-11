# t/246 — disagreement_type classifier re-validation (pre-registration)

**Summary.** The t/214 seed gate failed 8/9 (sit-300) because the shipped classifier prompt ("v7")
had drifted from the rubric. It narrowed `structural` to one pattern, and its INTERPRETIVE clause
3(b) described sit-300 almost word for word. The PI decided (2026-11-11):
- keep the rubric's **broad** `structural` (§2: the POVs disagree about which frame organizes the
  issue);
- keep v7's guard against one dissenting POV promoting the label (§2.2);
- remove clause 3(b).

`candidate.prompt` is v7 with exactly those changes. The STRUCTURAL clause is restated from
rubric §2 and §2.1 step 2, keeping the two-POV guard and adding a cue for situations that are
themselves a lens. Clause 3(b) is deleted. This document fixes the test **before** any run. Spend
was PI-approved: about 40 calls × 3 replicates on gemini-3.5-flash-lite.

## Sets
- **Seeds (rubric §3), 9 non-abstain:** sit-447 definitional; sit-001, 100, 250, 350, 430, 470
  interpretive; sit-300, 400 structural. **sit-050 is dropped:** its abstain anchor is stale
  (interpretations filled 2026-08-25, t/3018), and 0 of 459 situations are null or single-POV.
- **Held-out (`heldout_labels.json`), 30:** CL labels, blind to existing labels: 26 interpretive and
  4 structural. Of these, 24 are high confidence and 6 medium or low.

## Procedure
`run_validation.ps1` builds each input exactly as `Invoke-DisagreementTypeBackfill.ps1`'s
`Build-NodeInput` does (copied verbatim). It calls `Invoke-AIApi -JsonMode -Temperature 0.1
-MaxTokens 256` on gemini-3.5-flash-lite with `candidate.prompt`, runs 3 independent replicates over
seeds plus held-out, and reads the live `situations.json` read-only. No corpus write.

## Pre-registered pass criteria (all must hold)
1. **Seed gate (production readiness):** 9/9 seeds correct in **every** one of the 3 replicates. The
   production gate is one draw that must be 9/9, so anything less means a flaky gate.
2. **Held-out accuracy:** modal label (across replicates) agrees with CL on ≥ 24/30 (80%).
3. **Non-degenerate, structural:** held-out structural recall ≥ 2/4, **and** structural precision
   ≥ 0.5 (at most as many false structurals as true ones). This excludes both "always
   interpretive" and "structural over-fires".
4. **Non-degenerate, interpretive:** held-out interpretive recall ≥ 21/26 (80%).
5. **Stability:** report the per-item flip rate across replicates. Items that flip are listed, not
   hidden.

Reported with counts: every rate carries its n. If any criterion fails, the candidate is not
proposed; the failure is reported with its items, and the prompt is not tuned against the held-out
set and re-scored on the same items.

## Result (run 2026-11-11, after pre-registration commit d7f80be54) — **FAIL; candidate not proposed**

gemini-3.5-flash-lite, T=0.1, 3 replicates, `candidate.prompt` sha256 02bf5b20d2f5…; `results.json`, `score.py`.

| Criterion | Result | |
|---|---|---|
| C1 seeds 9/9 in every replicate | 9/9, **8/9**, 9/9 (sit-430 → structural in rep 2) | **FAIL** |
| C2 held-out modal accuracy ≥ 24/30 | 27/30 (high-confidence subset 21/24) | pass |
| C3 structural recall ≥ 2/4, precision ≥ 0.5 | recall 4/4, precision 4/7 | pass |
| C4 interpretive recall ≥ 21/26 | 23/26 | pass |

- **sit-300 is fixed:** structural in 3/3 (0.9).
- **The failure mode is structural over-firing on a single-POV reframe.** sit-008 (3/3), sit-376
  (3/3) and sit-168 (2/3) were labelled CL-interpretive with high confidence, and the model called
  them structural. Its rationales read three distinct POV characterizations as three frames ("treating
  it variously as a goal, a catastrophic risk, or a mere narrative"), so the two-POV guard isn't
  binding. The sit-430 seed flip is the same pattern. sit-008 has the same shape as seed sit-001
  (interpretive).
- **Flips:** 2/30 held-out items (sit-032, sit-168) and 1/9 seeds (sit-430).

Per the pre-registration, this held-out set is now **spent for tuning**. A revised prompt must be
scored on a fresh held-out set.

## Iteration 2 — pre-registration (PI-approved p/97#6; committed before any v9 run)

**Prompt:** `candidate_v9.prompt` is `candidate.prompt` with the STRUCTURAL guard tightened. Frame
conflict now means one POV argues the framing is mistaken while another adopts or defends it, and
the prompt adds: "different characterizations are not, by themselves, a frame conflict". The change
is aimed at the run-1 failure (single-POV reframes read as structural).

**Held-out set:** `heldout2_labels.json`, a fresh draw (seed 5246) disjoint from run 1's set. It was
labelled blind **before** v9 was written: 28 interpretive, 1 structural (sit-221) and 1 insufficient
(sit-154, a deprecated node with empty summaries). Only 1 of the 10 drawn from the existing-structural
stratum is CL-structural, so structural recall can't be measured here (n=1). The concern is
over-firing, which these criteria target.

**Seed gate, changed to majority-of-3 (decided before the run):** a single draw at T=0.1 that must
be 9/9 fails by chance even for a good prompt (run 1: 9/9, 8/9, 9/9). The production gate should run
the 9 seeds 3 times and take each seed's modal label.

**Pass criteria (all must hold):**
1. **Seeds, modal label over 3 replicates:** 9/9. Per-replicate scores are reported.
2. **Held-out, modal accuracy on the 29 non-abstain items:** ≥ 25/29 (86%).
3. **Over-firing:** at most 2 of the 28 CL-interpretive items come back modal-structural.
4. **Non-degenerate:** guaranteed by criterion 1. sit-300 and sit-400 must stay structural and
   sit-447 definitional, so "always interpretive" fails.

**Reported, not gated:** sit-221 (the only held-out structural); sit-154's label; per-item flips.
Run 1's held-out set re-scored under v9, as **secondary only**: that set was seen while writing v9,
so it's biased.

If any criterion fails, v9 is not proposed, and neither set is used to tune again.

## Iteration 2 — result (after pre-registration 6eb1ab495): **FAIL; v9 not proposed**

gemini-3.5-flash-lite, T=0.1, 3 replicates, `candidate_v9.prompt` sha256 687c1c93d7b6…; `results_v9.json`, `score_v9.py`.

| Criterion | Result | |
|---|---|---|
| C1 seeds, modal over 3 | 9/9 (per replicate: 9/9, 9/9, 9/9) | pass |
| C2 held-out modal accuracy | 25/29 (bar 25) | pass |
| C3 false structural ≤ 2 of 28 | **4/28** (sit-482, sit-075, sit-132, sit-118) | **FAIL** |

- **Reported:** sit-221 → structural (correct); sit-154 → insufficient (correct). Flips: 4/30.
- **v9 fixed the seed flakiness:** every replicate is 9/9, against 9/9, 8/9, 9/9 in run 1.
- **Remaining failure mode:** 3 of the 4 false structurals (sit-075, sit-132, sit-118) are situations
  that are *themselves a frame*, rejected by only one POV. The rubric is ambiguous here: §2.1 step 2
  says "at least one POV rejects the framing", while §2.2 says one voice can't promote the label.
  The PI decision (keep the one-dissenting-camp guard) settles it as interpretive. The model follows
  §2.1. Prompt wording alone hasn't overridden that in two iterations on flash-lite.
