# Steelman-engagement: pre-fix baseline + metric pre-registration

**Owner:** Computational Linguist. **Context:** PI-requested revisit of the opening-statement
steelman-engagement hypothesis (p/548#237), worked jointly with TL (e/230, e/231).
**Date:** 2026-09-30. **Instrument:** `measure_steelman_engagement.py` (this dir).

## The hypothesis

A charitable restatement of an opponent's position, present in an opening statement, gives
later turns a shared referent and raises engagement quality. The PI observed, from one live
debate, "nothing connected to those statements."

## Why a measured baseline was needed

The observation "nothing connected" does not, on its own, discriminate the three explanations
(work incomplete / insufficient data / hypothesis wrong), because a wiring defect (t/3787)
misfiles steelman nodes so that "nothing connected" is the expected observation whether the
hypothesis is true or false. Rather than reason from one debate, this measures the actual
connection rate across the recent corpus.

## Method

- **Window:** 120 most-recent debates by mtime (`debates/debate-*.json`); 72 contain ≥1 steelman node.
- **Steelman node:** an `argument_network.nodes[]` entry with a truthy `steelman_of` (names the
  steelmanned camp); `speaker` is the author camp; `turn_number` orders turns.
- **Engagement (primary metric):** a *later-turn inbound edge* — an `argument_network.edges[]`
  entry with `target` = the steelman node and a `source` whose `turn_number` is strictly greater.
  This is the direct operationalisation of "a later turn connected to the steelman."
- **Decompositions:** edge `type` (supports/attacks); source camp relative to the steelman
  (steelmanned camp / author camp / third camp).

## Results (PRE-FIX — t/3787 misfiling bug live; this is the deliberate "before")

n = 129 steelman nodes across 72 debates.

| measure | value |
|---|---|
| later-turn inbound edges per steelman node | mean **0.51**, median 0, max 4 |
| connection rate (≥1 later inbound edge) | **40/129 = 31%** |
| distribution (edges→nodes) | {0: 89, 1: 20, 2: 15, 3: 4, 4: 1} |
| later inbound edge types | supports 29 / attacks 37 |
| source camp of later inbound edges | third camp **57**, author camp 6, steelmanned camp **3** |
| steelmanned-camp **adoption** rate of its own steelman | **3/66 = 5%** |

## Interpretation

1. **Confounded, not severed.** The circuit is not dead: 31% of steelmans draw a later-turn edge.
   The PI's "nothing connected" was one debate's draw, not the corpus norm. So "work incomplete"
   (t/3787) is the leading explanation, but its effect is *distortion*, not *total severance*.
2. **The specific distortion.** Engagement is overwhelmingly by the **third camp** (57/66), almost
   never by the **steelmanned camp adopting its own charitably-stated position** (3/66 = 5%). That
   5% is the deficit the hypothesis is really about — the "shared referent for your own side" uptake.
   Under the t/3787 bug the steelman is surfaced to the steelmanned camp as an *opponent claim to
   attack* (author-camp keyed), which is exactly why adoption is near-zero.
3. **The `supports 29 / attacks 37` split** is consistent with steelmans being treated as ordinary
   opponent claims (attacked more than built upon), not as shared referents.

## Pre-registration (for the post-t/3787 re-run)

- **Primary metric:** later-turn inbound-edge **connection rate** into steelman nodes.
  Baseline = **31%** (95% CI ≈ 23–40%, n=129, Wilson). Report with n (statistic-provenance, t/3587).
- **Key secondary (the hypothesis's real target):** **steelmanned-camp adoption rate** — fraction of
  later inbound edges (or of steelman nodes) where the *steelmanned* camp engages its own steelman.
  Baseline = **5%** (3/66). This is the number t/3787 should move most.
- **Supporting (debate-level, confounded — exploratory only):** `crux_addressed_ratio` (neutral-
  evaluator LLM output, not AN-derived), compared steelman-present vs -absent. NOT confirmatory.
- **Do NOT use `qbaf_agreement_density`** as a steelman metric: it keys on `sourceNode.speaker` and
  miscounts steelman edges' cross-POV status (camp-misclassified pre-fix). Metric-integrity follow-up
  filed separately.
- **Non-degenerate guard (t/3587):** the adoption metric must distinguish "raters/camps constant"
  from "engaged" — a 0% and a 100% both need the n and the per-camp decomposition, not a bare rate.
- **Sample size:** the "does it connect at all" question is already answered (31% ≠ 0). The live
  question is whether t/3787 *raises the adoption rate* from 5%. Detecting 5% → ~25% at 80% power,
  α=.05 (two-proportion) needs ≈ 55 steelman nodes per arm ≈ **35–45 post-fix debates**. Stage it:
  a **10-debate pilot** to confirm direction + re-estimate variance, then scale to the powered n.
  Read as a distribution across debates, never a single draw (replication-gate R-1 spirit).

## Pre-registered abandonment rule (what would count AGAINST the hypothesis)

Stated **before** the data, per TL (e/230#3). Rationale: today produced four real fixes to this
feature (t/3781, t/3786, t/3787, t/3755), so when the data disappoints the path of least resistance
is to hunt a fifth wiring bug rather than accept disconfirmation. A stopping rule written now is
cheap; written after the data, it isn't credible.

- **Wiring-correct precondition — now THREE surfaces, not one (TL p/349, re t/3791/t/3792).** The
  abandonment reading is valid ONLY if the mechanism is demonstrably correct across every surface that
  camps a steelman:
  - **Turn-context presentation (t/3787):** the helper applied at every enumerated site (derived from
    code, not the count of six — the corrected predicate found `crossRespond.ts:509`, unnamed by either
    analysis), AND the structural positive control passes. Control = **P1∧P2∧P3** (t/3790#3): P1 the
    steelman lands in the current speaker's own-position grouping; P2 its entry renders *differently*
    from a plain claim (a diff, not a phrase — rewording-robust); P3 both camp identifiers appear in
    the entry. None satisfiable by routing alone; none an exact-string assertion (avoids green-by-erosion).
  - **Belief-state camp (t/3791) and utility-scoring camp (t/3792):** both `beliefTracking.ts:116` and
    `agentUtility.ts:48,54` still miscamp the steelmanned camp's own steelman as an opponent. Neither
    feeds the instrument (verified — they write belief-state / a utility score, not the AN nodes/edges
    the metric reads), so **measurement is clean without them**. But both shape debater *behavior*,
    biasing the steelmanned camp *away* from its own steelman → biasing measured adoption **downward**.
  - **So the abandonment branch is gated on all three (t/3787 ∧ t/3791 ∧ t/3792); the confirm branch is
    gated on t/3787 only** (see the asymmetry below). Without all three, a null is ambiguous — it could
    be residual belief/utility suppression masking a real effect, not a false hypothesis — and THEN
    looking for the remaining defect is legitimate, not defect-hunting.
- **Abandonment condition.** With **all three surfaces correct** (t/3787 ∧ t/3791 ∧ t/3792, per the
  precondition above), if the **pilot (10–15 debates)** shows the steelmanned-camp adoption rate
  **statistically indistinguishable from the ~3–5% pre-fix baseline** (CI overlapping baseline, no
  upward shift), that is **evidence against** the hypothesis — steelmans do not drive own-camp uptake
  even when correctly presented AND correctly camped in belief/utility. Report the null; do NOT
  escalate to a further wiring hunt. (If t/3791/t/3792 are still open, this branch is unavailable —
  see the precondition; a null there routes to "ambiguous", not "abandon".)
- **Continue-to-confirm condition.** If the pilot shows a clear upward shift (adoption materially
  above baseline, CI excluding ~5%), proceed to the ~50-debate confirmatory arm. **The confirm branch
  is SAFE to run before t/3791/t/3792 land** — belief/utility suppression only biases adoption down,
  so a positive result under it is *stronger*, not weaker.
  - **Effect size is a FLOOR, not an estimate, while t/3791/t/3792 are open (TL p/349#458).** A positive
    pilot effect measured under active downward suppression is a **lower bound** on the fully-wired
    effect. Do NOT re-estimate the confirmatory-arm n from it as if it were the true effect — that
    *over-powers* the arm (larger effect ⇒ smaller n needed; the floor understates the effect ⇒
    overstates the n). Record the pilot effect **as a floor**; re-estimate n after t/3791/t/3792 land,
    or accept the over-powered (conservative, wasteful-not-wrong) n.
- **Ambiguous (underpowered) condition.** If the pilot is directionally positive but CI-wide, that is
  "insufficient data" (explanation 2), not support — proceed to the confirmatory arm; do not conclude
  from the pilot either way. **But weight the direction: under known downward suppression (t/3791/t/3792
  open), a *marginal* positive leans toward continue more than the bare CI implies** — the true effect
  is likely larger than measured. A marginal positive is a reason to continue (and re-check once the
  suppression is removed), never to abandon.
- **Non-degenerate guard (t/3587).** Report adoption with its n and the per-camp decomposition; a flat
  ~3% and a jump to ~30% are distinguished by the decomposition, not a bare rate.

## Caveats

- Edges are LLM-extracted (argument-network extraction); edge recall is imperfect and is itself a
  shared source of noise across pre/post — acceptable for a within-instrument pre/post comparison.
- mtime-recency window, not a random sample; fine for a baseline, note it if generalising.
- Measured under the t/3787 bug by design — this is the "before", not a hypothesis test.

## Provenance-register note

When the connection-rate / adoption-rate metric is implemented in code (not just this analysis
script), add it to `research/comp-linguist/docs/metric-provenance-register.md` as **derived**
(empirical, AN-edge-based; baseline values above), in the same PR — per the maintenance rule.

---

# PILOT RESULTS (post-data — 2026-10-01, t/3790)

Everything above this line is the pre-registration, fixed before the data. This section is the result.
Instrument: `measure_pilot_vs_matched_baseline.py` (this dir).

## Design as run

- **10 post-fix debates** (`ai-triad-data/debates/t3790-pilot/`, slugs t3790p01–p10), generated via the
  headless runner on **gemini-3.5-flash-lite / structured / moderate / policymakers / 3-POV**.
- **All three wiring surfaces live** for the run: t/3787 turn-context (#2604), t/3791 belief + t/3792
  utility (#2606), t/3795 own-camp gift section (#2613). So this is a **fully-wired** pilot — the
  pre-registered abandonment branch was *available* (its precondition was met), and the effect-as-floor
  caveat does NOT apply (no open suppression).
- **Positive control P1∧P2∧P3 passed** on the merged code before the run (t/3790#3/#5).
- **Control = config-matched baseline subset**, not the heterogeneous full 120: the 120-corpus filtered
  to the identical cell → 36 debates, 34 steelman nodes. (Matched-subset adoption baseline = 4%,
  consistent with the 3/66≈5% full-corpus figure — the filter did not distort the baseline.)

## Numbers

| axis | matched baseline (pre-fix) | pilot (post-fix) |
|---|---|---|
| steelman nodes (n) | 34 | 10 |
| connection rate (≥1 later inbound) | 15/34 = 44% [95% 29–61] | 4/10 = 40% [95% 17–69] |
| adoption (steelmanned-camp share of later inbound) | 1/26 = 4% [95% 1–19] | 2/6 = 33% [95% 10–70] |
| later-inbound source camp | steelmanned 1 / third 23 / author 2 | steelmanned 2 / third 4 / author 0 |
| edges / debate | 0.72 | 0.60 |

## Reading (against the pre-registered branches)

1. **Connection rate: flat** (44%→40%, CIs fully overlap). Expected — "confounded, not severed";
   total connection was never the fix's target.
2. **Adoption: directionally positive in the predicted direction** (4%→33%, ~8×), with the mechanism
   signature — third-camp share of engagement fell 88%→67% while steelmanned-camp share rose 4%→33%.
   The fix *reallocates* engagement toward the steelmanned camp, which is what t/3787+t/3795 built.
3. **Confound-bound check (ruling #6): PASS** — edges/debate comparable (0.72 vs 0.60), so the adoption
   *share* shift is not an opportunity-drift artifact.
4. **Underpowered — this is the "continue-to-confirm / ambiguous" branch, NOT confirmation.** Adoption
   rests on **2 of 6** later-inbound edges across 10 nodes; the 33% CI [10–70%] is enormous and only
   just clears the baseline upper bound. Two events cannot confirm (statistic-provenance, t/3587).

## Decision

**CONTINUE-TO-CONFIRM → run the ~50-debate confirmatory arm.** The pilot confirmed direction,
demonstrated the mechanism end-to-end in live debates (beyond the unit positive control), and showed
no sign of the null that would trigger abandonment. Do NOT re-estimate the confirmatory n downward off
the 33% point estimate (2 events over-powers); the pre-registered ~50 (3%→20% @ 80% power) stands.

**Answers the PI's original 3-way question (e/230):** not "hypothesis wrong," not merely "insufficient
data" — it was **"work incomplete" (now fixed), and the fixed mechanism shows the predicted adoption
effect directionally.** The confirmatory arm settles magnitude.

---

# CONFIRMATORY ARM PRE-REGISTRATION (pre-data, 2026-10-01, t/3790)

Fixed before the confirmatory data exists, and before the run is even funded — the strongest timing,
no post-hoc latitude. Everything above is the pilot's pre-registration + result; this section governs
the ~50-debate confirmatory arm the pilot's continue-to-confirm branch triggered.

## Frozen cell (identical to the pilot = the matched-baseline-subset filter)

`debate_model = gemini-3.5-flash-lite`, `protocol_id = structured`, `adaptive_staging.pacing = moderate`,
`audience = policymakers`, `active_povers = [accelerationist, safetyist, skeptic]` (3-POV). Plus the
pinned build identity verified homogeneous in the pilot: `app_version` / `generated_with_prompt_version`
/ moderator `mode`. **These are asserted per-debate at generation and the arm ABORTS on any mismatch**
(TL precondition #2) — a mid-arm version/prompt landing silently splits the sample otherwise, and a
split sample is invisible in the analysis. The pilot was homogeneous by luck (two execution windows two
hours apart); the confirmatory arm is homogeneous by construction.

## Primary readout — PER-STEELMAN-NODE binary adoption (higher-power; this is what ~50 sizes)

For each steelman node, a binary: **does it receive ≥1 later-turn inbound edge whose source is a node of
its OWN steelmanned camp** (`steelman_of`)? n = number of steelman nodes (~50 at a 50-debate arm, ~1
node/debate in the pilot). This is the metric the pre-registered power calc actually sizes:

- Power basis: detect **3% → 20%** at 80% power, α=.05, two-proportion ≈ **55 steelman nodes per arm**.
  ~50 confirmatory debates ≈ ~50 nodes; the matched baseline subset supplies the control arm (34 nodes
  today, grows as the corpus does). ~50 **stands** — do NOT re-power off the pilot's 33% point estimate
  (it rests on 2 events; re-powering off observed noise is how a pre-registration becomes overpowered-
  for-noise). TL concurs (t/3790#16).

**Correction this fixes:** the pilot *reported* the edge-SHARE (2/6), but ~50 was sized at the node level.
The per-node binary is the n-consistent primary. Baseline per-node adoption must be recomputed on the
matched subset the same way (the instrument tracks per-node later-inbound counts already; extend to
per-node steelmanned-camp-inbound — CL owns that instrument change, additive, same file).

## Secondary readouts (reported with n; not the power-sized primary)

- **Edge-share adoption** (pilot 2/6): steelmanned-camp share of all later-inbound edges. Thinner
  (denominator ≈ later-inbound edges, ~30 at n=50); the pilot's headline, kept for continuity.
- **Connection rate** (pilot 40% vs 44%): ≥1 later-inbound edge from ANY camp. Expected flat — not the
  fix's target; a large move here would be a flag to investigate, not a win.
- **Mechanism signature**: the third-camp vs steelmanned-camp split of later-inbound edges (pilot showed
  third 88%→67%, steelmanned 4%→33% — the reallocation). Qualitative corroboration.

## Control

The **config-matched baseline subset** — the pre-fix corpus filtered to the frozen cell, measured by the
SAME instrument (`measure_pilot_vs_matched_baseline.py`). Not the heterogeneous full corpus; not a new
measurement path. Confound-bound check (ruling #6) re-run: compare later-inbound edges/debate across arms;
material divergence → the opportunity confound isn't bounded → escalate to the concurrent fix-off control
(ruling #7).

## Decision branches (unchanged from the pilot pre-registration above — restated for the confirmatory n)

All three wiring surfaces are now live (#2604 turn-context, #2606 belief/utility, #2613 own-camp gift),
so the **abandon branch is available** and the effect-as-floor caveat does NOT apply.

- **CONFIRM** (hypothesis supported): per-node adoption CI **excludes the matched-baseline rate** (upward).
- **ABANDON** (evidence against): per-node adoption **statistically indistinguishable from baseline**,
  with the positive control (P1∧P2∧P3) passing on the arm's build. Report the null; do NOT hunt a further
  wiring defect (the surviving-vector reflex). The positive control is the precondition that makes a null
  interpretable.
- **AMBIGUOUS** (underpowered): directionally positive, CI-wide → insufficient data, not support; report
  as such. (Should not occur at n=50 for a 3%→20% effect, but holds if the realized node yield undershoots.)
- **Non-degenerate guard (t/3587):** every rate carries its n and the per-camp decomposition.

## Run-gates (TL's four preconditions, t/3790#16 — must hold before and during the arm)

1. Run-scoped output dir `t3790-confirm-<run-id>/`, idempotent skip of any complete set (never rewrite).
2. Per-debate config pin asserted against the frozen cell; **abort on mismatch**.
3. Foreground sequential only (~6.1 min/debate measured, ~40% headroom under the 10-min cap; no background).
4. Commit + push incrementally (~every 10 debates); resolve the `calibration/` ignore disposition first
   (t/3790#15/#17). **Commit the analysis-faithful calibration copy** — note the pilot's live calibration
   log diverged from its backup via concurrent re-runs (t/3790#18); the backup is the snapshot the numbers
   were read against.

## Not a Second Opinion trigger

Pre-registered confirmatory arm on an existing design; no blocking-gate promotion, no schema/data-model
change; reversible; ~5 hours of model time is not a cost/risk asymmetry. TL recorded the same (t/3790#16).
The only open gate is the PI funding the ~5 hours.

---

# CONFIRMATORY ARM RESULT (2026-10-20, t/3802): NOT INTERPRETABLE, the cell was not matched

Everything above is fixed pre-data. This section is the result. Instrument: `measure_confirmatory_arm.py`
(imports `measure()` from `measure_pilot_vs_matched_baseline.py`; the only instrument change is the
additive per-node binary the pre-registration assigned to the CL).

## What ran

- 50 debates, `debates/t3790-confirm-20261020/` (data `d6a7d051`), code frozen at `7ffb7c3f`, the pilot's
  10 topics × 5. PI-approved batch (t/3802#6). The positive control (`steelman.test.ts`,
  `opening.priorSteelmans.test.ts`, `agentUtility.test.ts`, `beliefTracking.test.ts`) passes on that build:
  4 files, 41 tests.
- **Control:** the pre-fix corpus (`created_at` < t/3795 merge `67953c6d`, 2026-09-30T20:32:08Z) filtered
  to the cell gives 36 debates and 34 nodes. That reproduces the pilot's matched baseline exactly. The pilot
  script's "120 most recent by mtime" window is not reused: it now pulls in post-fix production debates
  (it reads n = 40, 5/31 today).

## The defect: pacing was never applied, in the arm OR the pilot

`lib/debate/cli.ts` applies `pacing` only when `useAdaptiveStaging: true` is set. The pilot's run
recipe (`t3790-pilot-resume.mjs`), which this arm copied, sets `pacing: 'moderate'` and not
`useAdaptiveStaging`. So **all 10 pilot debates and all 50 arm debates ran fixed rounds (`rounds` default
3): exactly 6 debater turns each**, with no `adaptive_staging` block recorded. The control cell is
`adaptive_staging.pacing = moderate`, a mean of 11.4 debater turns. The cell's pacing dimension was
**not matched**, and the "Design as run" line above saying it was is wrong. The run-gate 2 pin check
didn't catch it because the debate record doesn't carry pacing. (The runner now refuses this config
before spending; see `paid_batch_runner.py`.)

## Numbers (reported, not interpreted)

| axis | control (pre-fix, cell) | arm (6-turn, no staging) |
|---|---|---|
| steelman nodes | 34 (36 debates) | 46 (50 debates) |
| **primary: per-node adoption** | 1/34 = 2.9% [0.5–14.9] | 2/46 = 4.3% [1.2–14.5] |
| edge-share adoption | 1/26 = 4% | 2/7 = 29% |
| connection rate | 15/34 = 44% [29–61] | 7/46 = 15% [8–28] |
| **confound bound: later-inbound edges / debate** | 26/36 = 0.72 | 7/50 = 0.14 |
| total edges / debate | 23.7 | 11.3 |

## Reading (against the pre-registered branches)

- **Confound-bound check (ruling #6): FAIL.** Later-inbound opportunity is about a fifth of the control's.
  A steelman in a 6-turn debate has almost no later turns to be adopted in. The pre-registration says
  material divergence means "the opportunity confound isn't bounded → escalate to the concurrent fix-off
  control (ruling #7)".
- **Therefore neither CONFIRM nor ABANDON is available.** The CI doesn't exclude the control (Fisher
  one-sided p = 0.61), but a null measured with a fifth of the opportunity isn't the interpretable null
  the abandonment branch requires. Reading it as "abandon" would be the error the pre-registration's
  confound gate exists to prevent.
- **Arm-run-gate 2 (abort on cell mismatch) should have fired and didn't.** By the pre-registration's own
  rule this arm isn't the confirmatory arm: it is a 50-debate sample of a *different cell*
  (fixed-3-round), kept as data and labelled as such.
- **The pilot inherits the same defect.** Its directional read (4%→33% edge share) compared 6-turn
  debates against an ~11-turn control. Its confound check passed on its own numbers (0.60 vs 0.72), so
  it isn't retracted, but its "matched cell" claim is.

## What would answer the question

A re-run of the arm with `useAdaptiveStaging: true, pacing: 'moderate'`, verified on the first debate
against the control's turn count and `adaptive_staging.pacing` *before* the batch continues. Adaptive
debates are roughly twice as long, so expect about $0.40 per debate, about $20 for 50. That's new spend
for the PI. Alternatively, a fixed-3-round *control* would need a pre-fix corpus of 6-turn debates,
which doesn't exist in sufficient number (5 or fewer pre-fix in-cell non-staged debates).

---

# CONFIRMATORY ARM 2 RESULT (2026-10-21, t/3802): CONFIRM, by the pre-registered rule

This is the adaptive re-run that "What would answer the question" called for. It was approved at t/3802#9, with the $30 stop at #19 and the 50-completed count at #22.
- **Instrument:** `measure_confirmatory_arm2.py`. It uses the same `measure()` as the pilot and arm 1; only the arm directory changes, and the arm is filtered by `matches_cell()` like the control.
- **Data:** `debates/t3790-confirm2-adaptive-20261020/`, 50 completed debates. Code is frozen at `7ffb7c3f`.
- **Spend:** $28.97 of $30. That counts 4 failed attempts at the $0.80 reserve: a03, a11 and a15 were killed by the low-memory reaper, and a32 hit a JSON-parse FATAL and was retried.

## Cell match: passes this time
- **All 50 arm debates match the frozen cell** (0 off-cell), including `adaptive_staging.pacing = moderate`.
- **Debater turns:** the arm averages 14.3 per debate (range 13–16), against 11.4 for the control (range 0–15, n = 36). The arm runs somewhat longer. See the confound check below for why that doesn't favour the arm.

## Numbers

| axis | control (pre-fix, cell) | arm 2 (adaptive moderate) |
|---|---|---|
| steelman nodes | 34 (36 debates) | 40 (50 debates) |
| **primary: per-node adoption** | 1/34 = 2.9% [0.5–14.9] | **8/40 = 20.0% [10.5–34.8]** |
| edge-share adoption | 1/26 = 4% | 9/22 = 41% |
| connection rate | 15/34 = 44% [29–61] | 16/40 = 40% [26–55] |
| later-inbound camp split (steelmanned / third / author) | 1 / 23 / 2 | 9 / 9 / 4 |
| **confound bound: later-inbound edges / debate** | 26/36 = 0.72 | 22/50 = 0.44 |
| total edges / debate | 23.7 | 28.8 |

The CIs are 95% Wilson. Two-proportion z = 2.24, and Fisher's exact test (one-sided) gives p = 0.026.

## Reading (against the pre-registered branches)
- **The confound-bound check (ruling #6) passes, in the conservative direction.** The arm has *less* later-inbound opportunity than the control (0.44 against 0.72 per debate). Less opportunity can't manufacture adoption, so the opportunity confound is bounded, and the concurrent fix-off control (ruling #7) isn't triggered.
- **CONFIRM.** The arm's lower bound (10.5%) excludes the control rate (2.9%), upward. That is the pre-registered CONFIRM condition. It's also the 3%→20% effect the arm was powered for, and the point estimate lands on it.
- **The mechanism signature reproduces.** The steelmanned camp's share of later-inbound edges goes from 4% to 41%, while the third camp's share falls from 88% to 41%. Connection rate is flat (44% to 40%), as pre-registered: the fix reallocates *who* engages, not *whether* anyone does.

## Statistic provenance and limits (t/3587)
- **The control rests on 1 event in 34 nodes, and the arm on 8 events in 40.**
  - **The CI rule holds for a control of up to 3 events** (8.8%) and fails at 4 (11.8%).
  - **The Fisher test is more fragile:** p = 0.026 with 1 control event, 0.074 with 2, and 0.15 with 3.
  - So the decision is CONFIRM by the rule fixed before the data. It is **not** a robust significance result, and it should be cited with both counts.
- **The nodes fall short of the power target:** 40 arm nodes against the ~55 the power calculation sized. 50 debates gave 0.80 steelman nodes per debate, against the control's 0.94. The CONFIRM branch was reached anyway; AMBIGUOUS would have applied had it not been.
- **The control is historical, not concurrent.** It is pre-fix debates from before 2026-09-30, so other code changes since then are confounded with the fix. The confound-bound check is the pre-registered guard on that, and it passed. It bounds *opportunity*, not every difference between the two code versions.
- **Scope, unchanged from the pre-registration:** this confirms the **adoption mechanism**, that a camp takes up its own charitably restated position. It does **not** show that adoption improves debate quality, which is a separate measurement.
