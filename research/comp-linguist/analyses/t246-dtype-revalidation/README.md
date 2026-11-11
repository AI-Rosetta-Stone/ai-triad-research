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
