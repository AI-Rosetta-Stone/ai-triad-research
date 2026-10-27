# t/4471 model-tier check: round-2 prompts on gemini-3.1-pro-preview

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Spec:** `docs/decontextualization-rule-spec.md` §7c, pre-registered in `round2/RESULTS.md`
**Question:** is the round-2 failure (factual-claim outward references, `anchors` precision) a model-capacity problem or a wording or field-design problem?
**Code:** `fcbe33a8` (the round-2 code: #3854 in, #3867 not), in a throwaway detached worktree. The model is the only intended variable. Two scratch-only edits were made, neither committed:
- one line in `AIEnrich.psm1` that logs each call's `usageMetadata` for the spend hard stop. It doesn't change the request or the response;
- the org usage's model in `ai-usages.json`. This went unused, because the org arm was skipped (below).

**Isolation:** the data root was a detached `ai-triad-data` worktree (`.worktrees/data-t4471-pro`, `d20bfd46`), and the sources root was a scratch copy. The script refused to run unless the module, data and sources roots all resolved to scratch. It re-checked both real repos after every document: no change under `summaries/`, `conflicts/` or `taxonomy/`, and the sources status was byte-identical to the pre-run snapshot.

## Spend

| | Cost |
|---|---|
| Logged by the usage hook, all three attempts (32 pro calls: 574,525 input and 142,514 output+thinking tokens; plus 13 tiny flash-lite pre-step calls) | **$2.86** |
| One pro call killed in flight when attempt 1 was stopped (not logged; bounded by a single call) | ≤ $0.15 |
| Rounds 1–2 (earlier) | ~$0.40 |
| **Cumulative t/4471** | **≈ $3.4** of the $5 cap; the coordinator's hard stop was $4.50 |

Pricing comes from `ai-models.json`: pro at $2/M input and $12/M output, with thinking tokens billed as output. The run budget was enforced before each document, with a $0.90 single-document reserve.

## The FIRE wall-clock confound, and how it was removed
- **Attempt 1** ran with FIRE's default `WallClockSeconds = 60`. Pro's first extraction call alone takes about 70 s, so FIRE stopped with `wall_clock_exceeded` before its confidence pass. Pro got a single pass, while round-2 flash-lite completed the confidence pass. Attempt 1 was stopped after one document and its output discarded.
- **The limit is a parameter, not a code edit.** `Invoke-SummaryPipeline` doesn't pass `-WallClockSeconds`, so a module-scope `$PSDefaultParameterValues['Invoke-IterativeExtraction:WallClockSeconds'] = 900` raises it at run time.
- **Attempt 2** ran with the raised limit. It was stopped at a document boundary to reorder the remaining documents, putting the non-example documents first under the coordinator's budget priority.
- **Attempt 3** ran the rest. The org arm was skipped: org already passes on flash-lite, and the decision rule can't turn on pro org output.

Every document in both arms completed the confidence pass. "Single-shot" and "FIRE" strata don't exist here: all 11 documents are FIRE-mode in both arms, and none ended on a guardrail.

| Document | Example doc? | Round 2 flash-lite: termination, calls | Pro: termination, calls |
|---|---|---|---|
| california-lawyers… | | all_confident, 1 | all_confident, 1 |
| ai-companies-have-become… | yes | all_confident, 1 | all_confident, 2 |
| reverse-centaurs… | | all_confident, 1 | all_confident, 4 |
| governor-newsom… | | all_confident, 1 | all_confident, 6 |
| from-oversight-coercion… | | all_confident, 1 | all_confident, 6 |
| legal-personhood… | | all_confident, 1 | all_confident, 3 |
| uk-aisis-incident… | | all_confident, 1 | all_confident, 1 |
| atria-dawn… | yes | all_confident, 1 | all_confident, 1 |
| anthropic-pays-authors… | yes | all_confident, 1 | all_confident, 3 |
| why-ai-needs-genie… | | all_confident, 2 | all_confident, 2 |
| ftc-ai-disclosure… | | all_confident, 1 | all_confident, 2 |

Pro marks more of its own claims as uncertain, so it iterates more. That is model behaviour under the same protocol, not a pass-count difference.

## Results (blind, pooled round 2 + pro, single rater)

Round-2 and pro items were pooled and shuffled under opaque ids (`make_sheets.py`, seed 4471), and labelled before `labelling/key.json` was read. **Consistency check:** the pooled re-label reproduces the round-2 figures from `round2/` exactly (1/30 factual, 8/25 anchors).

Verdicts are read on the **8 non-example documents** (§7c guard), with all-11 figures alongside.

| Arm | Round 2 flash-lite | Pro | Bar | Pro vs bar |
|---|---|---|---|---|
| Factual-claim outward references, 8 docs | 1/30 (3.3%) | **0/33** (95% CI 0–10%) | ≤ 2% | meets it at the point estimate |
| Factual-claim outward references, all 11 | 2/44 | 0/46 | | |
| Factual-claim artifacts, 8 docs | 1/30 | **3/33** | no rise | **rises** (see below) |
| `anchors` precision, 8 docs | 8/25 (32%; 95% CI 17–52%) | **8/12 (67%; 95% CI 39–86%)** | ≥ 80% | **below at the point estimate; n too small to exclude 80%** |
| `anchors` precision, all 11 | 14/35 | 10/14 | | |
| Key points carrying a non-empty `anchors` list, all 11 | 35/73 | 14/62 | | |
| Key-point canonical outward references | 1/73 | 0/62 | ≤ 2% | pass |

**What pro changes on anchors:** on the 8 documents, both models produce **8** correct lists. Pro emits 12 lists where flash-lite emits 25. Its higher precision comes entirely from leaving out the wrong lists, not from finding more right ones. Its failures have the same shape as flash-lite's: an example country list (Netherlands/UK/Australia), "such as" cases, sources of quotations, and AISI's evaluation used as evidence.

**Artifacts:** the extra pro artifacts are FIRE verification failures written out as factual claims, for example "The claim that … cannot be verified because no source document was provided". This is the existing FIRE defect (t/4509). Pro triggers it more because it runs more verification iterations, so it bears on FIRE, not on the wording.

## Decision (pre-set rule, applied to the clean stratum only)

**Clean stratum:** the 8 non-example documents. Both arms completed FIRE there, so the comparison is model-only. Its size is n = 12 pro anchor lists and n = 33 pro factual claims.

- **Anchors: INCONCLUSIVE (n = 12).** Pro's 8/12 is below the 80% bar, but n = 12 can't exclude 80%. If true precision were 80%, 8 or fewer correct out of 12 would occur about 21% of the time (one-sided binomial). The rule's branch, "pro fails anchors, therefore withdraw `anchors` from key points", is therefore **not triggered**, and no PowerShell removal ticket is filed under it.
- **Factual claims: INCONCLUSIVE on the model question.** Pro's 0/33 meets the ≤ 2% bar, but it differs from flash-lite's 1/30 by a single item. That does not show a capacity effect.
- **Facts that hold whatever the rule says** (recorded for whoever decides the anchors question; this is not a verdict under the rule):
  - The production model, flash-lite, is at 8/25 anchors precision after two wording rounds, with a 95% upper bound of 52%. That is well clear of 80%.
  - Pro cost about $0.25 per document here, against roughly $0.01–0.02 for flash-lite (round 2 cost ~$0.2 for 11 documents plus 9 org documents), so more than 10× as much.
  - Pro's improvement comes from emitting fewer anchor lists, not more correct ones.

## Files
- `make_sheets.py`, `score.py`: the blind sheets and scoring.
- `scores.json`: the scored output.
- `labelling/`: the sheets, the key and the labels, with a note on every negative.
- `run-pro.ps1`: the final-attempt run script, with spend guard, isolation checks and the run-time wall-clock default.
- `usage-pro.jsonl`: per-call token usage for every attempt (the spend evidence).
