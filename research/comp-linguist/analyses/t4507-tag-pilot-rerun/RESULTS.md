# t/4507 results: POV-tag pilot re-run

**Computed:** 2026-10-27 by the Computational Linguist, using `analyze.ts`. The rules are those of `PREREG.md` and `AMENDMENT-1.md`, both written before any data. The raw output is `result.json`.

**Run:** all 50 of 50 debates completed. Spend was **$16.15 of the $25 PI cap**: 4 attempts failed and were retried, and the spend is booked in `ledger.json`. The code was frozen at `00aff3a6`, the model was gemini-3.5-flash-lite, and each debate ran a fixed 5 rounds.

## Verdicts

| Question | Rule | Result | Verdict |
|---|---|---|---|
| **Q1.** Are the Critical and Institutional wings distinct? | B > F on ≥ 7 of 10 motions | **7 of 10** | **DISTINCT** (exactly at the threshold) |
| **Q2.** Do the Scope and Prioritize modes produce distinct content? | M > F on ≥ 7 of 10 motions | **5 of 10** | **INCONCLUSIVE** |

- **The gates pass.**
  - All 10 motions are complete (underpowered would mean fewer than 8).
  - The median noise floor F is 0.185 (n = 10), well above the 0.01 void line, so the replicates are not degenerate (t/3587).
  - Every manipulation check passes (below).
- **The turn-count covariate (Amendment 1) is balanced.** Mean Skeptic statements per arm range from 1.5 to 1.7 (n = 10 per arm). That's a spread of 0.2, against a flag threshold of 1.0, so no arm is flagged as confounded.

## Manipulation checks

The share of injected Skeptic nodes carrying the seat's tag, read from the per-turn `injection_manifest.povNodeIds`:

| Arm | Seat | Injected | Tagged share | Criterion | Pass |
|---|---|---|---|---|---|
| A1 | Critical, Scope | 220 | 1.000 | ≥ 0.95 | yes |
| A2 | Critical, Prioritize | 214 | 0.981 | > 0.727 base rate | yes |
| A3 | Institutional, Scope | 214 | 1.000 | ≥ 0.95 | yes |
| A4 | Institutional, Prioritize | 210 | 0.971 | > 0.588 base rate | yes |
| A1r | Critical, Scope | 212 | 1.000 | ≥ 0.95 | yes |

The base rates come from `skeptic.json` (n = 381 nodes). The file was unchanged across the run window. The recorded `seat_tags` match the plan in all 50 debates.

## Per-motion distances (d = 1 − cos)

| Motion | F = d(A1, A1r) | B (wings) | M (modes) | Wings distinct | Modes distinct |
|---|---|---|---|---|---|
| m01 | 0.185 | 0.198 | 0.187 | yes | yes |
| m02 | 0.141 | 0.167 | 0.132 | yes | no |
| m03 | 0.281 | 0.166 | 0.159 | no | no |
| m04 | 0.200 | 0.177 | 0.142 | no | no |
| m05 | 0.116 | 0.139 | 0.118 | yes | yes |
| m06 | 0.189 | 0.256 | 0.223 | yes | yes |
| m07 | 0.132 | 0.215 | 0.295 | yes | yes |
| m08 | 0.122 | 0.218 | 0.194 | yes | yes |
| m09 | 0.210 | 0.162 | 0.150 | no | no |
| m10 | 0.124 | 0.205 | 0.119 | yes | no |

## How to read this

1. **Q1 is the first positive wing result.** The comparable t/3963 result was inconclusive, because its tag modes were a no-op. Here they are live, and the replicate floor is real.
   - **It is a threshold pass, not a margin.** One motion fewer would have made it inconclusive.
   - **F rests on one replicate pair per motion, for the Critical/Scope seat only.** That is the pre-registered limitation. On m03, m04 and m09, F alone exceeds B: the run-to-run noise on those motions is as large as the wing effect.
   - **Treat Q1 as supported, not established.** A second replicate pair, or a replicate on the Institutional seat, would be needed before a publication claim. Research claims are the PI's call.
2. **Q2 is inconclusive, probably because the two modes barely differ in their input** (exploratory, not pre-registered as a test).
   - At the current `TAG_BOOST_INCREMENT`, Prioritize injects 97–98% tagged nodes, against 100% for Scope.
   - The lift over the base rate is +0.254 for Critical and +0.384 for Institutional.
   - So Prioritize behaves almost like a soft Scope, and there is little selection difference left for the content to reflect.
   - The run doesn't tune the boost (PREREG: Secondary). The register entry for `TAG_BOOST_INCREMENT` stays **stipulated**, with this measured lift noted.
   - If the product wants the modes to differ, that is a parameter decision, and it needs a design with at least two boost values.
3. **The exploratory secondary measures are consistent with the selection.** The tagged share of cited Skeptic `taxonomy_refs` is 1.000 in the Scope arms and 0.966 (A2) and 0.975 (A4) in the Prioritize arms (cited n = 79–96 per arm).
4. **Crux overlap, A1 vs A3 (exploratory; `crux_overlap.ts`, `result-crux-overlap.json`): the wings do not change what the debate disagrees about.**
   - **Measure.** The symmetric mean best-match cosine between two debates' `crux_tracker` descriptions. It is compared per motion with the same A1-vs-A1r replicate floor. The operationalisation was fixed after RESULTS.md and before any crux was read.
   - **Result.** The wings' crux overlap fell below the floor on only **4 of 10** motions (n = 3–11 cruxes per debate).
     - Wing overlap ranged 0.31–0.50 and the floor 0.32–0.48, so the two ranges coincide.
     - The debate's crux set varies as much between replicates as between wings.
   - **Why this fits Q1.** Q1 measures the Skeptic's own content, while cruxes are debate-level: the Skeptic is involved in 174 of the 373 cruxes (47%). The wing changes what the Skeptic says, but not, detectably, which disagreements the debate is about.

## Out of scope, as pre-registered

Convergence and censoring metrics are out of scope: fixed-round debates record `termination_reason: unknown` by design. The labelling fix belongs to DebateTool (see PREREG).
