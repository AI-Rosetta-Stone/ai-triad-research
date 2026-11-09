# Camp-bridge point-to-node judge: calibration (t/4880)

The question is whether an LLM judge can catch off-tag key_points whose document doesn't argue the attached node, the residual that the lexical camp-bridge filter misses (t/4742#8). Embedding similarity can't: its AUC was 0.505 (`../reliability/t4880_embedding_probe.py`).

## Setup
- **Items:** the 88-item t/4742 sheet (`../label_sheet.json`). Inputs are the camp, the node label and description, the point, and the verbatim span (≤ 600 chars). See `build_items.py`.
- **Reference:** the v2 two-rater labels from t/4881 (`../reliability/v2_rater{A,B}_labels_t4742.json`, binary κ 0.79). Scoring uses only items where both raters agree on genuine vs bad: 79 items overall, 51 of them off-tag.
- **Judge:** gemini-3.5-flash-lite at temperature 0, JSON mode (`run_judge.ps1`). A point is **kept** only on `argues_for`; any other relation drops it.
- **Pass bar** (stipulated, t/4880#2): on agreed off-tag items, bad-recall ≥ 0.8 **and** genuine-dropped ≤ 0.2.
- **Spend:** PI-approved cap of $3 (2026-11-06). Spend is computed from the token usage each response returns, priced high on purpose ($1/1M input, $4/1M output). The run stops on a missing usage record rather than counting the call as $0 (t/4882). **Total upper bound: $0.28** over 3 + 88 × 3 calls.

## Results (observed counts)

| run | off-tag bad caught | off-tag genuine dropped | all bad caught | all genuine dropped | pass |
|---|---|---|---|---|---|
| v0 (`out_v0.jsonl`) | 34/35 (0.97) | 4/16 (0.25) | 43/44 | 8/35 | no |
| **v1** (`out_v1.jsonl`) | 32/35 (0.91) | 1/16 (0.06) | 41/44 | 2/35 | **yes** |
| v1 repeat (`out_v1_rep2.jsonl`) | 30/35 (0.86) | 0/16 (0.00) | — | — | **yes** |

- **v0 was too literal.** In all 8 of its genuine drops, the judge required the document to argue every clause of the node description. v1 adds one paragraph saying that a direct instance or a core part of the claim counts, and that the point's non-framing content may be used when the span is short.
- **Stability:** across the two v1 runs, 4/88 items flip between keep and drop (C07, C16, C25, C39), even at temperature 0. Report v1 as a range: off-tag bad-recall 0.86 to 0.91, genuine-dropped 0 to 0.06.

## Caveats (why this isn't ready to wire in yet)
1. **v1 was tuned on this same set.** One prompt edit was driven by v0's errors on these items. Held-out confirmation on a fresh sample, labelled by two blind raters on rubric v2 or v3, comes before the pipeline change.
2. **The genuine count is small** (n=16 off-tag). One more false drop moves the rate by 6 points.
3. **There are only 3 disputed items here** (labelled `disputed` in the `score.py` output), so the judge's behaviour on the hard boundary is barely sampled.

## Next
- Confirm on a held-out sample. That needs a fresh extraction sample and a two-rater pass; the judge run itself costs about $0.10.
- Then a PowerShell implementation ticket: the judge as a post-extraction step, a deterministic pre-drop for `does not (propose|articulate|engage)` placeholders, and drop counts by relation in `model_info`.

## Held-out check (2026-11-09): v1 does NOT generalize

- **Held-out set:** the t/4603 sheet (`../label_sheet_t4603.json`, 90 items), which wasn't used to tune v1. It covers the same 14 docs, so the items are held out but the documents are not.
- **Reference labels:** two fresh blind raters on rubric v2: A is Sonnet, B is Opus (`../reliability/v2_rater{A,B}_labels_t4603.json`).
  - Binary κ **0.62** (n=90, p_e 0.54).
  - Bad prevalence is 0.58 for A and 0.73 for B, a **gap of 0.16**, so this sheet misses the t/4881 reliability criterion (gap ≤ 0.10). B is stricter.
  - Scoring therefore uses only items where both raters agree: 74 items, 47 of them off-tag.
- **Judge:** v1, one run (`out_v1_holdout_t4603.jsonl`). Spend upper bound is $0.10, bringing the t/4880 total to $0.38.

| subset | bad caught | genuine dropped | pass |
|---|---|---|---|
| off-tag (agreed) | **30/40 (0.75)** | 0/7 | **no**: recall is below 0.8 |
| new off-tag | 11/18 (0.61) | 0/4 | — |
| new on-tag | 9/11 | 0/16 | — |

**Why it misses.** I read all 10 missed bad off-tag items for diagnosis only; nothing was tuned on them. v1's added paragraph ("use the POINT's non-framing content"; "a core part counts") made the judge **accept the summarizer's inference** instead of checking the document. It now passes:
- inference added by the point (C15, C77);
- wrong-scope mappings (C28, C77);
- checklist boilerplate (C22);
- content the node's own `Excludes:` list rules out (C72);
- null-node items (C01, C47).

The v0 → v1 edit traded recall for genuine retention on the calibration set, and the trade didn't hold.

**Consequence.** **Don't wire v1 in.** A v2 would restore span-primacy (the point only *locates* the argument and never supplies it), add an explicit `Excludes:` check, route boilerplate to `not_a_claim`, add a wrong-scope rule, and give null-node items a camp-level rule. Because these 10 items have now been read, the t/4603 sheet can't validate v2. **v2 needs a fresh-document sample:** a new extraction run plus a two-rater pass, which means a PI spend decision.
