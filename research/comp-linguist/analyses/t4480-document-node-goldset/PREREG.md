# t/4480 PREREG: two-rater document key_point → taxonomy node gold set

**Author:** Computational Linguist · **Date:** 2026-10-28 · **Ticket:** t/4480 (parent t/4467) · **Spend:** none (local all-MiniLM-L6-v2)

Written before any item is sampled or labelled, per the ticket's acceptance criteria and t/2294 discipline. Decisions below are findings from a population scan, not guesses — the scan's data is in `population.json`.

## Question

Every document-mapping accuracy figure the project uses today rests on t/2341's adjudication: n=30, one rater, safetyist only. How accurate is the current key_point → taxonomy-node assignment, broken out by POV, BDI category and retrieval-rank band — with a real inter-rater agreement figure?

## Population and sampling frame (finding, not assumption)

The ticket's design calls for stratifying by POV × BDI × "assigned-node retrieval rank band". Two findings from the scan shape the frame:

1. **Only key_points with `attribution_text` can be rank-scored the way production does it.** `Invoke-RetrievalConfidencePass.ps1` computes `retrieval_confidence` and `taxonomy_node_candidates` by embedding a key_point's `attribution_text` and ranking cosine similarity against **every non-pillar node across all four POV files** (not POV-filtered, not BDI-filtered) — see the function's scoring loop. Of 13,826 key_points corpus-wide, 2,104 have no `taxonomy_node_id` and 8,166 have no `attribution_text`, leaving **3,480 (25.2%)** in the sampling frame. The excluded 8,166 are a real limitation, not noise: they're invisible to this design, and if attribution_text presence correlates with document age or batch, this gold set is only representative of the scorable subset. Stated as a limitation, not hidden.
2. **Rank bands must be recomputed, not read from the stored fields.** Only 1,544 of the 3,480 frame items already carry a stored `retrieval_confidence` (from a prior partial run of the t/2288 pass) — a non-random subset (whichever batch was reprocessed), so stratifying on stored values alone would bias the sample toward that batch. `population_scan.py` recomputes every item's rank uniformly, using the same pool and field as production. **Sanity check:** of the 1,544 items with a stored value, 1,454 (94.2%) match the recompute within 0.01 cosine; the gap is plausibly taxonomy drift since those fields were written (nodes/embeddings have changed since — the same effect t/4473#5 saw). Not re-investigated further here since the scan doesn't depend on the stored value, only on recomputing it uniformly.
3. **4 items are `sit-*` (Situations) key_points with no POV/BDI**, an artifact of the scan's node-id parsing. Excluded from the sampling frame below (out of scope for this ticket, which is POV × BDI).

**Rank bands** (as specified in the ticket): `1`, `2–5`, `6–30`, `>30`, by cosine rank of the assigned node against `attribution_text` in the full non-pillar pool.

## Strata population (3,476 items, 36 cells of POV × {beliefs, desires, intentions} × band)

Full table in `population.json`. Range: 11 (`skp|desires|2-5`) to 301 (`skp|beliefs|1`). Every cell is non-empty, so n≥200 with full coverage is achievable without collapsing any cell.

## Sample allocation: n=232

Floor of 4 per cell (so every cell, including the 11-item `skp|desires|2-5` floor, contributes a labelled item) plus proportional allocation of the remainder by population share, rounded and topped up from the largest cells to clear the floor total. Full table in `allocation.json`; total 232, comfortably over the n≥200 acceptance bar even after expected adjudication exclusions (duplicates, unreadable attribution_text at label time).

Within each cell, items are drawn by a seeded random sample (seed 4480) over the cell's (doc, node) pairs once labelling starts — not done in this PREREG, since drawing requires freezing the corpus hash used, which should happen right before labelling, not now.

## Rater protocol

- **Two raters.** CL plus one other. Per t/2294, **at least ⅓ of the n=232 ratings** come from someone unfamiliar with the taxonomy — **not yet assigned** (t/4480#1); this PREREG can be filed without them, but labelling can't start until they're identified. Routed as a separate ask, not blocking this document.
- **Both raters label every item independently** (not split), since the acceptance criterion is inter-rater agreement — a split design can't produce that.
- **Labels per item:**
  - `correct` / `borderline` / `misfire` (matches t/2341's existing vocabulary, for comparability);
  - if not `correct`: whether a better node exists, and which (free-text node id or `none found`);
  - cause, if not `correct`: `retrieval-fixable` (a better node exists in the taxonomy; the embedding/ranking missed it) or `taxonomy-structure` (no node actually fits; a gap or an overly broad/narrow category).
- **Contested families scored as families, not single nodes** (t/2294): if a key_point's assigned node is part of a known contested/superseded cluster (per the taxonomy's own lineage markers), the rater labels against the family's current canonical member, and the item is flagged `family-scored` in the gold file so it isn't double-counted as an independent data point in per-node accuracy breakdowns.
- **Adjudication:** disagreements between the two raters go to a third read (CL) that either picks one rater's label with a stated reason or assigns a new label; the adjudicated label is what feeds accuracy reporting, while both raters' raw labels are kept in the gold file for the κ computation (κ must be computed on raw labels, before adjudication, or it measures the adjudicator's own consistency instead of inter-rater agreement).

## Inter-rater agreement and the non-degenerate-threshold rule (t/3587)

- Report Cohen's κ (or a prevalence-adjusted statistic if the label distribution turns out skewed — decide after seeing the raw distribution, not before) with its n and the prevalence of each label.
- **Non-degenerate check, pre-committed:** a PASS reading of agreement must exclude both degenerate modes — raters converging because the task is easy (expected if `correct` dominates at the rank-1 end) and raters converging because both default to one label regardless of signal (checked by confirming label variance is non-zero within each rank band, not just overall).
- If κ comes back high only because `correct` dominates the >95th percentile of items, that's flagged explicitly rather than reported as a bare agreement number, per the t/3587 incident history (κ=1.0 on 2 positive instances was the exact failure mode that rule exists to catch).

## What this PREREG does not do

- **Does not draw the actual sample.** That's the next step once the second rater is identified, and should happen right before labelling starts (freeze the corpus commit used for sampling, record its hash).
- **Does not label anything.**
- **Does not re-evaluate the t/4469 reopen condition, t/4468's post-merge check, t/4471, or t/4472's merge threshold.** Those are downstream consumers of the gold set once it exists (per the ticket description); this document only gets the sampling frame and protocol in place.

## Next steps

1. Request the second rater (≥⅓ unfamiliar with the taxonomy) — routing this as its own ask, not blocking on it.
2. Once assigned: freeze the corpus hash, draw the n=232 sample per `allocation.json` (seed 4480), build the gold-file template, and hand both raters their independent label sheets.
3. Compute κ, adjudicate disagreements, report per-band accuracy, and evaluate the t/4469 reopen condition.
