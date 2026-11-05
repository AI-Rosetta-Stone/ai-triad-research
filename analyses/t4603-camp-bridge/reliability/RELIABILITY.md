# Camp-bridge label reliability (t/4881)

**Question:** can the t/4600 off-tag AC (stretched + unsupported share ≤ 33%) be judged from one rater's labels? **No.** The verdict changes depending on who labels.

> **Update, rubric v2 (see the "Rubric v2 result" section below):** with node descriptions on the sheet, two fresh blind raters reach binary κ 0.79 with a prevalence gap of 0.08, which **meets** the reliability criterion. Both v2 raters put the t/4742 new off-tag bad share above 33% (39% and 57%), so **the AC fails reliably.**

## Raters
- **R1 (CL):** the original t/4603 and t/4742 labels (`../labels_t4603.json`, `../labels.json`). Made before the rubric existed.
- **R2:** a blind agent (Sonnet) working from `../RUBRIC.md` and the blind sheets only (`rater2_labels_*.json`, notes in `rater2_notes.md`).
- **R3:** a blind agent (Opus, fresh context) that labelled only the 55 items where R1 and R2 disagreed. It saw nothing that identified which rater gave which label (`rater3_disputed.json`; the item map is in `rater3_disputed_index.json`).
- **Adjudicated:** R1/R2 where they agree, otherwise the majority of the three (`adjudicated_*.json`).

## Agreement, R1 vs R2 (observed)

| round | n | 3-class agreement | κ (3-class) | binary (genuine vs bad) agreement | κ (binary) | bad prevalence R1 / R2 |
|---|---|---|---|---|---|---|
| t/4603 | 90 | 0.60 | 0.28 (p_e 0.44) | 0.64 | 0.29 (p_e 0.50) | 0.50 / 0.46 |
| t/4742 | 88 | 0.78 | 0.63 (p_e 0.42) | 0.80 | 0.60 (p_e 0.48) | 0.65 / 0.44 |

On t/4742 every disagreement has the same direction: R1 `stretched`, R2 `genuine` (18 items), plus one `stretched`/`unsupported`. On the 55 disputed items, R3 sided with R2 35 times and with R1 20 times.

## Off-tag bad share by labeller (observed counts)

| arm | R1 | R2 | adjudicated |
|---|---|---|---|
| t/4603 new off-tag (n=30) | 17 (57%) | 10 (33%) | **13 (43%)** |
| t/4742 new off-tag (n=28) | 18 (64%) | 8 (29%) | **16 (57%)** |
| t/4603 saved off-tag (n=30) | 20 (67%) | 21 (70%) | 23 (77%) |
| t/4742 saved off-tag (n=30) | 28 (93%) | 23 (77%) | 25 (83%) |
| t/4603 new on-tag (n=30) | 8 (27%) | 10 (33%) | 10 (33%) |
| t/4742 new on-tag (n=30) | 11 (37%) | 8 (27%) | 10 (33%) |

## What holds across labellers
- **The filtered arm beats the saved arm in every labelling.** The gap is 10 to 48 points; adjudicated it is −34 points for t/4603 and −26 for t/4742.
- **The AC is not met on the adjudicated labels in either round** (43% and 57% against ≤33%). Under R2 alone it passes in both (33% and 29%). The AC verdict therefore depends on where the genuine/stretched line sits, which is exactly where the raters disagree.
- **The t/4603 → t/4742 change** is −14 points (R1 moves the other way), +4 (R2) and +14 (adjudicated). Each arm has n≈30, so the binomial standard error is about 9 points per arm, and no labelling shows a clear round-to-round change.
- **Adjudicated, a third of *on-tag* points are also bad (33% in both rounds).** The stretch is not specific to off-tag points.

## Reliability criterion, and why it isn't met yet
Proposed pass criterion before this metric gates anything. It is stipulated: CL, t/4881.
1. Binary κ ≥ 0.6. This excludes raters who diverge, and it is undefined or 0 when either rater labels everything the same way, which excludes constant raters.
2. **And** the two raters' bad prevalence differs by ≤ 0.10. That excludes a high-κ pass where the raters agree only because they share a lopsided split, and it catches a systematic offset that κ alone can hide.

On t/4742, κ = 0.60 (borderline) and the prevalence gap is 0.21, so the criterion fails. On t/4603, κ = 0.29, so it fails.

## Main cause, and rubric v2
R2's top ambiguity was that many node *titles* don't say which way they point ("Legal and Regulatory Frameworks for AI Accountability"), so raters can't check "same direction" against a label alone. Both raters saw only node labels. Rubric v2 is the next step:
- Show the node's **description** on the sheet, not just its label.
- State how to treat a doc that argues by analogy from a non-AI case. R2 defaulted to `stretched`.
- Turn the bridge-sentence delete test into a graded rule.

After that, re-rate a fresh blind sample with two raters and check the criterion above.

## Embedding probe (t/4880)
`t4880_embedding_probe.py`: point-to-node cosine similarity gives AUC 0.505 on t/4742 new off-tag items (21 genuine / 31 bad on R1 labels). It is not usable as a check; see t/4880#1.

## Rubric v2 result (t/4742 sheet, n=88)

`../RUBRIC_v2.md` puts the node **description** on the sheet (`v2_sheet_t4742.txt`) and adds rules 5 to 8. The two raters are fresh blind agents: A is Sonnet (`v2_raterA_labels_t4742.json`) and B is Opus (`v2_raterB_labels_t4742.json`). Neither had seen any earlier labels. All figures are observed.

| | value |
|---|---|
| 3-class agreement / κ | 0.90 / 0.82 |
| binary agreement / κ (p_e) | 0.90 / **0.79** (0.50) |
| bad prevalence A / B, gap | 0.51 / 0.59, **0.08** |

**The criterion is met** (binary κ ≥ 0.6 and prevalence gap ≤ 0.10). Eight of the nine disagreements go the same way: A `genuine`, B `stretched`.

| arm | A bad | B bad | both bad | either bad |
|---|---|---|---|---|
| new off-tag (n=28) | 11 (39%) | 16 (57%) | 11 | 16 |
| saved off-tag (n=30) | 24 (80%) | 26 (87%) | 24 | 26 |
| new on-tag (n=30) | 10 (33%) | 10 (33%) | 9 | 11 |

- **AC (≤33% off-tag bad): FAIL under both raters**, even on the lenient "both bad" count (11/28 = 39%). It is a reliable fail, in a range of 39% to 57%.
- **The filter's effect is reliable:** filtered vs saved is −41 points for A and −30 for B.
- **On-tag points are a third bad** under both raters.
- **Caveats:**
  - 5 of the 9 disagreements fall in the new off-tag arm, so agreement there (n=28) is weaker than the pooled figure.
  - v2's rules were written from R2's notes on these same sheets. The anchors are still constructed and the raters were fresh, but the next round should confirm on a new sample.

**For a rubric v3**, from both v2 raters' notes:
- Split `stretched` into *topic-only* and *polarity inversion* (B found 4 confident inversions).
- Add a cue for content that falls in the node's own `Excludes:` list.
- Rule 5 (`neutral-node`) never fired, because every description takes a side, so drop it.
- Avoid repeating the same verbatim span across items on one sheet.

The polarity split also feeds the t/4880 judge, which uses `argues_against` as an output class.
