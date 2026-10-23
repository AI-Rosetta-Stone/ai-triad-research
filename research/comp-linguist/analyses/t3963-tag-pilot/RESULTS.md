# t/3963 POV-tag pilot: results (2026-10-22)

**Data:** stage 1 (m01 × A0–A5, 6 debates) and stage 2 (m02–m10 × A0–A5, 53 of 54 debates), in
`ai-triad-data/debates/t3963-tag-pilot-stage{1,2}` (data commit `397f4e6c`).
- **Code:** frozen at `7ffb7c3f`, model `gemini-3.5-flash-lite`, fixed 3 rounds (6 debater turns, 2 Skeptic turns per debate).
- **Spend:** stage 2 $10.69 of the $12.50 hard stop (approval t/3963#11), plus stage 1's $1.50.
- **Not run:** `m10-a5`. A5 isn't an input to the primary outcome, so all 10 motions have A1–A4.

## Primary outcome: INCONCLUSIVE (4 of 10 motions distinct)

The pre-registered rule (t/3963#3, operationalised in #7 before the data): distinct on ≥ 7, not distinct
on ≤ 3, inconclusive in between. The non-degenerate guard passes: the median within-wing distance is 0.203, against a void line of 0.01.

| motion | between | within | distinct |
|---|---|---|---|
| m01 | 0.217 | 0.173 | yes |
| m02 | 0.180 | 0.190 | no |
| m03 | 0.215 | 0.217 | no |
| m04 | 0.213 | 0.183 | yes |
| m05 | 0.139 | 0.164 | no |
| m06 | 0.211 | 0.203 | yes |
| m07 | 0.295 | 0.301 | no |
| m08 | 0.191 | 0.225 | no |
| m09 | 0.225 | 0.207 | yes |
| m10 | 0.158 | 0.163 | no |

Per-pair distances are in `result-primary.json`, produced by `primary_wing_distinctness.ts`. Most margins are under
0.03 either way: between-wing and within-wing distances are the same size.

### A correction to what the contrast measures (found in analysis, t/4438)

**In debates, the tag mode is a no-op.** Per-turn taxonomy selection (`getRelevantTaxonomyContext`)
never reads `seat_tags`. The only thing a tag does in a debate is swap the Skeptic soul. So:
- **A1 ≡ A2 and A3 ≡ A4** in treatment: the same soul and the same selection. The within-wing pairs are
  **replicates**, so the within-wing floor is pure run-to-run noise, not the selection-mode contrast #7
  described. #7's "conservative floor" remark doesn't apply. The floor is a plain replicate-noise floor, which is
  the right floor for this question.
- **Between-wing (A1 vs A3, A2 vs A4) is a soul-only contrast**, not the voice-plus-node-pool "package"
  t/3963#4 assumed.

**Reading:** at 2 Skeptic turns per debate, swapping the Critical and Institutional Skeptic souls doesn't
move Skeptic content reliably beyond the run-to-run noise. Two things this doesn't show:
- whether the wings differ once tag selection actually runs in debates (t/4438);
- whether they differ in longer debates.

## Supporting measures (EXPLORATORY: operationalised after the data)

`supporting_measures.ts` → `result-supporting.json`. #3 named these measures without defining them, so
every choice here is post-data and descriptive only.

- **Crux overlap, A1 vs A3:** a soft Jaccard over the neutral-evaluation crux descriptions, matched by MiniLM
  cosine at τ ∈ {0.75, 0.80, 0.85}. The median is **0 for the between-wing pair and for both within-wing pairs**, at every τ.
  Each debate words its cruxes in its own way, so the measure sits at its floor. **Degenerate (t/3587): uninformative.**
- **Tagged share of Skeptic nodes, median per arm.** Corpus base rates: critical 0.735, institutional 0.594.
  - **Injected** (the union of `transcript[].metadata.injection_manifest.povNodeIds` per debate; added 2026-10-23):
    - critical share: A0 0.80, A1 0.74, A2 0.74;
    - institutional share: A0 0.46, A3 0.61, A4 0.50.
    - A working Scope filter would give 1.0 for A1 and A3. This is the direct evidence for t/4438.
  - **Cited** (from the Skeptic turns' `taxonomy_refs`):
    - critical share: A0 0.94, A1 0.79, A2 0.92;
    - institutional share: A0 0.50, A3 0.56, A4 0.55.
  - Neither measure shows a Scope restriction or a Prioritize lift.
  - *Correction:* the first version of this file said injected ids aren't recorded. They are (t/4438#5).
- **Boost check (`TAG_BOOST_INCREMENT`):** **not measurable.** The boost never runs in debates. The register entry stays
  **stipulated**, with a note.

## Secondary metrics: not reportable

| metric | reading |
|---|---|
| `termination_reason` | `unknown` in all 59 rows. Under the censoring gate (t/1671) the convergence headline is untrustworthy, so it isn't interpreted. |
| `repetition_rate` | 0 in every debate: degenerate. |
| `crux_addressed_ratio` | Median 1.0 in 5 arms and 0.5 in A2. It's at its ceiling on about 2 cruxes per checkpoint, so it isn't read as a difference. |

These were flagged in advance (#5, #6): 6 debater turns is a thin base for these metrics.

## What would answer the t/3932 question

1. **t/4438:** make seat tags drive per-turn debate selection. Injected ids are already recorded per turn.
2. **A re-run** at adaptive or longer pacing, so there are more than 2 Skeptic turns. Within-wing pairs could stay true
   replicates, which gives a clean noise floor. **That's a new PI spend ask; nothing here authorises it.**
