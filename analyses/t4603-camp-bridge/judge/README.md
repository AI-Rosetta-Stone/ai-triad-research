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
