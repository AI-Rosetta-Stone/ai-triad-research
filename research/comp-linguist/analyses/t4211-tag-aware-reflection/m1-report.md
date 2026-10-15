# M1: custodian-check judge calibration

**Author:** Computational Linguist
**Date:** 2026-10-15
**Ticket:** t/4211 (spec §6 M1)
**Result:** **The go-live gate is not met.** The judge is not yet reliable enough to separate `conflict` from `tension`. It is reliable enough to tell flagged edits from consistent ones, and §5 recommends an interim rule on that basis.

## What was run

- **Judge:** `buildCustodianCheckPrompt` and `parseCustodianCheckOutput` on main `7160ea45` (after #3300 and #3306), via `scripts/t4211_m1_judge_calibration.ts`.
- **Model:** `gemini-3.5-flash-lite`, the most-used debate model since 2026-10-01 (9 of 20 debates), at temperature 0.
- **Population:** every past Skeptic reflection edit to a node that still exists (177, data `b030e2b3`), minus 10 no-op edits, which the live pipeline drops before the check (t/3813). That leaves **n = 167**.
- **Custodians:** each edit was checked as if from an untagged seat, which is what every past seat was. The custodians are therefore the target node's tag souls: `umbrella_on_tagged`.
- **Outcome:** all 167 calls returned a parseable verdict for every custodian, so there were 0 `unchecked` results.

## Population results (n = 167; each edit scored by its worst verdict)

| Target | consistent | tension | conflict | n |
|---|---|---|---|---|
| critical only | 61 | 3 | 1 | 65 |
| both | 47 | 5 | 2 | 54 |
| institutional only | 45 | 3 | 0 | 48 |
| **all** | **153 (92%)** | **11 (7%)** | **3 (2%)** | **167** |

The pre-#3306 prompt gave 154 / 10 / 3, so the delimiter and header change moved one edit from consistent to tension.

## Agreement with CL labels (n = 34)

**Sample:** all 14 edits the judge flagged (tension or conflict), plus 20 judge-consistent edits drawn round-robin across the three target classes (seed 4211), then shuffled.
- The CL labelled the sample from `m1-label-sheet.md`, blind to the judge's verdicts. The labels are in `m1-cl-labels.json`, and `scripts/t4211_m1_agreement.py` reproduces the numbers below.
- **Rater caveat:** the CL is itself an LLM agent. Agreement between two models can be inflated by shared bias, so these labels do **not** make the judge human-validated (§5.3).

| CL \ judge | consistent | tension | conflict |
|---|---|---|---|
| consistent | 19 | 4 | 0 |
| tension | 1 | 6 | 2 |
| conflict | 0 | 1 | 1 |

| Granularity | κ | Agreement | Chance | Prevalence (CL / judge) |
|---|---|---|---|---|
| 3-class | **0.54** | 0.76 | 0.49 | conflict 2 / 3, tension 9 / 11 |
| flag vs consistent | **0.69** | 0.85 | 0.53 | flag 11 / 14 |
| conflict vs not | **0.35** | 0.91 | 0.86 | conflict 2 / 3 |

**Against the spec §6 gate**, which required κ ≥ 0.6, n ≥ 30, at least 5 `conflict` and at least 5 `consistent` items, and every cell non-empty for both raters:
- n = 34 meets the size requirement.
- The 3-class κ of 0.54 is below 0.6.
- The conflict cells hold 2 (CL) and 3 (judge) items, below the required 5. This could not have been met on this corpus: the judge finds only 3 conflicts in all 167 edits. So the gate is **not met** on two counts.

## What the disagreements show

Eight items disagree. Three patterns account for the ones that matter:

1. **Dropping a value is called a conflict** (S22, S34).
   - On S22, the judge cited Critical's "Human stakes over abstraction" because the edit removed statutory standing.
   - On S34, it cited "Power accountability" because the edit removed the profit-motive critique.
   - The spec defines `conflict` as *asserting* something a hardcoded boundary forbids, or *inverting* the value order. Removing emphasis is `tension`. These false conflicts would add needless confirmations, so they are the less harmful error.
2. **The clearest conflict was missed** (S31).
   - The edit rewrites "Targeting Evidenced Harms" into a critique of historical analogies, built on "AI's unique velocity and scale of disruption".
   - That contradicts the Institutional hardcoded boundary "The speed of capability gains is not the speed of societal impact", and the wing's whole diffusion-like-electricity stance.
   - The judge rated it `tension`, citing value 1, and never tested the hardcoded boundary. **This is the error the gate exists to catch**: a blocking case that slips through.
3. **The citation is real but irrelevant** (S04, Critical).
   - The judge returned `conflict` citing "REJECT: Claims that a text-prediction system understands, intends, or reasons", but the edit is about hardware containment and says nothing about machine understanding.
   - The parser's check (#3300 fix 2) confirms that the quote exists in the soul. It cannot confirm that the quote applies to the edit.
   - The overall verdict for S04 was still right, because the Institutional custodian's conflict, citing "Resilience over prevention", is correct.

The remaining five disagreements (S01, S05, S21, S24, S28) are tension-versus-consistent judgment calls. None of them involves a block.

## Recommendations

### 5.1 Judge prompt v2 (DebateTool; CL reviews the wording)

- **(a) Define the boundary between tension and conflict explicitly.** "Removing or weakening a position the custodian values is TENSION. CONFLICT requires the proposed text to assert something a hardcoded boundary forbids, or to state a priority order opposite to the value hierarchy."
- **(b) Test hardcoded boundaries first, one by one.** The judge should answer for each hardcoded boundary before it considers the values. S31 failed because the judge went straight to values.
- **(c) Require two-sided evidence for a conflict.** Add an `evidence` field holding a verbatim span of the *proposed* text that asserts the forbidden claim. The parser verifies that span against the proposed text, as it already verifies `cited` against the soul. A conflict whose evidence can't be verified becomes `unchecked`. This targets the irrelevant-citation case (S04).
- **(d) Compare models.** Run v2 on `gemini-3.5-flash-lite` and on one advanced-tier model (`gemini-3.1-pro-preview`). If only the advanced model passes, the check should pin that model rather than use the debate model. That needs a spec §4 change.

### 5.2 Add a constructed challenge set to the gate

Real conflicts are about 2% of past edits, so a gate that needs 5 observed conflicts can't be met by sampling the corpus.
- **Add** about 12 **constructed** edits:
  - 6 that each contradict a named hardcoded boundary or invert a value pair, across both wings;
  - 6 near misses that only drop emphasis.
- **Label** them `constructed`, never `observed` (CL rule t/2294), and keep them separate from the 34 observed items.
- **v2 gate:**
  - the conflict-vs-not κ on observed and constructed items together is at least 0.6;
  - every constructed conflict is caught (sensitivity 6 of 6);
  - the flag-vs-consistent κ on the observed set stays at or above 0.6.

These thresholds are stipulated, and register §19 records them.

### 5.3 Interim rule for t/4214 until v2 passes

At the flag level the judge agrees with the CL at κ = 0.69, with 1 miss in 11 flags (S05). At the conflict level it doesn't (κ = 0.35, and S31 was missed). So, for now:
- **Treat `tension` and `conflict` the same.** Both require confirmation before applying.
- **Show the verdict and its citation**, but don't make "conflict" a stronger block than "tension" yet.
- **Expected confirmation load:** about 8% of Skeptic edits (14 of 167). That is low.

This rule was chosen **after** the 3-class result was known, so it is a provisional engineering decision, not a pre-registered pass. It lapses when v2 meets §5.2.

**Human anchor:** for the judge to count as **human-validated** (register §19), a human must label the 34-item sheet (`m1-label-sheet.md`, roughly 45 minutes), or at least the 14 judge-flagged items plus 6 random consistent ones. Until then the provenance stays **stipulated, agent-checked**.

## Files

- `m1-results.jsonl`: judge output, 167 rows, one per edit, with per-custodian verdicts, citations and reasons.
- `m1-sample-keys.json`, `m1-label-sheet.md`, `m1-cl-labels.json`: the blind sample, the sheet, and the CL labels with a short reason for each non-consistent label.
- `../../scripts/t4211_m1_judge_calibration.ts`: the judge run. It resumes from its output file, and it skips no-op edits as the live pipeline does.
- `../../scripts/t4211_m1_agreement.py`: the agreement statistics above.
