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
