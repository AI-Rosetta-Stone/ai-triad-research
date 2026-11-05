# t/4603: camp-bridge-ban re-measure

**Author:** PowerShell · **Date:** 2026-10-29 · **Spec:** t/4600#1 (CL), re-measure per t/4603's AC
**Code measured:** `ai-triad-research` on top of PR #4112 (the camp-bridge ban rewrite) and PR #4109/#4110 (unrelated, landed earlier the same day).
**Data:** `ai-triad-data` `17183672` (scratch worktree), scratch sources root holding the 15 sample docs.
**Spend:** PI-approved, cap $1.50 (TL p/360#721, raised from the original 2-run $3 cap). **This run cost $0.6542**: 14 docs through `Invoke-BatchSummary` default flags, same methodology as t/4473's own §5 "after-chunked" run.

## Sample

Unchanged from t/4473 §5: `sample.json`, seed 4473, 15 entries. `evolving-procedural-memory-from-user-traffic-agentic-2026` has `duplicate_of` set to its `-2` twin, so batch triage skips it, as in both prior §5 runs. **n = 14.**

## Isolation

Scratch data worktree (`ai-triad-data/.worktrees/t4603-remeasure`) and a scratch sources root holding only the 15 sample docs plus `_index.json`. `isolation_check.py` hashes every real summary/source file this run could touch, the diff of any already-dirty file under the measured data paths, and both real repos' `git status` lines. Passed before the run and after every doc, including the final check.

## Raw counts (pre-label)

| | off-tag key_points | on-tag key_points | total | off-tag share |
|---|---|---|---|---|
| saved (pre-#3867, n=14) | 149 | 155 | 304 | 49.0% |
| **this run (n=14)** | **68** | **141** | **209** | **32.5%** |

These are raw counts, not yet labelled genuine/stretched/unsupported. The ≤33% bar in t/4600's AC is on the *stretched+unsupported share of off-tag points*, which needs the blind label pass below. The raw off-tag share dropping from 49.0% to 32.5% is a first-order signal in the right direction, not the AC's actual measure.

## Blind sheet, ready for the label pass

`label_sheet.json` / `label_key.json`: 90 items (30 new off-tag, 30 saved off-tag, 30 new on-tag; up to 3 per doc per arm), shuffled with seed 44731, same arm-mixing CL used for the §5 runs so a rater can't tell new from saved from on-tag while labelling. Shows camp, node label, point and verbatim only.

**Not yet labelled: this is the handoff point.** Per t/4603's AC ("CL will do the blind relabeling pass once the new extraction exists"), scoring (`measure.py score`) needs a `labels.json` keyed the same way the prior §5 runs' sheets were (one of `genuine` / `stretched` / `unsupported` per item id). `show_sheet.py <scratch-sources-root> <lo> <hi>` prints the sheet for labelling, with a verbatim-in-snapshot presence check per item.

## Files
- `sample.json`: unchanged from t/4473 §5, reused as-is.
- `run_batch.ps1`: the runner, same budget-stop pattern as the t/4473/t/4556 precedent, cap $1.50.
- `isolation_check.py`: unchanged from the §5 precedent (its real-repo paths are the same real checkouts on this machine).
- `measure.py`: unchanged logic; `sheet` was run, `score` is pending `labels.json`.
- `per_doc.json`, `label_sheet.json`, `label_key.json`: this run's outputs.
- `usage.jsonl`: per-call token usage (scratch-only `AIEnrich.psm1` logging patch, not committed to the module).
- Per-doc logs stayed in scratch and aren't committed, matching the §5 precedent.

---

# t/4742 re-measure (on top of PR #4402's camp-bridge filter)

**Author:** PowerShell · **Date:** 2026-11-04/05 · **Spec:** t/4742's own AC, PI-approved spend (t/4742#6)
**Code measured:** `ai-triad-research` on top of PR #4402 (`Invoke-SummaryCampBridgeFilter`, the mechanical post-check that drops camp-bridge-construction key_points in untagged camps).
**Data:** `ai-triad-data` (scratch worktree `.worktrees/t4742-remeasure2`, off `main`), scratch sources root holding the 15 sample docs.
**Spend:** PI-approved, cap $3 (t/4742#5/#6). **Actual cost not precisely captured** — see "Cost-tracking gap" below. Best-effort partial estimate: ~$0.35 from output tokens alone (139,374 output tokens across 14 docs @ $2.50/1M); input tokens weren't logged. Given the prior t/4603 round's *same* n=14 methodology cost $0.6542 total, this run's true cost is almost certainly in that same ballpark — comfortably under the $3 cap, but not an exact figure.

## Cost-tracking gap (process note, not a result)

`run_batch.ps1`/`measure.py` compute spend from `$env:T4556_USAGE_LOG`, populated by "a scratch-only `AIEnrich.psm1` logging patch, not committed to the module" (t/4603's own RESULTS.md). That patch isn't present in the current checkout, so every doc's `spend_usd` logged as `0.0` — **the budget-stop safety check in `run_batch.ps1` never had real numbers to compare against the $3 cap** (it would not have stopped the run even if spend had exceeded it). The run completed all 14 docs without any sign of distress, and the output-token-only estimate above is well under cap, but this is a real gap worth closing: the module now has a *committed*, standard call logger (`AICallLog.ps1`, gated by `$env:AI_CALL_LOG_ENABLED`) that should be used for cost tracking in any future round instead of chasing the retired ad-hoc patch.

## Sample

Same `sample.json`, same n=14 (the duplicate skip fires correctly — confirmed via `per_doc.json`'s `"status": "skipped_by_triage"` for the `-2` twin's original).

## Isolation

Same methodology as t/4603 (isolation_check.py against the real repos). Passed before the run and after every doc, including the final check.

## Raw counts (pre-label)

| | off-tag key_points | on-tag key_points | total | off-tag share |
|---|---|---|---|---|
| saved (pre-#3867, n=14) | 149 | 155 | 304 | 49.0% |
| t/4603 re-measure (post-#4112 prompt ban, n=14) | 68 | 141 | 209 | 32.5% |
| **this run (post-#4402 filter, n=14)** | **45** | **141** | **186** | **24.2%** |

`camp_bridge_dropped` (PR #4402's filter counter, summed across all 14 docs' `model_info`): **28** key_points dropped before persistence. The further drop from 32.5% to 24.2% is consistent with the filter catching additional camp-bridge-construction points the prompt ban alone didn't stop — a first-order signal, not the AC's actual measure (see below).

As with t/4603: these are raw counts, not yet labelled genuine/stretched/unsupported. The ≤33% bar is on the stretched+unsupported share of off-tag points, which needs the blind label pass.

## Blind sheet, ready for the label pass

`label_sheet.json` / `label_key.json`: 88 items (28 new off-tag — fewer than 30 available this round, 30 saved off-tag, 30 new on-tag), same seed (44731) and arm-mixing as t/4603.

**Handoff point, same as t/4603.** CL: the blind relabel pass, then `measure.py score` once `labels.json` exists.

## Files
- Same file set as t/4603 (`sample.json`, `run_batch.ps1`, `isolation_check.py`, `measure.py` all unchanged; `per_doc.json`/`label_sheet.json`/`label_key.json` overwritten with this round's output, matching the established per-round convention).

## Blind label pass (CL, t/4742)

All 88 items were labelled blind from `show_sheet.py` (arm and doc tag hidden) before `label_key.json` was opened. Labels are in `labels.json` and scores in `results.json` (`measure.py score`). Single rater (CL). Every figure below is an observed count.

| arm | n | genuine | stretched | unsupported | bad share |
|---|---|---|---|---|---|
| new off-tag (post-#4402 filter) | 28 | 10 | 16 | 2 | **18/28 (64%)** |
| saved off-tag (control) | 30 | 2 | 25 | 3 | 28/30 (93%) |
| new on-tag | 30 | 19 | 11 | 0 | 11/30 (37%) |

**AC (≤33% bad share of off-tag points): FAIL**, at 18/28 = 64%. It also failed at t/4603 (17/30 = 57%). The raw volume drop (32.5% → 24.2% off-tag share) is real, but the off-tag points that survive are mostly still bad.

**Rater drift: the round-to-round delta can't be read.** The t/4603 labels are kept as `*_t4603.json`. The control arm, the same saved summaries labelled by the same rater, moved from 20/30 (67%) bad at t/4603 to 28/30 (93%) now. On the 14 items that appear on both sheets, self-agreement is 8/14. Five of the six disagreements went to the stricter label: four genuine→stretched, one stretched→genuine. So the 57% → 64% move is inside rater drift and is not evidence that the filter made things worse. The within-session contrast compares filtered with saved under one calibration: 64% vs 93%, a 29-point drop. At t/4603 the same contrast was 57% vs 67%, a 10-point drop. That is directional evidence that the filter helps, from one rater and n ≈ 30 per arm.

**What the filter misses (mechanism, per item).** Only 2 of the 28 surviving new off-tag points contain bridge phrasing ("from an X perspective", "aligns with X", "X would…"). In the saved control the count is 13/30, 12 of them bad. Of the 18 bad survivors:
- **15 are silent node mismatches.** The content is a faithful summary of the doc, but it is attached to an off-camp node it doesn't argue for, and nothing in the wording signals the stretch. Examples: C08 (code maintainability → "scoring AI bugs"), C59 (judge noise → "simulating user-expert pairs"), and C81 (camera calibration → re-identification at a fusion join).
- **3 of those 15 are polarity inversions**: C26, C63, C82. The doc *opposes* the node's stance (Section 230 defence mapped to a "governance can't enforce" node, to "First Amendment as a corporate shield", and to "judicial mandate of product design").
- **2 are unsupported.** C76 is a "the document does not articulate…" non-claim that should never persist. C53 misframes wet-lab validation as biosecurity screening.

A lexical filter has reached its ceiling here. What remains needs a semantic point-to-node check: does the point argue *for* the node's claim, in the same direction?

**Label reliability caveat.** Intra-rater agreement of 8/14 on the genuine/stretched boundary is weak. Before this metric gates anything, it needs a second independent rater or a tighter rubric.
