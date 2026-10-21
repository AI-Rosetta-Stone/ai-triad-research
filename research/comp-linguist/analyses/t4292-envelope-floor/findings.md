# t/4292 step 1: envelope score distributions (offline, 2026-10-20)

**Question:** would a minimum cosine-similarity floor on the inquiry grounding envelope's per-camp top-3
remove the off-topic and generic nodes seen in t/4254, without harming the rest?

**Answer: no.** The two observed failure modes sit on opposite sides of any useful floor. A floor fixes
the generic-node mode only by emptying whole camps, and doesn't fix the off-topic mode until about
a third of all camp sets are empty. The paid replication study should not be run with an absolute floor
as its treatment.

## Method

- **Instrument:** `measure_envelope_scores.ts`. It calls the production selector `buildGroundingEnvelope`
  (`lib/debate/inquiryGrounding.ts`, code at `origin/main` `3b15a459`) with the production query embedder,
  the server's ONNX all-MiniLM-L6-v2. That embedder is documented as vector-identical to the corpus
  `embeddings.json`. It ran offline (`AI_TRIAD_ONNX_MODEL_DIR` pointed at the local cache), with no model spend.
- **Check:** the envelope's selection equals an independent cosine top-3 for **all 45 question × camp
  pairs**, so the scores below are what production selects.
- **Execution-provider caveat:** the measurement ran on the DirectML provider; the server runs on CPU.
  The repo's ONNX equivalence check covers this. Any difference is floating-point noise, far below the
  score gaps discussed here.
- **Questions (15):** `questions.json`.
  - 3 **observed** inquiries from t/4254: q1 AI Harms court, q2 datacenter, q3 1,000 killed. The fourth
    t/4254 question was left out because its full text isn't recorded.
  - 12 **constructed** questions: the t/3963 motions m01–m10, plus two forecasting probes f1 and f2.
- **Camps measured:** acc (227 embedded nodes), saf (383), skp (377). The server's corpus may also include
  cross-cutting nodes, which this loader doesn't; that's a limitation.
- **Labelled-bad nodes:** only 4, all from the observed runs (statistic provenance, t/3587, n = 4):
  - q2 acc: `acc-intentions-127` ("…Existing Laws Govern Software Harms…") and `acc-intentions-071`
    ("Secure Early Access to … Training Data"), both off-topic for a datacenter question (t/4254#4);
  - q3 saf: `saf-beliefs-206` and `saf-desires-001`, generic civilizational-harm nodes that imported the
    wrong scale in 2 of 2 grounded runs (t/4254#7).

## Results

**Selected-node scores, n = 135 (15 questions × 3 camps × 3 nodes):**

| Statistic | Value |
|---|---|
| min | 0.348 |
| p25 | 0.455 |
| median | 0.500 |
| p75 | 0.547 |
| max | 0.663 |

**Median by question kind:**

| Kind | n | Median | Min |
|---|---|---|---|
| policy | 63 | 0.518 | 0.429 |
| empirical | 36 | 0.493 | 0.402 |
| forecasting | 36 | 0.450 | 0.348 |

**The labelled-bad nodes:**

| Node | Score | Rank |
|---|---|---|
| q2 `acc-intentions-127` (off-topic) | **0.515** | above the all-selection median |
| q2 `acc-intentions-071` (off-topic) | **0.486** | |
| q3 `saf-beliefs-206` (generic) | **0.448** | |
| q3 `saf-desires-001` (generic) | **0.444** | |

**What each floor would do** (counts out of 45 camp sets and 135 nodes):

| Floor | Nodes kept | Camp sets emptied | Bad nodes removed | Bad nodes kept |
|---|---|---|---|---|
| 0.40 | 126 | 1 | none | all 4 |
| 0.42 | 120 | 4 | none | all 4 |
| 0.45 | 106 | 6 (incl. q3 saf **and** skp) | the 2 generic (q3) | the 2 off-topic (q2) |
| 0.48 | 83 | 10 | the 2 generic | the 2 off-topic |
| 0.50 | 67 | **16** | 3 | `acc-intentions-127` (0.515) |

## Reading

1. **Off-topic nodes (q2) can't be separated by cosine score.** They score like on-topic selections:
   0.515 is above the all-selection median. MiniLM similarity on short node labels doesn't distinguish
   "about AI governance in general" from "about this question". No absolute floor below about 0.52 removes
   them, and by 0.50 a third of camp sets are already empty.
   - A **relative** rule (distance from the camp's best node) doesn't help either: q2's acc top-3 spans
     only 0.518 to 0.486.
2. **Generic nodes on uncovered questions (q3) can be detected by score, but not fixed by dropping them.**
   The forecasting questions (q3, f1, f2) have the lowest scores, because the taxonomy has no forecasting
   positions. A 0.45 floor removes the generic saf nodes but **empties q3's Safetyist and Skeptic grounding
   entirely**. An ungrounded camp argues from model priors, which is the t/4253 bug this envelope was built
   to fix.
3. **So the low score is a *coverage signal*, not a filter.** When a camp's best node scores below about
   0.45, the honest output is "the taxonomy has little to say here". Injecting the nearest generic node
   distorts the debate, and silently dropping it de-grounds the camp.

## Recommendations

1. **Don't run the paid R-1 replication with an absolute floor as the treatment.** The offline data already
   shows it can't fix the off-topic mode, and fixes the generic mode only by de-grounding camps.
2. **For off-topic nodes, try a reranker next, offline and free.** Score the top-10 cosine candidates per
   camp with the CL cross-encoder (`train_cross_encoder.py`, under `LOCAL_MODEL_ROOT/cross_encoder`) and
   check whether it demotes the two q2 acc nodes without demoting on-topic ones. Label the cases
   `observed` or `constructed` as above.
3. **For uncovered questions, add a coverage signal.** If a camp's best score is below a stipulated value
   (about 0.45 from this data), keep the nodes but record `low_coverage` per camp in the envelope, with a
   WARN. The synthesis can then caveat that camp's verdict.
   - **Stipulated value**, so a register entry is needed when it ships.
   - Whether the UI shows the caveat is a product call.
4. **Re-baseline when the taxonomy changes.** These numbers are specific to this corpus and embedder.

## Limitations

- 15 questions; only 4 labelled-bad nodes, all from 2 observed inquiries.
- The other 131 selections are **unlabelled**, not "good". The floor table counts what's *removed*, not
  what's *harmful*. A blind topical-fit rating of the selections is the next measurement if a filter is
  pursued.
- Cross-cutting nodes aren't included.

## Step 2: cross-encoder rerank (2026-10-20, offline, no model spend)

**Result: the rerank doesn't survive. Don't take it to the paid replication.**

**Method:** `rerank_cross_encoder.py` writes `rerank.json`.
- **Candidates:** the cosine ranking is re-derived in Python (all-MiniLM-L6-v2 against `embeddings.json`, label-deduped as in t/4352). Its top 3 **matches the production selection in `scores.json` on 45/45** camp sets. The top 10 per camp are the candidates.
- **Scoring:** each candidate is scored as (question, "label. description") by `cross-encoder/ms-marco-MiniLM-L-6-v2`. That is the base model of the CL cross-encoder. The fine-tuned CL weights aren't on this machine, and they are trained for claim-to-node attribution, a different task.

| Labelled-bad node (observed, t/4254) | Cosine rank | Rerank rank |
|---|---|---|
| q2 acc `acc-intentions-127` (off-topic) | 2 | **8** (demoted) |
| q2 acc `acc-intentions-071` (off-topic) | 3 | **1** (promoted to the top) |
| q3 saf `saf-beliefs-206` (generic) | 1 | 7 |
| q3 saf `saf-desires-001` (generic) | 2 | 5 |

**Why it fails:**
1. **Off-topic mode: 1 of 2 is demoted, and the other is promoted to #1.** "Secure Early Access to Human-Generated Training Data" ranks first for a question about datacenters benefiting their community.
2. **Generic mode: the replacement has the same framing.** q3 saf's new #1 is `saf-beliefs-094`, "Frontier AI Could Cause Irreversible Civilizational Harm". That is the civilizational-harm framing the t/4254 debates inherited. The cross-encoder can't add coverage the taxonomy lacks.
3. **It's unstable where it matters.** The rerank changes the top-3 set in **43/45** camp sets. Most candidate logits are below −5, so the model judges nearly every candidate irrelevant, and the order among them is noise. An example of collateral damage: q1 skp drops "AI Systems Expose Fundamental Gaps in Legal Accountability Frameworks" (cosine #1) for an AI-harms-court question.

**What this leaves:**
- **The off-topic mode has no free fix with the models available.** Cosine on labels, and a general-purpose passage reranker, both fail on the one observed case. A further treatment (an LLM relevance judge, or a reranker fine-tuned on question-to-position pairs) first needs **labelled data:** a blind topical-fit rating of the 135 selections. Without it, n = 2 off-topic cases can't support a treatment choice.
- **Recommendation 3 (the `low_coverage` signal) stands,** and is now the only treatment worth building. The best cross-encoder logit is not a cleaner coverage signal than cosine max. The forecasting camp sets all score low on both, but so do some policy sets (m04 acc best logit −8.2). Keep cosine max at about 0.45, stipulated.
- **No paid R-1 replication of a selection treatment is warranted now.**

**Limitations:** the same n = 4 labelled-bad nodes. Only one cross-encoder was tried, and it is out of domain (web-passage QA). The 0.45 coverage threshold is still stipulated.
