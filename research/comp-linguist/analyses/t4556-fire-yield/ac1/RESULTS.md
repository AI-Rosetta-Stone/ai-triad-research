# t/4556 AC1: FIRE vs chunked key_point coverage on the same documents

**Author:** Computational Linguist · **Date:** 2026-10-27
**Spend:** PI-approved, $3 hard cap with $1.5 planned (t/4556#3). **Actual: $0.63 upper bound**, from 135 metered calls (926,133 input and 142,533 output tokens), priced at the t/4473 flash-lite list ceiling ($0.30/M input, $2.50/M output). The figures are measured from `usageMetadata` (`usage.jsonl`), not estimated.
**Code:** `ai-triad-research` `fcd4d6ec` (origin/main). The scratch code worktree had one local, uncommitted edit: a line in `AIEnrich.psm1` that appends Gemini `usageMetadata` to `$env:T4556_USAGE_LOG`. It doesn't change behaviour.
**Data:** `ai-triad-data` `5d0d5363`. **Model:** `gemini-3.5-flash-lite`, temperature 0.1, both arms, same day.

## Verdict

| | |
|---|---|
| Pre-registered rule | Under-extraction is confirmed if FIRE's coverage, **including propositions carried in its factual_claims**, is ≤ 50% of chunked coverage on ≥ 4 docs |
| Docs meeting the per-doc bar | **3 of 6** |
| **Verdict** | **Not confirmed under the pre-registered rule** |
| Pooled genuine-proposition coverage, FIRE (key_points + factual_claims) | **31 / 81 (38%)** |
| Pooled genuine-proposition coverage, chunked (key_points) | **75 / 81 (93%)** |
| Precision (genuine / points), FIRE | 36 / 41 (88%) |
| Precision (genuine / points), chunked | 113 / 123 (92%) |

The rule wasn't met, so this write-up doesn't claim under-extraction and no fix ticket is filed (t/4556 AC3: "a written rationale if not"). The rationale is below. It doesn't call the gap negligible.

## Setup

- **Sample (`sample_docs.py`, seed 4556):** documents whose saved summary is `single_shot` with `chunk_count` > 1. Exclusions:
  - the 15 t/4473 sample docs;
  - the 11 t/4471 docs;
  - snapshots over 250k chars. This cap was set **before any run**, because the uncapped draw picked an 870k-char, 37-chunk report that would have cost about $0.65 on its own.
  - Population: 218. Two docs per length tertile, so n = 6, from 87k to 220k chars.
- **Arms (`run_both_arms.ps1`):** the two production entry points.
  - **FIRE:** `Invoke-POVSummary -Force`. AutoFire Stage 1 routed all 6 to FIRE on `document_chunked`.
  - **Chunked:** the default `Invoke-BatchSummary -DocId … -SkipConflictDetection`. All 6 ran `Invoke-ChunkedSummary`, with 4–10 chunks.
  - Each arm used its own detached `ai-triad-data` worktree (`data-t4556-fire`, `data-t4556-chunk`, kept until merge) and its own scratch sources copy.
- **FIRE behaviour:** 1 API call per document, `termination_reason = all_confident`, 0 iterations, 3–5 claims each. Defaults were kept, so production behaviour is what's measured.
- **Isolation:** `isolation_check.py` ran after each of the 12 arm runs, and all 12 passed. It checks that nothing a run could write changed in the real `ai-triad-data` or `ai-triad-sources`: sample summaries, `calibration/`, `conflicts/`, sample sources and `_index.json`.

## Method (rubric pre-registered in `../RESULTS.md`)

1. `make_sheet.py` pooled every key_point from both arms per doc, shuffled them (seed 4556) and gave them opaque ids. The arm sits only in `label_key.json`, which I didn't open until labelling was finished.
2. Each item was labelled **genuine** / **stretched** / **unsupported** against the source. I read the two top-cosine source passages per item (`evidence.py`). Wherever those weren't decisive, I also ran a full-text search of the snapshot (`grepdoc.py`).
   - **Genuine:** the document asserts the item's main proposition. A camp-lens gloss ("from a safetyist perspective …") doesn't disqualify an item whose core is asserted.
   - **Stretched:** the main assertion goes beyond the text. Examples: an invented mechanism, such as "trade secrets" (`risks-not-as-013/016`); a fabricated example (COMPAS, not in the text); a counter-camp view the text doesn't hold (`prioritizing-034`).
   - **Unsupported:** not in the document's text. In this run that was mostly **page chrome**: sidebar video captions and archive link titles (`something-bi-001/004/012/019`).
   - In the Delphi paper, expert quotes reported by the document count as asserted by it.
3. While still blind, each genuine item got one primary **proposition cluster** per doc. Cluster definitions are in `labels.json`.
4. Unblinding (`score.py`): an arm's coverage is the share of the doc's union of genuine clusters that the arm's key_points reach.
5. **Factual-claims check (`fc_check.json`, after unblinding):** each FIRE `factual_claim` was compared by hand with the clusters FIRE's key_points missed. 5 claims carry a missed proposition, one per doc on five docs, and those count toward FIRE's coverage. The other FIRE claims carry facts that neither arm's key_points hold, such as ChatGPT download figures, the OpenAI funding round and Majid Al Futtaim programme numbers.

## Per document

| Doc (chars) | FIRE pts | Chunk pts | Union clusters | FIRE cov (kp) | FIRE cov (+fc) | Chunk cov | FIRE ≤ ½ chunk? |
|---|---|---|---|---|---|---|---|
| something-big… (87k) | 8 | 18 | 11 | 0.45 | 0.55 | 1.00 | no (0.55) |
| bold-dataset… (88k) | 5 | 7 | 4 | 1.00 | 1.00 | 0.75 | no |
| new-economy-skills… (113k) | 11 | 12 | 15 | 0.47 | 0.53 | 0.80 | no (0.67) |
| risks-not-assumed… (121k) | 5 | 21 | 14 | 0.21 | 0.29 | 0.93 | **yes** |
| constructing-ai-speech (177k) | 6 | 15 | 12 | 0.33 | 0.42 | 0.92 | **yes** |
| prioritizing-risks… (220k) | 6 | 50 | 25 | 0.12 | 0.16 | 1.00 | **yes** |

The ratio is FIRE coverage (incl. factual claims) divided by chunked coverage. `something-big` misses the bar by 0.045.

## Reading

- **FIRE's key_point count barely moves with length:** 5–11 points per document. Chunked output grows with chunk count, from 7 to 50 points. The gap is smallest on the two shortest documents, though with n = 6 that isn't a measured trend.
- **Precision is close:** 88% for FIRE against 92% for chunked. Neither arm's extra points are mainly padding: chunked averages 1.5 genuine items per cluster and FIRE 1.4.
- **Mechanism (code-read in `../RESULTS.md`):** FIRE's key_points come from one whole-document call, and its later passes touch only `factual_claims`. On a 220k-char document, that one call returns 6 key_points covering 3 of 25 propositions.
- **FIRE's factual_claims don't make up the difference.** They rescue 5 of the 55 propositions FIRE's key_points miss.
- **The chunked arm extracts page chrome.** 4 of its 4 unsupported items are sidebar captions and archive link titles on the one blog document, so the snapshot cleaner leaves widget text in. The single FIRE unsupported item is a claim that isn't in the text ("courts lack the institutional competence…"). The chrome problem is out of scope here and is noted for the owner.

## Why this is not "confirmed", and what that means

The rule was fixed before the data and needed a large gap on ≥ 4 documents. Three documents meet it; two short documents and one long one don't. **I am not relaxing the rule after the fact.** What the data supports:
- **What's supported:** on these six chunk-scale documents, FIRE output covers about 38% of the genuine propositions the two arms found together, against about 93% for the chunked path. It is equally precise.
- **What isn't supported:** the claim that FIRE under-extracts under the pre-registered definition.

This matters for corpus decisions. Any re-summarization through `Invoke-POVSummary` routes chunk-scale documents to FIRE and will produce summaries with about a third of the key_points. Re-summarizing the corpus is a separate T2 `/data-mutation` decision for the PI, and this analysis doesn't propose one.

## Limitations

- **Single rater** (CL). The labels are blind to arm but not double-coded.
- **n = 6 docs**, 164 items. Wilson 95% intervals on the pooled coverage: FIRE 31/81 → 0.28–0.49; chunked 75/81 → 0.85–0.97. These pool items across documents and ignore within-document clustering.
- **Coverage is relative to the union of the two arms,** not to an exhaustive proposition gold set. Propositions neither arm extracted are invisible.
- **One primary cluster per item.** An item touching two propositions counts once, which slightly understates coverage for multi-proposition items in both arms.
- **The factual-claims check was done after unblinding.** It's a direct proposition match, listed in `fc_check.json`.

## Files

`sample_docs.py`, `sample.json`, `run_both_arms.ps1`, `isolation_check.py`, `make_sheet.py`, `label_sheet.json`, `label_key.json`, `labels.json`, `add_labels.py`, `evidence.py`, `grepdoc.py`, `pairs.json`, `factual_claims.json`, `fc_check.json`, `counts.json`, `score.py`, `results.json`, `usage.jsonl`.
- **Not committed:** `evidence/`, the source-text excerpts. Re-run `evidence.py` against `ai-triad-sources` to regenerate them.
- **Kept until merge:** the scratch data worktrees `ai-triad-data/.worktrees/data-t4556-{fire,chunk}`, which hold both arms' summaries. The run logs are in the CL scratchpad.
