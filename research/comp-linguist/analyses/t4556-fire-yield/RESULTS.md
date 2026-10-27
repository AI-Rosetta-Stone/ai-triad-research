# t/4556: does FIRE under-extract key_points? (AC1 attempt, no spend)

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Spend:** none (directive: no new model calls)
**Verdict:** **inconclusive.** There is no paired FIRE vs chunked output to label at zero spend. The mechanism (below) explains the yield gap without assuming any defect. It also corrects the routing premise in the ticket.

## Pre-registered rubric (written before looking for data; unused)

For each doc, take the union of FIRE and chunked key_points, shuffle them and hide the arm. Label each point against the snapshot as genuine (the doc asserts it), stretched, or unsupported. Cluster equivalent genuine points across arms. Coverage = the share of genuine distinct propositions each arm captures. Under-extraction is confirmed if FIRE's coverage is ≤ 50% of chunked on ≥ 4 of 5 docs, **and** the missing propositions are not carried as `factual_claims` instead.

## Data availability

| Source | Status |
|---|---|
| t/4473 §5 FIRE re-extractions (13 paired docs) | **Gone.** The pre and post data worktrees were removed after that run; only logs and sources remain in scratch. |
| t/4471 scratch worktrees (`data-t4471`, `-r2`, `-pro`) | Not usable: the saved and re-extracted summaries are FIRE on both sides (11/11). |
| `ai-triad-data` history: docs with both a FIRE and a single-shot version (`find_both_modes.py`, 77 commits, 884 files) | **3 docs.** One (`notes-eacc-…`) has identical counts in both modes, so it's a relabel. The two real pairs also change model (3.1-flash-lite FIRE in April and May, against flash-lite-latest single-shot in June). |

Two model-confounded pairs fall short of the ≥ 5 the AC requires, so no labelling was done. Descriptively: `agentic-ai-occupational-displacement…` has 6–9 key_points in FIRE against 15 single-shot, and `between-fact-fairy…` has 6–9 against 14.

## Mechanism (read from code on `origin/main`)

1. **FIRE's iterations never touch key_points.** `Invoke-IterativeExtraction` makes one Phase-1 call over the **whole document** (32,768-token output cap). Phases 2–3 iterate only on `factual_claims` (confidence gate, refine or verify, drop). Whatever key_points that single call returns are final.
2. **The chunked path makes one extraction call per chunk** (`Invoke-ChunkedSummary`, chunk prompt `pov-summary-chunk-system`), then merges them (`Merge-ChunkSummaries`). A 15–28k-word paper gets several calls, each asked for points per camp. More calls means more points, before any question of quality.
3. **So the yield gap is structural.** It is "one call per document" against "one call per chunk". That predicts the observed 3–5× gap (t/4556#1 table) whether or not FIRE drops genuine content. Yield alone can't tell under-extraction from the chunked path's redundancy, and t/4472 shows chunk merging leaves real duplicates (5 byte-identical `canonical_proposition`s in one chunked doc).

## Routing premise: corrected

The ticket says AutoFire Stage 1 "routes every chunked doc to FIRE". That's true only for **some entry points**:

| Entry point | Large doc (> 20k est. tokens) goes to |
|---|---|
| `Invoke-BatchSummary` (default) → `Invoke-DocumentSummary` | **chunked** path. Stage 1 isn't reached, and FIRE flags are ignored with a WARN (`Invoke-DocumentSummary.ps1:169-172`). |
| `Invoke-BatchSummary -AutoFire` / `-IterativeExtraction` → `Invoke-BatchFireSummarySet` → `Invoke-POVSummary` | whole-doc pipeline, so Stage 1 sends it to **FIRE** |
| `Invoke-POVSummary` called directly | whole-doc pipeline, so Stage 1 sends it to **FIRE** |

`Invoke-POVSummary` has no chunked path at all. The t/4473 harness (`run_reextract.ps1`) called `Invoke-POVSummary -Force`, so its FIRE routing came from the harness's entry point, not a production routing change. That also explains the gap t/4556#1 left open: the 13 saved single-shot chunked summaries came from the default batch path. Which entry point the corpus's 576 FIRE summaries came from (batch with `-AutoFire`, or a direct or UI-triggered `Invoke-POVSummary`) isn't recorded in `model_info`. Not verified: the taxonomy-editor server's re-summarize call path.

## Consequence for t/4473

The t/4473 §5 saved → post comparison confounds the entry point as well as the mode. Its pre → post control is still the right reading for #3867.

## What would settle AC1

Re-extract ≥ 5 large documents both ways on the **same model and day**: `Invoke-POVSummary` (FIRE) and `Invoke-BatchSummary` default (chunked), scratch roots only. That's 10 runs. On flash-lite, t/4473's measured cost was about $0.03–0.08 per run, so roughly $0.3–0.8 in total. Then apply the rubric above. This needs a new PI spend approval, since it isn't covered by t/4471 or t/4473.
