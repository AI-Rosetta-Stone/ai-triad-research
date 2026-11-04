# Bridging the Register Gap: Improving Semantic Matching Between Ontological Descriptions and Debate Claims

**AI Triad Research Project, 2026**  
**Authors:** Computational Linguist Agent, Jeffrey Snover

---

## 1. The Problem

### 1.1 System Context

AI Triad Research is a multi-perspective analysis platform for AI policy and safety. At its core is a **taxonomy** — a structured ontological knowledge base representing three ideological perspectives on AI governance:

- **Accelerationist** (185 nodes) — advocates for rapid AI deployment with minimal regulatory friction
- **Safetyist** (268 nodes) — emphasizes precautionary governance, accountability, and harm prevention
- **Skeptic** (256 nodes) — questions institutional capacity to govern AI and highlights knowledge limitations

Each perspective is organized using the **BDI (Beliefs, Desires, Intentions)** cognitive architecture from the Bratman model. Every node represents a specific Belief, Desire, or Intention within one perspective's worldview, formalized using **DOLCE (Descriptive Ontology for Linguistic and Cognitive Engineering)** vocabulary and a genus-differentia definitional pattern.

A typical taxonomy node description looks like this:

> **saf-beliefs-126** — *Ambiguity of Responsibility for AI Actions*
>
> "A Belief within safetyist discourse that explores the inherent difficulty in assigning clear responsibility when AI systems cause harm. Encompasses: The challenge of distributing blame among various human actors like owners, users, and designers, leading to a lack of clear accountability. Excludes: Specific solutions for assigning responsibility, such as Human-AI Accountability Frameworks or AI Legal Actor Framework."

The platform also runs **structured debates** between AI agents, each embodying one perspective and arguing from their portion of the taxonomy. During debates, agents produce natural-language **claims** — argumentative assertions grounded in their worldview. A typical claim:

> "Absent ex ante rule-making, no named actor bears responsibility when AI harms a student."
>
> — Safetyist, attributed to saf-beliefs-126 (similarity: 0.54)

### 1.2 The Matching Problem

After each debate turn, the system must **attribute** each extracted claim to the taxonomy node it most closely corresponds to. This attribution serves multiple purposes:

1. **Grounding verification** — confirming that debaters are arguing from their taxonomy rather than hallucinating positions
2. **Argument network construction** — building a graph of which nodes are in play, creating support/attack edges between claims
3. **Coverage analysis** — identifying which parts of each perspective's worldview are being engaged vs. ignored
4. **Calibration metrics** — measuring debate quality through attribution rates and taxonomy coverage

Attribution works by computing **cosine similarity** between the embedding vector of each claim and the embedding vectors of all candidate taxonomy nodes within the same perspective. The highest-scoring node above a threshold (0.35) becomes the attributed node.

### 1.3 The Register Gap

The fundamental challenge is that claims and taxonomy nodes exist in **different linguistic registers**:

| Property | Taxonomy Nodes (DOLCE) | Debate Claims |
|----------|----------------------|---------------|
| Register | Formal ontological | Informal argumentative |
| Structure | Genus-differentia definitions | Natural rhetorical assertions |
| Vocabulary | "A Belief within X discourse that posits..." | "Under-investment in safety is a false economy..." |
| Specificity | Abstract category descriptions | Concrete examples and evidence |
| Length | ~75 tokens average | ~33 tokens average |

This is not a standard information retrieval problem. It is an **asymmetric cross-register matching** problem: mapping informal, concrete, rhetorically-charged debate text onto formal, abstract, ontologically-structured category descriptions. The embedding model must learn that "Absent ex ante rule-making, no named actor bears responsibility when AI harms a student" is semantically equivalent to "A Belief within safetyist discourse that explores the inherent difficulty in assigning clear responsibility when AI systems cause harm" — despite sharing almost no vocabulary.

### 1.4 Baseline Performance

Using the production embedding model (**all-MiniLM-L6-v2**, 22M parameters, 384 dimensions), baseline performance against a golden test set of 515 manually-attributed claims was:

| Metric | Value |
|--------|-------|
| Top-1 accuracy | 7.4% |
| Mean Reciprocal Rank (MRR) | 0.1558 |
| Mean similarity score | 0.497 |
| Claims in ambiguous zone (0.35–0.50) | 54.8% |
| Claims below threshold (<0.35) | ~12% |

The candidate pool for each claim is 76–165 same-perspective Belief nodes. A Top-1 of 7.4% means the correct node is the highest-ranked candidate only 7.4% of the time. An MRR of 0.1558 means the correct node is, on average, ranked around position 6–7. This is poor retrieval performance by any standard.

### 1.5 Illustrative Examples

To make the register gap concrete, here are three claim-to-node matchings from the golden set:

**Example 1 — High similarity (0.54):**
- **Claim:** "Absent ex ante rule-making, no named actor bears responsibility when AI harms a student."
- **Node (saf-beliefs-126):** "A Belief within safetyist discourse that explores the inherent difficulty in assigning clear responsibility when AI systems cause harm. Encompasses: The challenge of distributing blame among various human actors like owners, users, and designers..."
- **Analysis:** Both discuss responsibility gaps in AI harm. The claim uses a concrete scenario (student, rule-making); the node describes the abstract category. Shared concepts (responsibility, harm, accountability) provide enough signal for a moderately high score.

**Example 2 — Low similarity (0.37):**
- **Claim:** "When universities raced to deploy remote proctoring software during the 2020 pandemic, they faced lawsuits over privacy violations and biased facial recognition."
- **Node (saf-beliefs-062):** "A Belief within safetyist discourse that describes the malicious strategy of feeding deceptive content into AI training data via web crawlers, leading to altered AI knowledge and user understanding."
- **Analysis:** This is a likely misattribution. The claim discusses privacy and bias in deployment; the node discusses training data poisoning. With a similarity of 0.37 (barely above threshold), the correct node probably exists elsewhere in the taxonomy, but the model lacks the discriminative capacity to find it. This illustrates the failure mode: both texts involve AI harms, so they share broad semantic space, but they address fundamentally different mechanisms.

**Example 3 — Moderate similarity (0.50):**
- **Claim:** "The CSU Chancellor's Office's interim guidelines, pairing faculty oversight committees with real-time data dashboards, show that accountability can be built into rapid deployment — not held hostage by static rule-making."
- **Node (acc-beliefs-034):** *(Accelerationist node about adaptive governance)*
- **Analysis:** The claim uses a concrete institutional example (CSU Chancellor's Office, faculty oversight committees, data dashboards) to argue for a general principle. The embedding model must generalize from these specifics to the abstract category. At 0.50, it partially succeeds.

---

## 2. Embedding Architecture

### 2.1 Model

The production embedding model is **all-MiniLM-L6-v2** from the sentence-transformers library:
- 22 million parameters
- 6 transformer layers
- 384-dimensional output vectors
- 128-token maximum sequence length
- Trained on over 1 billion sentence pairs from diverse web sources

This model was chosen for its balance of quality and efficiency — it runs locally via ONNX runtime in the Electron application with <10ms inference per embedding.

### 2.2 Taxonomy Node Embedding

Each taxonomy node is embedded using a **weighted multi-field composition** of up to five textual fields:

| Field | Weight | Source |
|-------|--------|--------|
| **description** | 0.8 | Node description with "Excludes:" clause stripped |
| **assumes** | 0.2 | Concatenated assumption statements from graph attributes |
| lineage | 0.0 | Intellectual lineage category labels |
| epistemic_type | 0.0 | E.g., "normative prescription" |
| rhetorical_strategy | 0.0 | E.g., "techno-optimism" |

Each field is embedded independently, then combined via weighted sum:

```
vector = 0.8 * embed(description) + 0.2 * embed(assumes)
```

A single L2 normalization is applied to the combined vector (not per-field), preserving weight ratios.

### 2.3 The "Excludes:" Clause

Node descriptions follow a genus-differentia pattern that ends with an **Excludes clause** — a statement of what the node explicitly does NOT cover:

> "...Encompasses: resource abundance, climate stabilization, universal healthcare. **Excludes: The military application of AI and the architectural proposition of AI as a civilizational operating system.**"

The Excludes clause serves as a **semantic boundary marker** for classification. During embedding, it is processed in two ways:

1. **Stripped from the main embedding** — the regex `\s*Excludes:\s*.*` removes everything from "Excludes:" onward before computing the main vector. This prevents the embedding from partially representing concepts the node disclaims.

2. **Embedded separately as an `exclusion_vector`** — the excluded text is extracted and embedded independently for downstream scope violation detection.

### 2.4 Claim Embedding

Claims extracted during debates are embedded using the same all-MiniLM-L6-v2 model, but as **raw text** — no structural decomposition, no field weighting. The claim text is embedded as-is.

---

## 3. Experimental Methodology

### 3.1 Golden Test Set

We constructed a golden test set from 20 production debates containing 515 claims with existing attributions. Each entry contains:

- The raw claim text
- The speaker identity (accelerationist, safetyist, or skeptic)
- The attributed taxonomy node ID
- The similarity score at attribution time
- Secondary reference nodes (top-5 candidates)

The golden set spans 175 unique taxonomy nodes across all three perspectives.

**Limitation:** These attributions were generated by the production system itself (not human-verified). Some may be incorrect, particularly in the low-similarity range (0.35–0.50). We acknowledge this as a potential confound — a separate ground truth validation effort (t/511) is planned but not yet complete.

### 3.2 Evaluation Metrics

All experiments report:

- **Top-1 accuracy** — percentage of claims where the correct node is the highest-ranked candidate
- **Top-3 accuracy** — correct node appears in the top 3
- **Mean Reciprocal Rank (MRR)** — the average of 1/rank for the correct node across all claims. MRR = 1.0 means the correct node is always rank 1; MRR = 0.5 means it averages rank 2.
- **Mean similarity** — average cosine similarity between claims and their attributed nodes
- **Novel rate** — percentage of claims where no candidate exceeds the 0.35 attribution threshold (higher = worse)

### 3.3 Experimental Protocol

Each experiment follows the same structure:

1. **Modify one variable** (embedding input text, model, retrieval method, or weight configuration)
2. **Re-embed** all affected vectors using the same sentence-transformers library
3. **Evaluate** against the full 515-claim golden set using same-POV candidate retrieval
4. **Compare** against the production baseline on all metrics

All experiments use the same golden set, same candidate pools, and same evaluation code for direct comparability.

---

## 4. Preliminary Analysis

### 4.1 Specificity Analysis

Before designing experiments, we characterized the textual properties of both claims and taxonomy nodes using a specificity analysis (`_specificity_analysis.py`) across all 515 golden set claims and 366 Belief node descriptions:

| Metric | Taxonomy Nodes | Claims |
|--------|---------------|--------|
| Mean token length | 75.3 | 33.3 |
| Tokens >128 (truncated by model) | 1.4% | 0.8% |
| Mean named entities + numbers | 0.67 | 0.35 |
| Zero named entities/numbers | 65.3% | 85.0% |

**Key finding:** The specificity gap is **inverted** from our initial assumption. Taxonomy nodes are *more* specific than claims, not less. 85% of claims contain no named entities, numbers, or concrete instances. Token truncation affects only 1.4% of nodes. These factors are not the primary bottleneck.

The real gap is **register and abstraction level**: taxonomy nodes use formal DOLCE language while claims use natural debate rhetoric. The model must bridge this gap with only 384 dimensions and 22M parameters.

### 4.2 Vocabulary Overlap Analysis

BM25 keyword retrieval (Experiment H5) provided a quantitative measure of vocabulary overlap:

- **BM25-only Top-1:** 3.1% (vs. 7.9% for embeddings)
- **BM25 and cosine agree on Top-1:** only 10.5% of the time

This confirms that claims and taxonomy nodes use **fundamentally different vocabulary** for the same concepts. Keyword-based matching alone is nearly useless; semantic embeddings provide the only viable signal, but that signal is weak.

---

## 5. Experiments

### Round 1: POV Node Embedding Variants

**Question:** Which textual representation of taxonomy nodes produces the best embedding for claim matching?

We tested five variants of the text used to embed each POV node, keeping claim embeddings constant:

| Variant | Input Text | MRR | Top-1 | vs. Baseline |
|---------|-----------|-----|-------|--------------|
| **A** (baseline) | Full description, Excludes stripped | 0.1718 | — | — |
| **B** (with Excludes) | Full description including Excludes clause | **0.1847** | +1.3% | **+0.013** |
| **C** (differentia only) | Just the core differentia, no Encompasses/Excludes | 0.1387 | — | -0.033 |
| **D** (label + differentia) | Node label prepended to differentia | 0.1435 | — | -0.028 |
| **G** (+ adversarial edges) | Description + text from cross-POV attack edges | 0.1397 | — | -0.032 |

**Finding:** Variant B (retaining the Excludes clause) wins decisively at MRR 0.1847. This was surprising — we had been stripping Excludes from the embedding input under the assumption that negative boundaries would confuse the vector space. Instead, the Excludes clause provides useful **contrastive signal** that helps the model distinguish between similar nodes. Stripping down to differentia-only (C) or adding adversarial edges (G) both hurt by reducing the descriptive richness.

**Shipped change:** Restored Excludes clause to the embedding input (t/513). Note: a separate exclusion_vector is still generated for downstream boundary checking.

### Round 2: Claim-Side Variants

**Question:** Does transforming claim text before embedding improve matching?

Using the winning POV variant (B, with Excludes), we tested four claim text variants:

| Variant | Claim Transformation | MRR | vs. B×i |
|---------|---------------------|-----|---------|
| **B×i** (baseline) | Raw claim text, no modification | **0.1847** | — |
| **B×ii** (decontextualized) | Filler words, hedges, and connectives removed via regex | 0.1737 | -0.011 |
| **B×iii** (BDI-tagged) | "Belief: " prefix prepended | 0.1634 | -0.021 |
| **B×iv** (POV-prefixed) | "Accelerationist belief: " prefix prepended | 0.1382 | -0.047 |

**Finding:** Every transformation hurts. Raw claim text is the best input. BDI and POV prefixes bias the embedding toward the prefix tokens rather than the semantic content. Even lightweight decontextualization removes vocabulary that the model uses for matching. The "rhetorical scaffolding" in claims — hedges, connectives, debate references — actually carries useful signal.

### Round 3: Field Weight Optimization

**Question:** What is the optimal weighting between the description field and the assumes field?

We tested five weight configurations for the two non-zero fields:

| Config | Description Weight | Assumes Weight | MRR | vs. W1 |
|--------|-------------------|----------------|-----|--------|
| W1 (original) | 0.611 | 0.389 | 0.1558 | — |
| W2 (desc only) | 1.0 | 0.0 | 0.1522 | -0.004 |
| **W3 (shipped)** | **0.8** | **0.2** | **0.1604** | **+0.005** |
| W4 | 0.9 | 0.1 | 0.1556 | 0.000 |
| W5 | 0.7 | 0.3 | 0.1541 | -0.002 |

**Finding:** The 0.8/0.2 split (W3) is optimal. The assumes field provides complementary signal (assumption statements use slightly different vocabulary than the description), but the original 0.611/0.389 split over-weighted it. The description field is the primary semantic carrier.

**Shipped change:** Updated field weights from 0.611/0.389 to 0.8/0.2 (t/519).

### H6: Label Removal

**Question:** Does prepending the node label to the description before embedding help or hurt?

During Round 1–2, we did not prepend labels and achieved MRR 0.1847. During Round 3, labels were prepended by default, and the best result was MRR 0.1604. Removing the label prepending produced the final shipped configuration.

**Finding:** Node labels are short, title-like phrases (e.g., "Regulatory Friction and Market Failures as Drivers of Inequality") that dominate the first tokens of the embedding input. The model attends disproportionately to early tokens, so the label's vocabulary biases the entire embedding toward its phrasing rather than the rich description that follows.

**Shipped change:** Removed label prepending from embedding pipeline (t/516).

### H1: Cross-Encoder Re-Ranking

**Hypothesis:** Bi-encoder cosine similarity compresses each text independently. A cross-encoder that attends to both texts jointly should dramatically improve ranking by enabling token-level interaction between claim and node text.

**Method:** Used the production bi-encoder to retrieve top-20 candidates per claim, then re-ranked using `cross-encoder/ms-marco-MiniLM-L-6-v2`.

| Method | Top-1 | MRR | Mean Score |
|--------|-------|-----|------------|
| Bi-encoder (baseline) | 7.2% | 0.1608 | 0.470 |
| Cross-encoder re-rank | 3.9% | 0.1301 | -6.369 |

**Finding: FAILED.** The cross-encoder performed dramatically worse. The ms-marco model was trained on web search queries matched to documents — a different domain from ontological-description-to-claim matching. The negative mean scores indicate the model found nearly all claim-node pairs to be poor matches by its learned criteria. A domain-appropriate cross-encoder might work, but no off-the-shelf model exists for this task.

### H2: Larger Embedding Models

**Hypothesis:** MiniLM's 22M parameters and 384 dimensions lack the capacity to capture the semantic nuance needed to distinguish 76–165 similar nodes. Larger models with more dimensions should improve discrimination.

| Model | Parameters | Dimensions | Top-1 | MRR |
|-------|-----------|------------|-------|-----|
| **all-MiniLM-L6-v2** | **22M** | **384** | **9.3%** | **0.1640** |
| all-mpnet-base-v2 | 110M | 768 | 2.7% | 0.1005 |
| BAAI/bge-large-en-v1.5 | 335M | 768 | 6.2% | 0.1249 |

**Finding: FAILED.** MiniLM outperforms models 5–15x larger. Model capacity is not the bottleneck. Larger models have more dimensions to capture nuance, but they were trained on the same general web text. Without domain-specific training data for ontology-to-rhetoric mapping, additional capacity provides no benefit and may even overfit to surface-level features that diverge between registers.

### H5: BM25 Hybrid Retrieval

**Hypothesis:** Keyword overlap and semantic similarity capture different signal. Fusing BM25 scores with cosine similarity should improve retrieval when claims share specific terms with node descriptions.

| Method | Top-1 | MRR |
|--------|-------|-----|
| Cosine only | 7.9% | 0.1533 |
| BM25 only | 3.1% | 0.0846 |
| Linear fusion (alpha=0.9, best) | 7.4% | 0.1456 |
| Reciprocal Rank Fusion (k=60) | 5.0% | 0.1124 |

**Finding: FAILED.** BM25 alone achieves only 3.1% Top-1, confirming the extreme vocabulary gap. Every fusion strategy performs worse than cosine-only. BM25's noise (matching incidental shared words) dilutes the embedding signal rather than complementing it.

### H4: LLM Claim Abstraction

**Hypothesis:** Claims contain rhetorical scaffolding that adds noise. Using an LLM to extract the core abstract proposition should produce text that more closely resembles the formal style of taxonomy nodes.

**Method:** Gemini 2.5 Flash (temp=0) extracted core propositions from all 515 claims. Example:

| Original Claim | Core Proposition |
|----------------|-----------------|
| "Stanford's 2023 Foundation Model Transparency Index scored the top ten developers an average of 37 out of 100 — a damning indictment that the market alone cannot produce adequate transparency." | "Market forces alone cannot produce adequate AI transparency." |
| "Under-investment in safety is a false economy, and strict liability corrects that market failure." | "Strict liability corrects the market failure of under-investment in AI safety." |

Three variants were tested:

| Variant | Input | Top-1 | MRR | Novel Rate |
|---------|-------|-------|-----|------------|
| Baseline | Raw claim | 8.7% | 0.1632 | 12.6% |
| **H4a** | Core proposition only | 3.5% | 0.1018 | 24.3% |
| **H4b** | Proposition + original concatenated | 6.2% | 0.1369 | 6.0% |
| **H4c** | "Belief: " + proposition | 2.7% | 0.0794 | 8.2% |

**Finding: FAILED.** All variants degrade performance. The most revealing metric is the **novel rate**: H4a produces claims where 24.3% fall below the 0.35 threshold (vs. 12.6% baseline) — the abstracted propositions are too generic to match any node. The LLM produces valid abstractions, but the embedding model cannot match "Market forces alone cannot produce adequate AI transparency" against "A Belief within safetyist discourse that posits market mechanisms are insufficient for ensuring transparency" any better than it matches the original claim. The embedding space simply does not capture this semantic equivalence.

### H9: Matryoshka Representation Learning (MRL)

**Hypothesis:** MRL-trained models encode coarse semantics in early dimensions and fine detail in later ones. If the register gap is a "too much detail" problem, truncating to lower dimensions might improve matching by discarding register-specific noise.

**Model:** nomic-ai/nomic-embed-text-v1.5 (768-dim, MRL-capable)

| Dimensions | Top-1 | MRR | vs. Full |
|-----------|-------|-----|----------|
| 768 (full) | 4.5% | 0.1127 | — |
| 512 | 4.8% | 0.1106 | -0.002 |
| 256 | 4.7% | 0.1066 | -0.006 |
| 128 | 2.9% | 0.0896 | -0.023 |
| 64 | 4.1% | 0.0934 | -0.019 |

**Finding: FAILED.** Truncation uniformly hurts. The coarse semantic features in early dimensions are not more useful than the full representation. The register gap is not a dimensionality problem — it is a domain knowledge problem. (Note: the nomic model itself underperforms MiniLM at full dimensions, confirming H2's finding that larger general-purpose models don't help.)

---

## 6. Cumulative Results

### 6.1 Shipped Improvements

Three changes from the positive experiments were shipped to production:

| Change | Ticket | MRR Impact |
|--------|--------|------------|
| Restore Excludes in node embedding input | t/513 | +0.013 |
| Remove label prepending | t/516 | +0.007 |
| Adjust field weights to 0.8/0.2 | t/519 | +0.008 |
| **Total** | | **+0.028 MRR (+18%)** |

Production performance improved from **MRR 0.1558 / Top-1 7.4%** to **MRR 0.1834 / Top-1 10.5%** — a 42% relative improvement in Top-1 accuracy.

### 6.2 Summary of All Experiments

| Experiment | Approach | Result | MRR Delta |
|-----------|----------|--------|-----------|
| Round 1 (B) | Include Excludes clause | **Shipped** | +0.013 |
| Round 3 (W3) | Optimize field weights 0.8/0.2 | **Shipped** | +0.005 |
| H6 | Remove label prepending | **Shipped** | +0.007 |
| H1 | Cross-encoder re-ranking | Failed | -0.031 |
| H2 | Larger embedding models | Failed | -0.039 to -0.064 |
| H4 | LLM claim abstraction | Failed | -0.026 to -0.084 |
| H5 | BM25 hybrid fusion | Failed | +0.000 |
| H9 | Matryoshka truncation | Failed | -0.002 to -0.023 |
| Round 2 (ii) | Decontextualize claims | Failed | -0.011 |
| Round 2 (iii) | BDI-tag claims | Failed | -0.021 |
| Round 2 (iv) | POV-prefix claims | Failed | -0.047 |

---

## 7. Conclusions

### 7.1 What We Learned

**Six hypotheses failed.** The pattern across these failures reveals a fundamental insight: **no transformation of either input independently can bridge the register gap.** Whether we modify the taxonomy node text (Round 1 variants C, D, G), the claim text (Round 2, H4), the model (H2, H9), or the retrieval method (H1, H5), the core problem persists: the embedding model has never seen enough examples of formal-ontological-description paired with informal-debate-rhetoric to learn that they are semantically equivalent.

The three changes that *did* help (Excludes, label removal, weight tuning) are not bridging the register gap — they are **reducing noise** in the existing signal. Excludes adds contrastive boundary information. Label removal prevents short titles from dominating the embedding. Weight reduction of the assumes field prevents complementary-but-noisy text from diluting the primary description signal. These are ceiling-raising optimizations within the current architecture, not solutions to the fundamental problem.

### 7.2 Key Negative Findings

1. **Model capacity is not the bottleneck.** MiniLM (22M params) outperforms models 5–15x larger. The issue is domain knowledge, not encoding capacity.

2. **Dimensionality is not the bottleneck.** Matryoshka truncation does not help. Coarse semantic features are not more useful than fine-grained ones.

3. **Vocabulary overlap is near-zero.** BM25 and cosine agree on the top candidate only 10.5% of the time. Claims and taxonomy nodes use fundamentally different words.

4. **Claim transformation destroys signal.** Both LLM abstraction and surface-level cleanup hurt accuracy. The rhetorical scaffolding in claims carries vocabulary that MiniLM exploits for matching.

5. **Off-the-shelf cross-encoders don't transfer.** Web search re-rankers have no understanding of ontological description structures.

### 7.3 The Path Forward

The only remaining hypothesis with strong theoretical justification is **H8: Contrastive Fine-Tuning** — teaching MiniLM our specific domain mapping by training on (claim, correct-node) positive pairs with hard negative mining from same-perspective non-attributed nodes.

This is fundamentally different from all failed approaches: instead of changing the inputs to look more similar, we change the **similarity function itself**. Fine-tuning with MultipleNegativesRankingLoss would teach the model that "Absent ex ante rule-making, no named actor bears responsibility when AI harms a student" and "A Belief within safetyist discourse that explores the inherent difficulty in assigning clear responsibility when AI systems cause harm" should be close in embedding space — not because they share vocabulary, but because we have observed them to co-occur.

**Prerequisites:**
- Ground truth validation (t/511) — the 515 golden set pairs are system-generated, not human-verified. Training on incorrect pairs would teach the wrong mapping.
- Cross-validation protocol — with only 515 pairs, 5-fold cross-validation is essential to measure generalization.
- Regularization strategy — early stopping, learning rate warmup, and dropout to prevent overfitting on a small dataset.

### 7.4 Current State

The system operates at **MRR 0.1834 / Top-1 10.5%** after three shipped optimizations. The correct taxonomy node is the top-ranked candidate roughly one in ten times, and is within the top ~5 positions on average. This is sufficient for the system's current needs (debate grounding uses secondary references and threshold-based attribution), but represents a significant opportunity for improvement through domain-specific model training.

---

## Appendix A: Tooling and Reproducibility

All experiments were conducted using Python scripts in `research/comp-linguist/`:

| Script | Purpose |
|--------|---------|
| `_build_golden_set.py` | Extract 515 claims with attributions from 20 debates |
| `_run_round1.py` | Round 1: POV node embedding variants |
| `_run_round2.py` | Round 2: Claim-side variants |
| `_run_round3.py` | Round 3: Field weight optimization |
| `_run_h1_crossencoder.py` | H1: Cross-encoder re-ranking |
| `_run_h2_model_comparison.py` | H2: Larger embedding models |
| `_run_h2_nomic_mrl.py` | H9: Matryoshka truncation |
| `_run_h4_llm_abstraction.py` | H4: LLM claim abstraction |
| `_run_h5_bm25_hybrid.py` | H5: BM25 hybrid fusion |
| `_specificity_analysis.py` | Preliminary specificity characterization |
| `_validate_embeddings.py` | Post-change embedding validation |
| `scripts/embed_taxonomy.py` | Production embedding generation pipeline |

Results are stored in JSON files (`_h*_results.json`, `_round*_results.json`) alongside the scripts. The golden test set is `_golden_test_set.json` (515 claims, 175 unique nodes).

## Appendix B: Embedding Model Details

**all-MiniLM-L6-v2** (sentence-transformers)
- Architecture: 6-layer MiniLM with knowledge distillation from a 12-layer teacher
- Dimensions: 384
- Max sequence length: 128 tokens (WordPiece)
- Training data: 1B+ sentence pairs from NLI, paraphrase, and web sources
- Normalization: L2-normalized output vectors (unit sphere)

Production deployment: ONNX runtime in an Electron application (taxonomy-editor) for real-time debate attribution, plus Python sentence-transformers for batch embedding generation.
