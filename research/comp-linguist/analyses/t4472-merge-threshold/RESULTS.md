# t/4472 merge-threshold calibration: semantic dedup in Merge-ChunkSummaries

**Author:** Computational Linguist · **Date:** 2026-10-27 · **Ticket:** t/4472 (child E of t/4467)
**Data:** `ai-triad-data` `b93a2dbc`, 884 summaries, read-only. **Embedder:** all-MiniLM-L6-v2, normalized (the production embedder). **Spend:** none.
**Labels:** CL, single rater, blind to cosine and band (`label_sheet.json` holds texts only; `label_key.json` was joined after labelling).

## Question

The ticket proposes folding duplicate key_points and factual_claims at a **stipulated** cosine of 0.85. Which threshold should each pair type use, and how good is it?

## Method

- **Pairs.**
  - key_points: every pair within one document and one (camp, BDI category) cell, embedding `canonical_proposition`. 9,705 key_points with no `canonical_proposition` are excluded; the implementation's fallback to `point` is not calibrated here.
  - factual_claims: every pair within one document, embedding `claim`.
- **Population** (`population.json`): 12,418 key_point pairs and 78,632 factual_claim pairs. Of these, 1,641 and 15,101 respectively score ≥ 0.60.
- **Sample** (`sample_pairs.py`, seed 4472): 10 pairs in each of 7 bands (0.60–0.70, 0.70–0.75, 0.75–0.80, 0.80–0.85, 0.85–0.90, 0.90–0.95, ≥ 0.95), for each type. That gives **140 pairs (70 + 70)**. Two-thirds of each band come from multi-chunk documents where enough exist; in practice nearly every pair at ≥ 0.60 is from a chunked document.
- **Rubric.**
  - `SAME`: mutual paraphrase, so merging loses no assertion.
  - `SUB`: one side entails the other, and the other adds a specific (actor, number, mechanism).
  - `CORE`: same central thesis, but each side carries a different mechanism, consequence or scope.
  - `DIST`: a different assertion, including different scope, quantity, actor, population, date, modality or polarity.
- **Truth.**
  - **Strict** (the ticket's rubric) counts `SAME` only.
  - **Lenient** counts `SAME` + `SUB`, which is safe to fold only if the superset side becomes the primary.
- **Estimates** (`score.py` → `results.json`):
  - *Sample* figures are raw counts on the labelled pairs.
  - *Weighted* figures reweight each band to its corpus population.
  - Recall is relative to pairs at ≥ 0.60, because nothing below 0.60 was sampled.

## Results

### key_points (n = 70 labelled pairs; 20 strict positives, 25 lenient)

| Threshold | Merges | TP / FP / FN (strict) | P | R | F1 | Weighted P | Weighted R |
|---|---|---|---|---|---|---|---|
| 0.80 | 40 | 18 / 22 / 2 | 0.45 | 0.90 | 0.60 | 0.31 | 0.48 |
| **0.85 (stipulated)** | 30 | 16 / 14 / 4 | **0.53** | 0.80 | 0.64 | 0.45 | 0.31 |
| 0.88 | 24 | 16 / 8 / 4 | 0.67 | 0.80 | 0.73 | 0.63 | 0.31 |
| **0.90** | 20 | 16 / 4 / 4 | **0.80** (Wilson 95% 0.58–0.92) | 0.80 | **0.80** | 0.84 | 0.31 |
| 0.92 | 17 | 14 / 3 / 6 | 0.82 (0.59–0.94) | 0.70 | 0.76 | 0.87 | 0.28 |
| 0.95 | 10 | 10 / 0 / 10 | 1.00 (0.72–1.00) | 0.50 | 0.67 | 1.00 | 0.22 |

Labels by band (SAME/SUB/CORE/DIST), from the lowest band to ≥ 0.95:
- 0.60–0.70: 0/0/4/6
- 0.70–0.75: 1/0/3/6
- 0.75–0.80: 1/2/5/2
- 0.80–0.85: 2/1/5/2
- 0.85–0.90: 0/2/6/2
- 0.90–0.95: 6/0/2/2
- ≥ 0.95: 10/0/0/0

**At 0.85, most merges are wrong.** The 0.85–0.90 band contains no `SAME` pair. It is mostly `CORE`: the same thesis with different mechanisms. Two examples are two Zero-Trust designs for AI (0.862), and "data-centre construction improves performance through green innovation" against the same claim "through economic output growth" (0.873). Folding these keeps one mechanism as the proposition and demotes the other to an evidence span.

**The four false positives at ≥ 0.90:**
- two `CORE` pairs (0.933, 0.908);
- one condition flip, sampled twice: "…terminate internal distress signals *when equipped with relief mechanisms*" against "…*even at the expense of external safety constraints*" (0.921). It is a different assertion that is lexically almost identical. This is the case a folding rule must not hide.

**Recall is the weak side.** Weighted recall is ~0.31 at any threshold of 0.85 or above, because genuine paraphrases also sit at 0.70–0.85. Examples: "employer data collection" against "employer surveillance" (0.812), and "early-career workers in high-exposure occupations" against "junior workers in cognitively exposed occupations" (0.839). Those bands are large, and each has only 1–2 positives in the sample, so the weighted recall rests on very few pairs. Read it as "most paraphrase duplicates fall below any safe threshold", not as a point estimate.

### factual_claims (n = 70 labelled pairs; 1 strict positive, 5 lenient)

**No cosine-only threshold works.** Strict precision is ≤ 1/10 at every threshold, including ≥ 0.95. Lenient precision is at most 3/10, at ≥ 0.95.

The ≥ 0.95 band is dominated by **templated survey statistics** that differ only in a number, group or date. Examples:
- "Asian adults (57%) … White adults' perspectives" against "Asian adults (36%) … Asian adults' perspectives" (0.987);
- the same Pew question in December 2022 against February 2024 (0.985).

MiniLM puts these at the top of the scale. Folding them would destroy distinct facts.

**A numeric-token guard separates them on this sample.** The guard folds only when one side's numbers (`\d+(\.\d+)?`) are a subset of the other side's.

| Rule | Folds | Lenient TP / FP | Strict TP |
|---|---|---|---|
| cos ≥ 0.85 + numeric subset | 6 | 5 / 1 (P073: no numbers on either side, different claims) | 1 |
| **cos ≥ 0.90 + numeric subset** | 4 | **4 / 0** | 1 |
| cos ≥ 0.90 + numeric sets equal | 1 | 1 / 0 | 1 |

All 4 folds at cos ≥ 0.90 with the subset guard are correct folds into a superset, **provided the side with more numbers becomes the primary**. This rests on **4 guarded pairs**. That is enough to choose a direction, not enough to validate it.

### Anchors (t/4471)

**Unanswerable from the corpus.** 0 of the key_points in 884 summaries carry an `anchors` field yet, because t/4482/t/4518 apply only to new extractions. No sampled pair could test "same proposition, different anchors".

The calibrated threshold embeds `canonical_proposition` alone, so two key_points about different named instruments would fold whenever their propositions match. That is the case anchors exist to separate.

### Side finding: identical propositions survive today's dedup

10 of the 70 sampled key_point pairs are byte-identical `canonical_proposition`s in one cell of a chunked document. Five copies of "Algorithmic management systems function as tools of control…" come from one document. They survive because today's key is `taxonomy_node_id | point[0:80]`, and the `point` prose differs while the proposition does not. This is direct evidence for the t/4472 defect.

It also means the sample's ≥ 0.95 band leans on one document: 4 of its 10 pairs come from those five copies.

## Recommendation

| Pair type | Threshold | Conditions | Provenance |
|---|---|---|---|
| key_points | **0.90** (not 0.85) | Scope stays within (camp, BDI category). Each folded record keeps its own `canonical_proposition` alongside its verbatim span, so a false fold is visible and reversible. If the implementation cannot keep it, use **0.95** (precision 10/10, recall 0.50). | **human-validated, single rater**: n = 70 pairs, 20 positive; P 16/20, R 16/20 on the sample |
| factual_claims | **0.90 plus the numeric-subset guard**; the primary is the side with the superset of numbers. Never cosine alone. | No `claim_label` short-circuit. A pair with no numbers on either side needs ≥ 0.95. | **stipulated**: 4 guarded pairs. Path off stipulated: blind-label ≥ 30 guard-passing pairs from the implementation's own output, with a bar of precision ≥ 0.90. |
| anchors | **Do not fold** two key_points whose `anchors` are both non-empty and disjoint. Otherwise, union the anchors on fold. | — | **stipulated**: no corpus data. Re-check on the first post-t/4518 re-extraction. |

The 0.85 starting value is **rejected**. Its precision of 16/30 means about half its key_point merges would fold distinct mechanisms together.

## Limits

- **Single rater.** There is no agreement statistic. The `SAME`/`CORE` boundary is the judgment most likely to move under a second rater.
- **Recall covers ≥ 0.60 only,** and the weighted recall rests on 1–2 positives per large band.
- **Some pairs are repeated texts.** Five identical copies give 10 pairs, and one text pair appears twice. The effective n is below 70.
- **Thresholds are bound to all-MiniLM-L6-v2.** A change of embedder voids them (the t/524 precedent).

## Files

- `sample_pairs.py`: builds the population and the stratified blind sample.
- `population.json`: pair counts per band.
- `label_sheet.json`: the blind sheet.
- `label_key.json`: cosine, band and document for each pair.
- `labels.json`: the labels.
- `score.py`: computes `results.json`.
