# t/4473 §5 after-measurement: density floor and retry removed, tag-aware camp expectations

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Spec:** `docs/density-floor-replacement-spec.md` §5
**Code measured:** `ai-triad-research` `c0e5414c` (origin/main, includes #3867 / t/4519). The **pre** control arm is `634504fc` (`cbfc37be^`, the commit before #3867).
**Data:** `ai-triad-data` `b93a2dbc`. **Spend:** PI-approved $3 hard cap (t/4473#3); actual estimate in §Spend.
**Isolation:**
- Each arm wrote to its own detached `ai-triad-data` worktree. The sources root was a scratch copy of the 15 documents plus `_index.json`.
- `isolation_check.py` ran after every document, 30 times. It hashes every real summary and source file a run could write, and diffs both real repos' `git status`. All 30 checks passed.
- Both real checkouts already carried other agents' uncommitted work, so "clean" means *unchanged on every path this run can write*.

## Sample

`sample_docs.py` draws from single-tag documents whose saved summary is `extraction_mode: single_shot` and whose saved model is still in `ai-models.json`. It excludes the 60 docs in the §2 label sheet and uses seed 4473. The population is 57 and the first 15 are taken. 13 of the 15 were saved as chunked.

Each document was re-extracted twice with `Invoke-POVSummary -Force`, using the saved model and temperature:
- **pre:** pre-#3867 code;
- **post:** post-#3867 code.

**Deviation, found on the first run and not pre-registered:** AutoFire Stage 1 (`Invoke-SummaryPipeline.ps1:168`) is always on and now routes every chunked document to FIRE, on word_count > 8000 + chunked + pdf. So "same settings as the saved summary" can't be reproduced for 13 of the 15. Both re-extraction arms ran FIRE on those 13. The pre-registered comparison (saved → post) therefore confounds #3867 with a mode change. The pre arm was added as the same-mode control. Pre → post isolates #3867.

Run outcomes:
- **post:** 14 of 15 completed. `zero-trust-…` crashed when the model omitted an untagged camp (t/4553).
- **pre:** 14 of 15 completed. `pluralistic-…` returned InvalidJson.
- **Paired:** n = 13.

## Results against the §5 bars

| # | Measure | Bar | Result | Verdict |
|---|---|---|---|---|
| 2 | Off-tag key_points stretched + unsupported (blind) | ≤ 33% | **14/25 (56%)** post; same docs pre 22/29 (76%); §2 baseline 20/30 (67%) | **FAIL** (improved 20 pts on same-mode control) |
| 3a | On-tag key_point count, median change per doc | fall ≤ 10% | saved → post **−81%** (n=14); pre → post **0%** (n=13, paired) | **FAIL as registered**; the drop is the FIRE routing, not #3867 (t/4556) |
| 3b | On-tag genuine (blind) | ≥ 80% | **25/30 (83%)** post | PASS |
| 4 | Extraction calls per single-shot doc | 1 (baseline ~2) | post 1, 1; pre 2 (density retry fired), 1 (InvalidJson) | PASS (n=2) |
| 5a | `empty_cells` present in every new summary | every | **0/14** | **FAIL**: `Invoke-POVSummary`'s writer doesn't persist it (t/4554) |
| 5b | Every camp with 0 key_points declared, or WARN fired | every | 6 empty camps in 4 docs, all untagged, so no WARN is due; declarations aren't checkable (5a) and one omitted camp crashed the run (t/4553) | **FAIL** |

All labels are the CL's alone (single rater), blind to arm, document and tag, using the §2 rubric. The sheet has 84 items: 25 post off-tag (all of them, capped at 3 per doc), 29 pre off-tag, and 30 post on-tag.

## Decision rule from t/4473#4 (pre-registered)

The rule: *if the off-tag key_point share for single-tag documents is still above 40%, scope the "Examine ALL nine BDI cells / extract every distinct point" bullet to tagged camps.*

| | Off-tag share |
|---|---|
| saved (n=14 docs) | 149/300 (49.7%) |
| **post (n=14)** | **27/60 (45.0%)** |
| pre, paired (n=13) | 35/67 (52.2%) |
| post, paired (n=13) | 26/55 (47.3%) |

**45% > 40%: the rule fires.** The bullet change is filed as t/4555. The §5 re-measure runs again after it lands.

## Reading

1. **#3867 moves off-lens extraction in the right direction, but not to the bar.** On the same docs in the same mode, stretched + unsupported off-tag points fall from 76% to 56%, and the off-tag share from 52% to 47%. On-tag counts don't change: the median paired change is 0. The prompt bans "From an <camp> perspective, this …" bridging, but it is still almost universal in post output:
- 12 of 14 stretched or unsupported off-tag items use it;
- so do 10 of 11 genuine off-tag items and 22 of 25 genuine on-tag items.

It no longer marks a stretched point, so a phrase check can't stand in for the blind label.
2. **The on-tag count guard can't be read for #3867 against the saved summaries.** On these 14–28k-word papers, FIRE returns about 2 key_points per camp. The median per document is 4 in both re-extraction arms, against 21.5 saved. The corpus shows the same split: FIRE median 6 (n=576), chunked single-shot median 23 (n=268). The new routing may be under-extracting. That's a separate question, filed as t/4556 (CL).
3. **Licensed emptiness exposed two code-path gaps.** The model now omits or empties untagged camps, as the spec intends: 6 empty camps in 4 of 14 docs, with no tagged camp empty. But `Invoke-POVSummary` can't persist `empty_cells` (t/4554), and it crashes when a camp key is missing (t/4553).
4. **The retry is gone.** The single-shot doc whose pre run fired `density retry 1/1` made one call post.

## Spend

The pipeline doesn't log billed tokens, so this is estimated from its own `chars/4` prompt figures.
- **Extraction input:** pre 0.73M and post 0.71M tokens, one call per document (FIRE `api_calls` = 1 on all 24 FIRE runs, so there were no iteration calls). Plus an aborted first post attempt: 1 doc, CHESS call only.
- **Output:** up to about 0.15M tokens.
- **CHESS classify:** about 31 calls, each smaller than an extraction call.

At flash-lite list pricing (assumed ≤ $0.30/M input, ≤ $2.50/M output), the total is **about $0.5, with an upper bound of $1.2**. That is under the $3 cap.

## Files

- `sample_docs.py`, `sample.json`: the sample.
- `run_reextract.ps1`: the runner. It passes `-ApiKey` explicitly, because the measured head predates the t/4529 fix.
- `isolation_check.py`: the real-repo guard.
- `measure.py`, `per_doc.json`, `results.json`: the counts.
- `label_sheet.json`, `label_key.json`, `labels.json`: the blind labels.
- The per-run logs stayed in scratch and aren't committed.
