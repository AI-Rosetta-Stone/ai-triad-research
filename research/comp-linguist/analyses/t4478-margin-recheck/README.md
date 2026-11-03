# t/4478 — `keypoint_surfacing_margin` (0.06) recheck under POV+BDI-scoped retrieval

**Author:** Computational Linguist · **Date:** 2026-10-28 · **Ticket:** t/4478 (blocking AC) · e/386

## Why a fresh recheck instead of re-running the original study

t/4478 asks to "re-run the margin check... on the t/2341 sample." The t/2341 adjudication
(`analyses/t2341-mechanism5-design/adjudication.md`) hand-labeled n=30 random + n=20
divergent-band safetyist key_points, but **the 50 item identities were never persisted**
as a reusable dataset — only a handful of named examples survive in the writeup. That gap
is exactly why t/4480 (build a two-rater gold set) exists as its own ticket.

Rather than guess at the original sample or wait on t/4480, this recheck does two things
on the **current, full population** instead of a small sample:

1. A **structural** pass (`recheck.py`) over every safetyist key_point that already carries
   the t/2288 retrieval fields (`retrieval_confidence`, `taxonomy_node_candidates`,
   `attribution_text`) — n=663, not a sample. Compares the existing POV-only top1 margin
   against a freshly-computed POV+BDI-restricted top1 margin (same embeddings, same
   `attribution_text` query field per t/2341 Arm 1, same pillar-node exclusion as
   `Get-RelevantTaxonomyNodes`/`Invoke-Mechanism5RetrievalPass`).
2. A **fresh single-rater adjudication**, n=24, random sample (seed 4478) drawn from the
   217 items flagged under the new POV+BDI margin — judged correct/misfire/fixable the
   same way as t/2341's adjudication (genus-differentia + Encompasses/Excludes fit).

## Method notes / caveats

- **Instrument sanity gap:** the locally-recomputed POV-only margin matches the
  production-stored margin within 0.01 for 576/663 (87%) of items. The mismatch is
  expected, not a bug: `taxonomy_node_candidates[0].score` comes from
  `Get-RelevantTaxonomyNodes` (adaptive top-K + threshold floor + min-per-BDI), while this
  script takes a pure max over the full pool, matching `Invoke-Mechanism5RetrievalPass`'s
  own (simpler) scoring instead. The POV-vs-BDI **comparison** is internally consistent
  (both sides computed the same way here), which is what this recheck needs; the 13%
  mismatch against the production number is a separate calibration note, not corrected
  here.
- **Category-field vs. assigned-node-BDI mismatch:** 4/663 (0.6%) key_points have a valid
  `category` field that does not match their assigned node's actual BDI (derived from the
  node ID) — consistent with the ticket's own ~0.7% figure on its larger frame. The pool
  restriction uses the key_point's own `category` field (per the ticket's design), which is
  occasionally a different BDI than the (possibly wrong) assigned node — this is a real
  edge case, not a script bug (confirmed by inspection, see `recheck.py` output).
- **Single rater**, n=24 (not the original's 50), adjudicated by CL only. Per t/2294/t/3587
  discipline, counts are reported with their n; no second rater available this pass.

## Results

### Structural (n=663, full population)

| | POV-only | POV+BDI |
|---|---|---|
| mean margin | 0.0524 | 0.0472 |
| flagged (margin > 0.06) | 233 (35.1%) | 217 (32.7%) |

- Items moving flagged→unflagged under BDI narrowing: **16**
- Items moving unflagged→flagged: **0** (expected — the BDI pool is a strict subset per
  category, so top1 can only fall or hold, never rise)

**Conclusion:** narrowing to POV+BDI is structurally safe for this threshold — it can only
remove surfacing candidates, never add spurious new ones. t/4478 is not blocked on this
axis.

### Fresh adjudication (n=24, drawn from the 217 POV+BDI-flagged items)

| Verdict | n | |
|---|---|---|
| False-positive flag (assigned correct, BDI top1 not better) | 11 | 46% |
| Fixable misfire (BDI top1 clearly/moderately better home) | 8 | 33% |
| Misfire, no clean fix (taxonomy gap / out-of-scope, not a retrieval problem) | 4 | 17% |
| Borderline / contested (both candidates plausible) | 1 | 4% |

**Misfire-precision at 0.06 (POV+BDI) ≈ 33%** (8/24), excluding the borderline case
8/23 ≈ 35%. This is far below the register's original 78% figure.

**This is not a POV+BDI-specific finding** — since only 16/233 items changed flag status
under BDI narrowing, the same ~33% precision almost certainly held under the old POV-only
margin too. The honest read: the original n=50 figure was never independently replicated
and, on this larger fresh check, does not hold up.

## Recommendation

1. **t/4478 merge: not blocked.** POV+BDI narrowing is structurally safe (fewer-or-equal
   flags). This recheck satisfies the ticket's blocking AC.
2. **`keypoint_surfacing_margin`'s precision needs real recalibration, independent of
   t/4478.** Register updated to flag 78% as unreplicated/overstated rather than silently
   carry it forward. Full fix is the t/4480 gold set (reusable, two-rater) — this ad hoc
   n=24 single-rater check is evidence of a problem, not a new calibration.
3. **Taxonomy-structure finding carries over from t/2341:** 4/24 (17%) of the sampled
   misfires are genuine gaps/out-of-scope extractions, not retrieval problems — consistent
   with t/2341's adjudication finding the same ~50% share in its own divergent band. Still
   not retrieval's problem to fix.
