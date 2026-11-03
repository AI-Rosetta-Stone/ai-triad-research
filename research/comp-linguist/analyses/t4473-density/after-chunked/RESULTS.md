# t/4473 §5 re-measure on the default chunked production path

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Spec:** `docs/density-floor-replacement-spec.md` §5 · **Why a re-run:** t/4473#6
**Code measured:** `ai-triad-research` origin/main at `d3870ca2`. That includes #3867 / t/4519 and PR #3950: t/4553 (no crash on an omitted camp), t/4554 (`empty_cells` persisted by every writer) and t/4555 (hard-constraint bullets scoped to tagged camps). An uncommitted token-logging patch to `AIEnrich.psm1` was applied for spend accounting only; it is not landed.
**Data:** `ai-triad-data` `b93a2dbc`, the same snapshot as the first run.
**Spend:** PI-approved, with a **$3 hard cap** shared across both §5 runs (t/4473#3). This run cost **$0.815**, measured from Gemini `usageMetadata` over 239 calls: 1.09M input and 0.19M output tokens, at ≤ $0.30/M input and ≤ $2.50/M output. With the first run (about $0.5, at most $1.2), the total is at most **$2.0**.

## What changed from the first run

The first run (`../after/`) called `Invoke-POVSummary`. That entry point always goes through AutoFire Stage 1, so 13 of 15 docs went to FIRE, which isn't the production path for large documents (t/4556#2). This run calls **`Invoke-BatchSummary -DocId <doc>`** with default flags (`run_batch.ps1`).
- The only non-default flag is `-SkipConflictDetection`. Conflict detection runs after the summary is written, so it doesn't change what is measured.
- Every log was checked: **12 docs took the chunked pipeline (3–10 chunks), 2 ran single-shot, and none hit AutoFire**.

The saved summaries are the same mode (chunked single-shot), model and settings, so saved → new is the registered comparison and no extra control arm was needed. It is not a pure #3867 effect, though. Every other prompt and retrieval change between the saved run and `d3870ca2` is also in it: t/4468 chunk RAG windows, t/4471 self-contained wording, and t/4555.

**Isolation:**
- One scratch data worktree at `b93a2dbc`, plus a scratch sources root holding the 15 docs' `snapshot.md` and `metadata.json` and `_index.json`.
- `isolation_check.py` hashes:
  - every real summary and source file a run could write;
  - the diff of any already-dirty file under `summaries/`, `taxonomy/`, `conflicts/` and `calibration/`;
  - both real repos' `git status` lines.
- It passed after all 15 docs and once more at the end.

**Sample:** the same 15 single-tag docs (`sample.json`, seed 4473). `evolving-procedural-memory-…-2026` has `duplicate_of` set to its `-2` twin, so batch triage skips it, as production would. **n = 14.**

## Results against the §5 bars

| # | Measure | Bar | Result | Verdict |
|---|---|---|---|---|
| 2 | Off-tag key_points stretched + unsupported (blind) | ≤ 33% | **16/30 (53%)** new; the same docs' saved summaries 28/30 (93%) | **FAIL** (−40 pts on the same docs) |
| 3a | On-tag key_point count, median change per doc | fall ≤ 10% | **−11.9%** (n=14); chunked docs −3.6% (n=12); total 155 → 141 (−9%) | **FAIL, narrowly** (see reading 2) |
| 3b | On-tag genuine (blind) | ≥ 80% | **28/30 (93%)** | PASS |
| 4 | Extraction calls per single-shot doc | 1 | 1 and 1 (n=2) | PASS |
| 5a | `empty_cells` present in every new summary | every | **14/14** (t/4554 fixed) | PASS |
| 5b | Every camp with 0 key_points declared, or the WARN fired | every | 4 empty camps (4 docs), all untagged accelerationist; **0 declared**. No tagged camp is empty, so no WARN is due | **FAIL** |
| — | Crashes on an omitted camp (t/4553) | 0 | 0 | PASS |

All labels are the CL's alone (single rater), using the §2 rubric:
- the sheet has 90 items: 30 new off-tag, 30 saved off-tag and 30 new on-tag, at most 3 per doc per arm;
- it was shuffled with seed 44731 and shows only camp, node, point and verbatim, with no doc, tag or arm;
- labels are stored id-keyed, with a length assertion.

**Calibration caution.** The saved off-tag arm scores 93% here, against 67% in §2 (n=30, different docs) and 76% for the pre-#3867 FIRE arm in the first run. Some of that gap may be rater drift toward strictness. The saved→new comparison inside this run is unaffected, because both arms were labelled together and blind.

## Decision rule from t/4473#4

| | Off-tag share (single-tag docs) |
|---|---|
| saved (n=14) | 149/304 (49%) |
| **new (n=14)** | **83/224 (37%)** |

**37% ≤ 40%: the rule no longer fires.** The t/4555 bullet scope is in, and the share is under the trigger.

## Reading

1. **Off-lens extraction is much better, but the bar isn't met.**
   - On the production path, off-tag points fall from 149 to 83 per 14 docs, and the share of them that are stretched or unsupported falls from 93% to 53%. Estimated bad off-tag points drop by about 2/3: from about 139 to about 44 across the 14 docs.
   - The 16 bad new off-tag items are 11 stretched and 5 unsupported. **10 of the 16** carry an explicit camp bridge ("aligns with the <camp> goal…", "from a <camp> perspective", "<camp>s would support…"). The prompt already bans this, but the model still writes it on technical papers.
   - The 5 unsupported items:
     - 2 are NeurIPS-checklist boilerplate;
     - 1 is a news headline from a page sidebar (t/4564);
     - 2 are points their own verbatim doesn't support.
2. **The on-tag guard fails on the two single-shot docs, not the chunked path.**
   - The chunked median change is −3.6% (n=12). The −11.9% overall median comes from `do-ai-risks` (5 → 3) and `pluralistic` (7 → 3), both short single-shot docs.
   - On-tag genuine is 93%, so the points that remain are sound.
   - With n=14 and the saved arm on older code, this narrow miss isn't strong enough to call a regression. The single-shot path has n=2 here.
3. **Licensed emptiness persists but isn't declared.** `empty_cells` is now written (14/14), but it is `[]` in every summary, including the 4 with an empty untagged camp.
   - On the chunked path, `Merge-ChunkSummaries` keeps a cell only when **every** chunk declared it empty, so one silent chunk erases the declaration.
   - On the single-shot path (`pluralistic`), the model didn't declare it.
   - The per-chunk raw outputs aren't kept, so the two causes can't be separated per doc.
4. **The production path is healthy on the rest:** no crashes, one call per single-shot doc, and no AutoFire routing on the default batch path.

## Spend

| Run | Basis | Cost |
|---|---|---|
| §5 first run (`../after/`) | prompt-size estimate | ≈ $0.5 (≤ $1.2) |
| This run | measured `usageMetadata`, 239 calls | **$0.815** |
| **Total against the $3 cap** | | **≤ $2.0** |

## Files

- `sample.json`: the sample, copied from `../after/`.
- `run_batch.ps1`: the runner, with the budget stop.
- `isolation_check.py`: the real-repo guard, extended to cover taxonomy, conflicts, calibration and dirty-file diffs.
- `usage.jsonl`: per-call token usage.
- `measure.py`, `per_doc.json`, `results.json`: the counts.
- `label_sheet.json`, `label_key.json`, `labels.json`, `show_sheet.py`: the blind labels and the viewer used to produce them.
- Per-run logs stayed in scratch and aren't committed.
