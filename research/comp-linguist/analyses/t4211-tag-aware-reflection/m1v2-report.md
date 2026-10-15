# M1 v2: custodian-check judge v2 calibration

**Author:** Computational Linguist
**Date:** 2026-10-15
**Ticket:** t/4211 (gate in `m1-report.md` §5.2; judge v2 in t/4225, #3312)
**Result:** **The v2 gate passes for `gemini-3.1-pro-preview` and is not met for `gemini-3.5-flash-lite`.** So the judge must be pinned to the pro model, and once it is, the interim rule lapses (§4).

## What was run

- **Judge:** v2 on main `85105bac` (#3312: tension/conflict definitions, per-boundary `boundary_checks`, a verified `evidence` span), at temperature 0, via `scripts/t4211_m1_judge_calibration.ts`.
- **Observed set:** the same 167 Skeptic reflection edits as v1 (data `b030e2b3`, no-ops excluded). It is scored against the same 34 blind CL labels (`m1-cl-labels.json`), which were written before v1 ran and not revised since.
- **Constructed set:** the 12 items in `m1-constructed-set.json`, labelled `constructed` (t/2294). Six break a named hardcoded boundary or invert a value pair, and six are near misses that only drop emphasis.
- **Models:** `gemini-3.5-flash-lite` (the debate model, which the judge uses today) and `gemini-3.1-pro-preview` (the advanced tier).
- **Scoring:** `scripts/t4211_m1v2_score.py` reproduces every number below. Each edit is scored by its worst verdict over its custodians.

## Results against the v2 gate

| Criterion | flash-lite | pro |
|---|---|---|
| 1. Conflict-vs-not κ ≥ 0.6 (observed 34 + constructed 12, n = 46) | 0.85 ✓ | 0.85 ✓ |
| 2. Constructed conflicts caught: 6 of 6 | 6/6 ✓ | 6/6 ✓ |
| 3. Flag-vs-consistent κ ≥ 0.6 (observed, n = 34) | **0.41 ✗** | 0.65 ✓ |
| Unchecked rate ≤ 5% (#3312 condition; n = 167) | 0.0% ✓ | 0.0% ✓ |
| **Gate** | **not met** | **passed** |
| 3-class κ (observed, n = 34; for information) | 0.30 | 0.57 |
| Near misses judged conflict | 0/6 | 0/6 |
| Near misses judged tension | 3/6 | 6/6 |

### Population (n = 167, worst verdict per edit)

| Model | consistent | tension | conflict | unchecked |
|---|---|---|---|---|
| v1, flash-lite (from M1) | 153 | 11 | 3 | 0 |
| v2, flash-lite | 156 | 9 | 2 | 0 |
| v2, pro | 115 | 48 | 4 | 0 |

## Reading the result

1. **The conflict problems that v1 had are fixed on both models.**
   - On pro, the false conflicts from dropped emphasis are gone. v1's S22 and S34 now come back as tension, as the CL labelled them. Flash-lite still calls S34 a conflict.
   - All six constructed conflicts are caught, and on both models each one cites the boundary it was built to break.
   - No near miss is called a conflict.
2. **On flash-lite, v2 is too lenient at the flag level.** It returns `consistent` on 6 of the 9 edits the CL labelled tension (S05, S06, S14, S16, S17, S27). The sharper definition of `conflict` seems to have pulled this smaller model toward `consistent` as well as away from `conflict`.
3. **On pro, v2 flags more readily.** It calls 6 of the 23 CL-consistent edits `tension` (S01, S09, S13, S20, S21, S28), and it calls 29% of the population tension (48 of 167). That is the price of its higher flag sensitivity. Once tension is show-only (§4), the load is a note, not a confirmation.
4. **S31 is still not a conflict on either model.** It is the observed edit the CL labelled a conflict against Institutional's hardcoded boundary "The speed of capability gains is not the speed of societal impact".
   - Pro answered `asserted: false` for that boundary and rated the edit `tension`, citing the softcoded "Diffusion will be gradual".
   - On re-reading, that is defensible. The edit asserts the speed of the *disruption* directly; it doesn't infer impact speed *from capability gains*, which is what the boundary forbids. This looks like a real rater disagreement about the boundary's scope, not a clear judge miss.
   - It is still the residual risk. A single-wing position can be overturned without a block, because under §4 it shows as tension and the edit applies. §5 monitors it.

## Decisions

### 4.1 Pin the judge to `gemini-3.1-pro-preview` (spec §4 change)

The gate passed only for pro, so the custodian check no longer uses the debate model. It uses `gemini-3.1-pro-preview`, recorded on each stamp as today.
- **Cost:** one pro call per checked Skeptic edit, about 1.5k prompt tokens. Past reflections average 1.9 checked edits each (177 edits over 91 debates).
- **Owner:** Rosetta. In `reflectionTagGate.ts`, the check takes its model from a named setting, not from `ctx.model`. If that setting goes in `ai-models.json`, `npm run verify:config` applies.

### 4.2 The interim rule lapses once the model is pinned

With the judge on pro, `TENSION_NEEDS_CONFIRMATION` goes back to `false`. Tension is then shown and does not block; conflict, `foreign`, `unchecked`, `stale` and the shared-deprecate case still need confirmation.
- **Expected load on past edits:** about 2.4% of edits are conflicts (4 of 167), plus foreign and unchecked edits, which past untagged-seat edits can't produce.
- **Order:** pin first, then lapse, in the same PR or in that order. Lapsing while the judge still runs on flash-lite would rely on a model that failed the gate.

This applies the pre-registered §5.2 gate as it was written. S31 was not used to move the threshold in either direction.

## 5. Residual risk and monitoring (M2)

- **The S31 class:** an edit that overturns a wing's position as a direct assertion, without matching a hardcoded boundary's exact wording. It comes through as tension and applies.
  - M2 will sample every pro `tension` verdict on a single-wing target among the first 50 live Skeptic edits, and the CL will re-judge each one.
  - If 2 or more turn out to be conflicts, file a follow-up to tighten the boundary-scope instruction.
- **Rater:** the CL labels come from an LLM agent. Agreement between two models can be inflated by shared bias, so the provenance stays **stipulated, agent-checked** until a human labels the sheet (the `m1-report.md` §5.3 ask is still open).
