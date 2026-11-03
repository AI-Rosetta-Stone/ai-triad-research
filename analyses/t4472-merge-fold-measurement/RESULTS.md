# t/4472: before/after measurement, pre-t/4472 merge vs. semantic-clustering merge

AC: "On ≥5 multi-chunk docs, the before/after merged key_point count and evidence spans per
claim are reported."

## Method

5 synthetic multi-chunk fixtures (`fixtures.json`), each a 2-chunk `ChunkResults` input, run
through BOTH `Merge-ChunkSummariesOld` (the pre-t/4472 function, loaded verbatim from
`origin/main` via `Merge-ChunkSummariesOld.ps1`) and the new `Merge-ChunkSummaries` (this PR) —
same input, same real local embedding model (all-MiniLM-L6-v2, no AI spend) for both, so the
diff isolates exactly what this PR's code changed, rather than noise from re-running the AI
chunk-summarization pipeline twice on live documents. `run_measurement.ps1` reproduces this;
`results.json` is its raw output.

## Fixtures

1. **Paraphrase key_point** — two accelerationist/Beliefs key_points restate the same thesis
   (near-duplicate `canonical_proposition`), node id shared.
2. **Factual-claim numeric superset** — two claims report the same statistic, one with an added
   number (the superset side).
3. **Templated-stat false positive** — two claims differ only in which demographic group's
   percentage they report (57% vs. 36%) — the exact class CL's calibration found cosine-alone
   wrongly folds.
4. **Same node, reworded point** — t/4472's own motivating defect: identical
   `taxonomy_node_id`, reworded text past the old 80-char prefix window.
5. **Anchors veto** — two safetyist/Intentions key_points are semantically close but anchor to
   disjoint legal instruments (EU AI Act vs. NIST AI RMF).

## Results

| fixture | pre-merge kp | old merged kp | new merged kp | pre-merge claims | old merged claims | new merged claims | new evidence_spans (kp) | new evidence_spans (claims) |
|---|---|---|---|---|---|---|---|---|
| 1. paraphrase key_point | 2 | 2 | **1** | 0 | 0 | 0 | **1** | 0 |
| 2. numeric superset | 0 | 0 | 0 | 2 | 2 | **1** | 0 | **1** |
| 3. templated-stat false positive | 0 | 0 | 0 | 2 | 2 | 2 | 0 | 0 |
| 4. same node, reworded | 2 | 2 | **1** | 0 | 0 | 0 | **1** | 0 |
| 5. anchors veto | 2 | 2 | 2 | 0 | 0 | 0 | **2** | 0 |

## Reading the results

- **Fixtures 1 and 4** (the paraphrase cases): the **old** function did *not* fold these —
  it compared `point` text at a 0.85 threshold, and the two `point` strings differ more than
  their `canonical_proposition`s do. The **new** function folds them (comparing
  `canonical_proposition` at 0.90) and retains the folded duplicate's full evidence
  (`point`/`canonical_proposition`/`verbatim`/`excerpt_context`) in `evidence_spans` on the
  primary — exactly the AC's "no first-occurrence discarding" requirement, concretely
  demonstrated against the real embedding model, not just the mocked unit tests.
- **Fixture 2** (numeric superset): the **old** function kept both claims as separate entries
  (claim_label-based dedup never considered semantic similarity for these two distinct labels).
  The **new** function folds them on the numeric-superset rule and keeps the shorter claim's
  text in `evidence_spans` on the superset primary.
- **Fixture 3** (templated-stat false positive): **both** old and new keep these as 2 separate
  claims. Old never folds them (different `claim_label`-less prefixes). New's numeric-subset
  guard explicitly blocks the fold despite near-identical phrasing — the exact protection CL's
  calibration called for (cosine alone would score this ≥0.95 and wrongly fold "57%" into "36%").
- **Fixture 5** (anchors veto): both old and new keep these as 2 separate key_points — old
  because the real cosine similarity between the two paraphrased sentences fell under its 0.85
  bar; new because, independent of cosine, the anchors veto blocks the fold when both carry
  non-empty, disjoint anchors (EU AI Act vs. NIST AI RMF) — confirmed by `new_evidence_spans
  (kp) = 2`, which is each key_point's own pass-through, not a fold artifact (a true fold would
  show 1 merged key_point with 1 evidence span, not 2 unfolded key_points).

## A methodology note: reproducing a measurement-script defect, not a production one

An earlier version of this script's own evidence-span counting (`@(Get-SummaryProp $x
'evidence_spans').Count` computed inline in the same expression as other member access on the
same line) intermittently over-counted for fixture 3's *unfolded* claims specifically, while an
isolated reproduction of the identical merge calls always showed the correct (zero) count. The
production `Merge-ChunkSummaries` logic was already independently verified correct by 13 passing
mocked unit tests (`tests/Merge-ChunkSummaries.Tests.ps1`) before this measurement was run, so
this was tracked down to the measurement script itself: assigning the accessor's result to its
own variable before the `.Count` access (the current form of `run_measurement.ps1`) resolved it,
and the fix was confirmed stable across 3 repeated runs. Recorded here for anyone extending this
script later.

## Reproducing

```
pwsh -NoProfile -File analyses/t4472-merge-fold-measurement/run_measurement.ps1
```

Read-only; writes only `results.json` in this directory. No AI spend.
