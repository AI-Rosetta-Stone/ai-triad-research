# Synthetic Statement Corpus for POV Embedding Matching: Review Request

*We welcome critique of every aspect of this plan. Prior reviewer feedback is in Appendices A–D. Reviewer 4 (Appendix D) challenges two upstream assumptions that the earlier consensus did not question — read it before assuming the plan is settled.*

## 1. Project Context

AI Triad Research is a multi-perspective research platform for AI policy and safety discourse (2026). The project maintains a **taxonomy** of positions organized by three points of view (POVs):

- **Accelerationist** (acc) — pro-development, techno-optimist positions
- **Safetyist** (saf) — safety-first, risk-mitigation positions  
- **Skeptic** (skp) — structural-critique, power-analysis positions

Each POV camp contains nodes classified into **BDI categories** (Beliefs, Desires, Intentions), following the Belief-Desire-Intention cognitive architecture. Node IDs follow the pattern `{pov}-{category}-{NNN}` (e.g., `acc-beliefs-003`, `saf-desires-001`).

The taxonomy currently contains **~636 nodes** across the three POVs. Nodes follow DOLCE upper-ontology alignment and genus-differentia description patterns.

The project also runs a **three-agent debate system** where AI agents roleplay the Accelerationist, Safetyist, and Skeptic perspectives. Debates produce **argument networks** — graphs of claims, supports, contradictions, and other relationships. A critical downstream task is **attributing each debate claim to the taxonomy node it most closely represents**.

**Important context (Reviewer 4):** The claims being attributed are *machine-generated* by three fixed LLM personas, not drawn from diverse human discourse. This has implications for what register space the synthetic corpus actually needs to cover — see section 5.1.

## 2. The Problem

**Claim-to-POV node attribution via embeddings is imprecise.** The current system embeds both claims and taxonomy nodes using all-MiniLM-L6-v2 (384-dim) and matches via cosine similarity. Current performance:

- **Mean Reciprocal Rank (MRR): ~0.354** — the correct node is often not the top match
- Attribution is scoped to within-POV matching (a claim by the Accelerationist agent only matches against `acc-*` nodes), which helps but is insufficient

### What We Tried: Canonical Propositions (Failed)

We hypothesized that debate claims fail to match because they use varied registers — colloquial language, rhetorical flourishes, domain jargon — while node descriptions use formal academic register. We generated **canonical propositions** (register-normalized restatements) for each claim using an LLM, then embedded those instead.

**Result: MRR dropped from 0.354 to 0.267 (-24.5%).** Register normalization *removes* the very information that makes embeddings discriminative: specific entity names, evidential anchors, discourse markers, and rhetorical vocabulary. The specificity of raw language is more informative than cleaned-up paraphrases.

### Why This Matters

Accurate attribution is foundational. It determines which taxonomy nodes "participate" in debate analysis, which nodes get situation-injection priority, and how we measure whether debates are engaging the actual taxonomy structure versus talking past it. At MRR ~0.35, roughly two-thirds of claims are attributed to a non-optimal node on the first match.

## 3. Proposed Solution: Synthetic Statement Corpus

Instead of normalizing the **source** side (claims → canonical form), we propose expanding the **target** side: generate a corpus of synthetic statements for each taxonomy node that cover the range of registers and vocabularies real claims might use.

### Core Idea

For each of the ~636 POV nodes, generate **~40 synthetic statements** using a **generate-and-prune** strategy: generate 45–50 candidate statements, embed them, run poaching analysis against neighboring nodes, and prune boundary-violating or redundant statements down to ~40 keepers. This budget accommodates the hybrid diversity scheme (archetype-primary + audience-secondary) with enough headroom for individual-assumption seeding and disagreement contrastives.

Each statement should express a specific facet of the POV node as it would naturally appear in debate discourse. The goal is to create an **embedding surface** around each node that captures the vocabulary and register space that real claims actually occupy — not the full breadth of human discourse, but the region where machine-generated debate claims land (see §5.0b).

### Retrieval Strategy: Multi-Vector Max-Similarity

For each node, embed all ~40 synthetic statements **plus the original node description** (41 vectors per node, ~26,000 total). When an agent claim comes in, compute:

```
Similarity(Claim, Node) = mean of top-3 ( cos(E_claim, E_vector_i) for i in {1..41} )
```

**Why mean-of-top-N, not max-sim?** Max-similarity is winner-take-all: a single synthetic vector that drifts into a neighbor's territory can poach every claim near that boundary point. Mean-of-top-3 requires **cluster density** — a node must have multiple vectors near a claim to score highly. A single rogue vector contributes only 1/3 of the score, making the metric naturally robust to generation noise and boundary violations. This is one of the strongest mitigations against **neighbor collapse** (see §5.7): attribution depends on consistent, broad coverage of a semantic region rather than single-point proximity. The expanded 40-vector budget makes top-3 viable without sacrificing recall on niche facets.

The pilot should compare max-sim vs. mean-of-top-3 vs. mean-of-top-5 and report MRR, per-node poaching rates, and disagreement cases under each strategy.

Since retrieval is scoped to within-POV matching (~200 nodes x 41 vectors = ~8,200 vectors per claim), exact k-NN via NumPy runs in milliseconds with no vector DB infrastructure needed (~40 MB at 384-dim float32). Store the 41 vectors per node in a single array per POV with a metadata index (node_id + statement archetype or "description"). Retrieval is then a matrix multiply + grouped top-3 mean.

**Scaling path:** At current taxonomy size, stay with exact NumPy. If the taxonomy grows past ~800-1,000 nodes (~40K vectors), add a lightweight FAISS IVF or HNSW index with exact re-ranking on top-50 candidates.

**Why not centroids?** All four reviewers agree. Averaging 40 register-diverse vectors in a 384-dimensional space causes **topological collapse** — a "bland average" centroid that drifts toward the geometric center, losing discriminative boundaries and matching high-frequency noise. Multi-vector preserves each register's distinct geometric position.

### Generation Strategy

**Two models for diversity:** Gemini Flash and Claude Sonnet. Using two model families ensures vocabulary diversity — a single model might converge on similar phrasings. Temperature: 1.0 for maximum lexical variety.

**Model assignment (OPEN — R4 challenge):** The original design assigned Gemini to general/journalist/technical and Sonnet to policymaker/academic, but Reviewer 4 argues this perfectly confounds model identity with audience/archetype. If one register outperforms, you can't tell whether it's the register or the model. **Proposed fix:** Randomize model-to-archetype assignment, or have both models generate everything and select the more diverse output per node. The pilot should resolve whether model identity matters enough to warrant the extra cost of dual generation.

**Per-POV files:** The corpus is split into one file per POV camp (`synthetic_corpus_acc.json`, `synthetic_corpus_saf.json`, `synthetic_corpus_skp.json`) to keep file sizes manageable.

#### Diversity Axis: Emerging Consensus Toward Hybrid

Including all rich fields in a single monolithic prompt causes **prompt dilution** and model convergence. Four reviewers have weighed in on how to organize the ~40 statements per node:

- **Reviewer 1** proposed organizing by **target audience** (5 audiences x 4 each) — stylistic diversity
- **Reviewer 2** proposed organizing by **semantic archetype** (7 statement types) — semantic diversity
- **Reviewer 3** endorsed archetypes as clearly superior for embedding discrimination but recommended a **hybrid**: archetype-primary with audience modulation as secondary

**Approach C: Hybrid (Reviewer 3 — Emerging Consensus)**

| Component | Count | What |
|---|---|---|
| **Primary: Archetype-driven** | 25–30 | Surface claim (4-5), assumption expression (5-7 — individual assumptions seeded separately), policy implication (4-5), intellectual lineage framing (3-4), defensive formulation (3-4), real-world example (3-4), counterargument response (3-4) |
| **Secondary: Audience-modulated** | 8–12 | Register overlays on the strongest archetypes (especially policy implication and defensive formulation), varying audience within 3-4 core archetypes |
| **Disagreement contrastives** | 2–4 | Generated for high-confusion node pairs — explicit distinguishing statements that separate this node from its most confusable neighbor |
| **Generate-and-prune buffer** | +5–10 | Generate 45-50 candidates total; embed and run poaching analysis; prune boundary-violating or redundant statements to ~40 keepers |

Each archetype draws on specific node fields:

| Archetype | Primary Rich Fields | What it captures |
|---|---|---|
| **Surface claim** | `label`, `description` | The explicit position as stated |
| **Assumption expression** | `assumes` (individual assumptions, not the whole set) | Underlying premises that real claims often invoke directly |
| **Policy implication** | `policy_actions`, `framing` | Concrete regulatory/governance language from debates |
| **Intellectual lineage framing** | `intellectual_lineage` | Tradition-specific vocabulary and conceptual anchors |
| **Defensive formulation** | `steelman_vulnerability` | Acknowledges and rebuts the strongest counterargument |
| **Real-world example** | `description` (Encompasses) | Concrete instances and scenarios |
| **Counterargument response** | `possible_fallacies`, `rhetorical_strategy` | Positioned against opposing views |

**Rationale for hybrid:** Reviewer 3 argues that stylistic/register variants of the *same* proposition land close together in 384-dim space — all-MiniLM-L6-v2's geometry is not rich enough to treat "conversational" vs. "scholarly" as orthogonal when the propositional content is identical. Archetypes express genuinely different *facets* of the node (surface claim vs. assumption vs. policy implication), expanding the embedding surface in directions that matter for inter-node separation. Audience modulation on the strongest archetypes adds register coverage without dominating. The expanded 40-statement budget gives individual assumptions enough headroom to be seeded separately (the single strongest lever identified across all four reviews) while preserving dedicated slots for disagreement contrastives and a prune buffer for poaching control.

**We welcome critique of this hybrid allocation. Is the 25-30 / 8-12 archetype/audience split correct? Should any archetypes be dropped or added? Is the 2-4 contrastive allocation sufficient for high-confusion pairs?**

#### Field Value Ranking (Reviewer 2 + Reviewer 3 Consensus)

| Field | Value | Usage guidance |
|---|---|---|
| `assumes` | Extremely high | Generate *from individual assumptions* (or small clusters), not the whole set as a blob. Each major assumption can seed 1-2 statements. This is where the most discriminative lexical material lives ("correlated failures", "telemetry", "semantic intent validation") |
| `policy_actions` | Extremely high | Debate participants discuss regulations, subsidies, and treaties — not abstract beliefs. Policy language is what claims actually sound like |
| `epistemic_type` | High | Different types generate different linguistic forms (empirical: "evidence shows"; normative: "we should"; strategic: "we must implement"). Include in every prompt as tonal guidance |
| `intellectual_lineage` | High | Injects tradition-specific vocabulary as lexical retrieval anchors ("distributive justice", "defense in depth", "longtermism") |
| `rhetorical_strategy` | Medium-high | Useful as style guidance, especially for audience-modulated variants |
| `steelman_vulnerability` | Medium | Use *only* for defensive formulation archetype. Can also seed "nuanced positive" statements ("Even granting that correlated failures remain possible, the layered approach still...") but NOT for pure positive surface claims |
| `emotional_register` | Medium | Register modulation for audience variants |
| `possible_fallacies` | Low | Only for counterargument response archetype |
| `confidence` / `confidence_history` | Do not inject | Risks introducing artificial hedging language that real claims rarely use. `epistemic_type` already provides the right tonal signal |

#### Shared Design Elements (All Reviewers Agree)

- All statements receive `label` + `description` + `epistemic_type` as base context
- The `Excludes:` clause is injected as a **hard negative constraint** to prevent cross-node collision
- **Neighbor-aware prompts (Reviewer 3):** List the 2-4 most confusable neighboring nodes (by current embedding proximity or graph proximity) and instruct: "Generate statements that express THIS node's position AND NOT the neighboring positions X, Y, Z." This directly attacks neighbor collapse
- **Disagreement contrastives (Reviewer 3):** For node pairs where top-1 and top-2 attribution are close (high confusion pairs), generate explicit distinguishing statements for *both* nodes. This is one of the highest-leverage mitigations for neighbor collapse
- Temperature 1.0 for lexical variety
- **41st vector (Reviewer 3):** Include the original node `description` embedding alongside the ~40 synthetic embeddings. It serves as the semantic prototype/anchor — real claims sometimes match the canonical description more closely than any synthetic variant

#### Generate, Prune, and Regenerate

The generate-and-prune pipeline is not a one-shot filter — it's a self-correcting cycle that uses pruning data to improve the next generation round:

1. **Generate:** Produce 45-50 candidate statements per node using the archetype/audience allocation and neighbor-aware prompts.
2. **Embed:** Compute embeddings for all candidates using all-MiniLM-L6-v2.
3. **Poaching analysis:** For each candidate, check whether its embedding is closer to any neighboring node's existing vectors than to its own node's vectors. Flag candidates that would "poach" claims belonging to other nodes.
4. **Prune:** Remove boundary-violating and redundant candidates. Target ~40 keepers.
5. **Diagnose:** If the prune rate exceeds 25% for a node, this signals a prompt quality problem — the generation is systematically drifting toward a specific neighbor. Identify which neighbor is attracting the violations.
6. **Regenerate:** For high-prune-rate nodes, regenerate replacement candidates with **strengthened contrastive instructions** that cite the specific problematic neighbor: "Your previous statements were too close to [neighbor label]. Emphasize what distinguishes THIS node: [key differentiator from `Excludes` and `assumes`]."
7. **Re-prune:** Run poaching analysis on the regenerated candidates. Accept results after at most 2 cycles — nodes that remain high-prune-rate after 2 cycles are flagged as "hard nodes" for manual review and per-node difficulty tracking (§5.5).

This turns pruning from a static filter into a **feedback loop**: the pruning data reveals where the generation prompts are failing and provides the specific diagnostic (which neighbor, which direction) needed to fix them. High-prune-rate nodes after 2 cycles become the empirically-derived "hard nodes" list — the exact nodes that need disagreement contrastives, prompt refinement, or may represent genuine taxonomy ambiguity worth surfacing to the human annotators.

#### Post-Processing

Strip formulaic LLM prefixes before embedding via regex or lightweight classifier (e.g., "As a policymaker...", "From a technical standpoint...", "As an academic...", "Crucially,", "Therefore,"). These model-stylistic fingerprints would cause embeddings to cluster by LLM signature rather than taxonomy concept. Add a lightweight **vocabulary fidelity check**: sample real debate claims, compute N-gram overlap with synthetic corpus vs. raw node descriptions — this surfaces vocabulary hallucination risk early.

### Vocabulary Mismatch Bridging

The core problem this corpus solves is a **vocabulary mismatch**: debate claims use concrete, rhetorical, domain-jargon-laden language while node descriptions use formal genus-differentia academic register. The canonical proposition experiment proved that normalizing the *source* side destroys discriminative information. The corpus expands the *target* side — but the generation prompts must be anchored to what real claims actually sound like, not what an LLM imagines debate language sounds like.

Three mechanisms bridge this gap:

1. **POV-level few-shot exemplars:** Each generation prompt includes 3-5 real debate claims drawn from the same POV camp (not node-specific — respecting the attribution-free constraint). These exemplars demonstrate the register, vocabulary, and rhetorical patterns that claims actually use. Claims are selected from the top 10% highest-similarity historical matches to ensure they are representative of recognizable debate language, not outliers.

2. **POV vocabulary profiles as explicit constraints:** The POV-level vocabulary harvesting (§3, Attribution-Free Design) produces N-gram profiles, discourse-marker inventories, and syntax guides per perspective. These are injected into every generation prompt as positive constraints: "Accelerationist claims frequently use structural terms like 'multi-layered safety stack', 'adaptive intervention', 'deployment-ready'. Use this vocabulary naturally." This prevents the LLM from hallucinating vocabulary that real debates never use.

3. **Claim distribution analysis (Step 0b) feeds back into templates:** The gating step that embeds real agent claims and visualizes their register distribution directly informs which audience registers deserve generation budget. If claims cluster in formal-to-semi-formal space, the audience-secondary allocation shifts toward those registers and away from registers the claims never visit (e.g., "general public" conversational).

These mechanisms address the risk that the corpus optimizes for synthetic language rather than observed language — the vocabulary hallucination risk identified by Reviewers 2 and 4.

### Lifecycle Management

POV nodes are actively edited — labels change, descriptions are rewritten, nodes are merged or deleted. The corpus must stay synchronized. Our approach:

- **Content-addressed hashing:** Each corpus entry stores a `description_hash` (hash of the node's description at generation time). On rebuild, the system detects stale entries (hash mismatch), deleted nodes (ID missing), and new nodes (ID absent from corpus).
- **Incremental regeneration:** Only regenerate entries for changed/new nodes, not the entire corpus
- **Neighbor-propagation (Reviewer 3):** When a node changes, also flag its current nearest neighbors for re-generation, since conceptual boundaries may have shifted even though their own descriptions are unchanged. Periodic full refresh (quarterly) as a backstop.
- **Corpus entry metadata (Reviewer 3):** Each entry stores `generation_timestamp`, `model_version` (Gemini Flash vs. Claude Sonnet), `prompt_hash`, and `archetype` for full auditability.
- **Cost estimate:** ~636 nodes x ~45 candidate statements x 2 model calls = ~57,000 API calls for a full build (pruned to ~40 keepers per node); incremental rebuilds proportional to changes

### Pilot-First Strategy (Reviewer 3)

Before committing ~57K API calls, run a **20-30 node pilot** across all three POVs with the full generate-and-prune pipeline (45-50 candidates → poaching analysis → ~40 keepers). Measure MRR lift and inspect nearest-neighbor separation. This single experiment will de-risk more than any amount of theoretical discussion. Select pilot nodes to include both "easy" nodes (distinctive vocabulary) and "hard" nodes (high confusion with neighbors).

### Critical Constraint: Attribution-Free Design

**Existing claim-to-POV attributions are inaccurate** — that is the very problem we are solving. Therefore, we **cannot use existing attributions to optimize the corpus**. For example, we cannot:
- Use attributed claims as few-shot examples for a specific node ("generate statements like these claims that matched to acc-beliefs-003")
- Fine-tune generation toward the vocabulary of claims that historically matched a node
- Use per-node attribution accuracy as a reward signal

The only safe harvesting from existing data is **corpus-level register and vocabulary patterns** — e.g., "debate claims from the Accelerationist tend to use these types of phrases" across all claims, not per-node.

#### POV-Level Vocabulary Harvesting (Safe Bootstrap)

While per-node attribution is unreliable, we can safely bootstrap from existing data at the POV-camp level:

1. Take the top 10% highest-similarity historical matches from debate logs
2. Group these claims **by POV camp** (acc, saf, skp) — completely ignoring the specific node ID they matched against
3. Feed grouped claims into an LLM to extract an N-gram vocabulary profile, stylistic syntax guide, and discourse-marker inventory for each perspective
4. Inject these POV-specific style guides into the generation pipeline as positive/negative constraints (e.g., "Accelerationist statements frequently use structural terms like 'multi-layered safety stack' or 'adaptive intervention'")

This respects the attribution-free constraint because it only assumes that accelerationist claims *as a group* use accelerationist vocabulary — it doesn't assume any individual claim-to-node mapping is correct.

#### Multi-Signal Pseudo-Labeling (More Aggressive Alternative)

Reviewer 2 proposes a bolder bootstrapping approach: use high-confidence matches where **multiple independent signals agree** as pseudo-labels. Specifically, require that embedding retrieval, a reranker, and an LLM classifier all agree on the same node attribution. Where all three agree, the attribution is likely correct despite the general noise in the dataset. These pseudo-labeled examples could then be used as few-shot exemplars for their specific nodes.

Reviewer 3 advises caution: if the base embedding model has systematic biases (likely at MRR 0.35), high-agreement cases can still reinforce those biases. Recommended use: only on a small, high-precision subset (top 5% where all signals agree with margin), and treat those as few-shot *archetype seeds* rather than blanket per-node exemplars. **We welcome further input on whether this is safe or whether it introduces unacceptable bias risk.**

## 4. POV Node Structure — Rich Fields Beyond Label and Description

Each POV node carries significantly more information than just its label and description. We suspect these additional fields could substantially improve synthetic statement generation. Below are three complete example nodes. **We specifically request your assessment of which fields would be most valuable for generating discriminative synthetic statements, and how they should be used in the generation prompts.**

### Example 1: Accelerationist Belief (acc-beliefs-003)

```json
{
  "id": "acc-beliefs-003",
  "category": "Beliefs",
  "label": "Layered Safety Systems Make AI Reliable Enough for Use",
  "description": "A Belief within accelerationist discourse that reliability requires a multi-layered safety stack integrating automated syntactic verification with risk-stratified adaptive intervention. \nEncompasses: formal constraint enforcement, real-time telemetry-triggered automated remediation, risk-stratified human-in-the-loop validation, semantic intent validation.\nExcludes: static pre-deployment gatekeeping, reliance on autonomous systems without oversight.",
  "graph_attributes": {
    "epistemic_type": "empirical_claim",
    "rhetorical_strategy": "appeal_to_evidence, techno_optimism, credibility_framing",
    "falsifiability": "medium",
    "audience": "industry_leaders, technical_researchers, policymakers",
    "emotional_register": "pragmatic, optimistic",
    "assumes": [
      "Multiple independent safety layers can catch failures that any single layer would miss, assuming their failure modes are not correlated.",
      "Automated syntactic verification is expressive enough to capture the semantically meaningful constraints relevant to real-world AI harms.",
      "Real-time telemetry can detect risk signals with sufficient speed and accuracy to trigger meaningful remediation before harm occurs.",
      "Human-in-the-loop validation can scale cost-effectively within risk-stratified tiers without becoming a bottleneck to deployment.",
      "The safety stack itself remains trustworthy and does not introduce new attack surfaces or failure modes.",
      "Semantic intent validation is tractable and reliable enough to distinguish genuinely harmful outputs from benign ones at deployment scale.",
      "Organizational incentives and operational pressures will not lead to systematic undermining or bypassing of safety layers in practice."
    ],
    "policy_actions": [
      {
        "action": "Implement tax incentives for businesses investing in AI tools to enhance workforce productivity.",
        "framing": "Recognizing AI's immediate productivity boost, policymakers can encourage its adoption through financial incentives to accelerate economic growth."
      },
      {
        "action": "Fund vocational training programs to equip workers with skills to leverage AI tools in their professions.",
        "framing": "To maximize the benefits of AI's current impact on work, policies should focus on upskilling the workforce to effectively utilize these new tools."
      }
    ],
    "intellectual_lineage": [
      "Systems Safety Engineering",
      "Formal Methods in Computer Science",
      "AI Safety Research (technical)",
      "Risk Management Theory",
      "Techno-optimism"
    ],
    "steelman_vulnerability": "Even well-designed multi-layered safety stacks can exhibit correlated failure modes if all layers share common architectural assumptions or training data, meaning a sufficiently novel or adversarial input can defeat all layers simultaneously — rendering the 'defense in depth' argument empirically weak for tail-risk scenarios.",
    "possible_fallacies": [
      "Composition fallacy — assumes combined layers are safe because individual layers are",
      "False security — sophisticated safety stack creates unjustified confidence",
      "Begging the question — presupposes a threshold of 'reliable enough' without defining it"
    ],
    "node_scope": "claim"
  }
}
```

### Example 2: Safetyist Desire (saf-desires-001)

```json
{
  "id": "saf-desires-001",
  "category": "Desires",
  "label": "Humanity's Survival Above All Else",
  "description": "A Desire within safetyist discourse that prioritizes the prevention of artificial general intelligence (AGI) from precipitating irreversible, humanity-ending catastrophes or permanent loss of human agency. \nEncompasses: Existential risk (x-risk) prevention, mitigation of global catastrophic biorisks facilitated by AI, and avoiding misalignment-induced human extinction.\nExcludes: Managing near-term algorithmic bias, localized economic disruptions, and routine data privacy concerns.",
  "graph_attributes": {
    "epistemic_type": "normative_prescription",
    "rhetorical_strategy": "precautionary_framing, moral_imperative, appeal_to_fear",
    "falsifiability": "low",
    "audience": "policymakers, academic_community, civil_society",
    "emotional_register": "alarmed, urgent, aspirational",
    "assumes": [
      "AGI or superintelligent AI systems are technically achievable within a policy-relevant timeframe.",
      "Humanity's continued existence and autonomy constitute the highest-order value, superseding other ethical considerations.",
      "Existential catastrophes from AI are not merely possible but represent a non-negligible probability worth prioritizing over nearer-term harms.",
      "Human intervention through governance and technical research can meaningfully reduce the probability of AI-induced extinction.",
      "Irreversibility is what distinguishes existential risk from other serious harms, justifying its special moral weight.",
      "No compensating mechanism will naturally prevent catastrophic AI misalignment."
    ],
    "policy_actions": [
      {
        "action": "Establish international treaties to prohibit the development of unaligned superintelligent AI.",
        "framing": "This desire directly motivates the most extreme preventative measures to avoid the described catastrophic outcomes, requiring global cooperation."
      },
      {
        "action": "Fund research into robust AI alignment and control mechanisms.",
        "framing": "Achieving this desire necessitates significant investment in technical solutions to ensure AI systems remain beneficial and controllable."
      }
    ],
    "intellectual_lineage": [
      "Existential Risk Studies (Bostrom, Ord)",
      "Longtermism (MacAskill, effective altruism)",
      "Nuclear Nonproliferation Movement",
      "Precautionary Principle"
    ],
    "steelman_vulnerability": "Concentrating moral and political capital on speculative, low-probability extinction scenarios may crowd out governance attention and funding for present, empirically documented AI harms — such as algorithmic discrimination and surveillance — that disproportionately affect already-marginalized populations.",
    "possible_fallacies": [
      "Appeal to fear — existential dread short-circuits probabilistic reasoning",
      "Scope insensitivity — treating x-risk as categorically superior to aggregate near-term suffering",
      "False dichotomy — near-term and long-term risk mitigation may be complementary, not competing"
    ],
    "node_scope": "scheme"
  }
}
```

### Example 3: Skeptic Intention (skp-intentions-004)

```json
{
  "id": "skp-intentions-004",
  "category": "Intentions",
  "label": "Build Shared-Ownership Structures for AI Production",
  "description": "An Intention within skeptic discourse that seeks to redistribute the infrastructural control and financial benefits of AI systems to workers, data creators, and the broader public. \nEncompasses: Data dividend policies, worker cooperatives for model deployment, union-negotiated algorithmic management limits, and public utility nationalization of compute.\nExcludes: Corporate profit maximization, proprietary hoarding of infrastructural gains, and venture-capital-driven proliferation models.",
  "graph_attributes": {
    "epistemic_type": "strategic_recommendation",
    "rhetorical_strategy": "structural_critique, moral_imperative, cost_benefit_analysis, appeal_to_evidence",
    "falsifiability": "low",
    "audience": "policymakers, civil_society, academic_community, industry_leaders",
    "emotional_register": "aspirational, defiant, pragmatic",
    "assumes": [
      "Current AI ownership models concentrate infrastructural power and financial benefits in ways that are unjust or harmful.",
      "Collective ownership mechanisms are technically and institutionally feasible at the scale of AI infrastructure.",
      "Redistributing control over AI production will yield more equitable societal outcomes than market-driven alternatives.",
      "Workers and data creators have legitimate ownership claims over value generated by AI systems.",
      "Political will sufficient to pass redistributive AI legislation can be assembled.",
      "Public or cooperative management will not significantly degrade performance or innovation pace.",
      "Regulatory and legal frameworks can accommodate novel ownership structures without prohibitive complexity."
    ],
    "policy_actions": [
      {
        "action": "Establish public utility models for foundational AI compute infrastructure.",
        "framing": "Nationalizing critical AI infrastructure to ensure broad public benefit and prevent private monopolization."
      },
      {
        "action": "Implement data dividend policies to distribute AI-generated value to data creators.",
        "framing": "Collective ownership extends to the value generated from user data, advocating for direct financial redistribution."
      },
      {
        "action": "Enact legislation supporting worker cooperatives for AI development and deployment.",
        "framing": "Policies must actively enable alternative ownership structures like worker cooperatives in the AI sector."
      }
    ],
    "intellectual_lineage": [
      "Democratic Socialism",
      "Distributive Justice (Rawlsian)",
      "Public Utility Theory",
      "Labor Theory of Value and Workers' Rights Movements",
      "Commons-Based Peer Production (Benkler)"
    ],
    "steelman_vulnerability": "The scale, pace, and capital intensity of frontier AI development make collective and public ownership models structurally incompatible with remaining competitive: historically, state-run or co-op-managed technology sectors have struggled to match the R&D velocity of concentrated private capital.",
    "possible_fallacies": [
      "Nirvana fallacy — comparing idealized collective ownership against flawed reality of current structures",
      "Composition fallacy — assuming mechanisms proven in one context transfer to very different ones",
      "Reverse slippery slope — implying partial reforms are insufficient without demonstrating why"
    ],
    "node_scope": "scheme"
  }
}
```

## 5. Questions for Review

*Four reviewers have addressed these questions. Reviewer 4 challenges two upstream assumptions that the R1-R3 consensus did not question. We highlight these as gating questions — they should be resolved before committing to full-scale generation.*

### 5.0 GATING QUESTIONS (Reviewer 4 — Not Yet Resolved)

**5.0a: Is the objective function trustworthy?**

The doc declares existing attributions inaccurate, then proposes to measure success as MRR lift against those same attributions (Golden-A). The 50-claim Gold-B is an acknowledgment but not a resolution. Without knowing **inter-annotator agreement (IAA) on top-1**, we cannot interpret any MRR number. If two qualified annotators only agree ~60-70% of the time, then single-node attribution is genuinely ambiguous for a large fraction of claims, MRR has a ceiling far below 1.0, and Phase 3's "target 0.75+" is chasing a number that isn't achievable in principle.

**Reviewer 4 proposes step zero:** Build a clean gold set and measure IAA on top-1 *before the pilot*. This one cheap experiment tells you: (a) whether 0.354 is as bad as it looks, (b) what the actual ceiling is, and (c) whether the full escalation ladder is worth climbing.

**Do you agree this should gate the pilot? How should top-1 annotation be operationalized — present annotators with a claim + top-5 candidate nodes, or have them search the full taxonomy?**

**5.0b: What register space are we actually covering?**

The claims being attributed come from three AI agents with fixed LLM personas. The five-audience register grid (general public, policymakers, academics, journalists, technical leaders) models the diversity of *human* discourse, but the actual distribution may be a much narrower register band. If agent claims cluster in a formal-to-semi-formal range, a meaningful fraction of the ~57K generations cover register space the claims never visit.

**Reviewer 4 proposes:** Before generating the corpus, embed a few hundred real agent claims and visualize where they actually sit relative to the nodes. This reframes the corpus goal from "cover the human register space" to "cover the region these agents' outputs actually occupy, with enough facet-diversity to separate neighbors." It also opens a cheaper alternative: if you control the agent prompts, you can attack the mismatch from the *generation* side (nudge agent output register toward node-description register) rather than only expanding the target side.

**Does this change the audience-axis allocation? Should the pilot include a claim-distribution analysis as step zero alongside the IAA measurement?**

### 5.1 Diversity Axis: Hybrid Allocation
With the expanded 40-statement budget, the hybrid is: **archetype-primary (25-30 statements) + audience-secondary (8-12 statements) + disagreement contrastives (2-4)**. The larger budget resolves the R1/R4 tension — archetypes get enough headroom for individual-assumption seeding (the single highest-leverage technique) without starving audience coverage entirely. Reviewer 4's concern about wasted register coverage is addressed by the claim distribution analysis (Step 0b) which will empirically inform how much audience budget is justified.

**Remaining open:** Should the pilot compare the 40-statement hybrid against a pure-archetype variant (40 archetype, 0 audience) to measure the marginal value of audience modulation? Should the contrastive allocation be dynamic (more slots for nodes with many confusable neighbors)?

### 5.2 Rich Fields for Generation
Strong consensus across Reviewers 2 and 3: `assumes` and `policy_actions` are the highest-value fields. `assumes` should be treated as individual mini-claims, not as a monolithic set. `steelman_vulnerability` is for defensive formulations only. `confidence`/`confidence_history` should NOT be injected. Universal fields for every prompt: `label` + `description` + `epistemic_type` + `Excludes:` clause + neighbor list.

**Remaining open:** Are there fields we're still underutilizing? Should `falsifiability` inform generation? Should the `Encompasses:` clause be used more aggressively for real-world example archetypes?

### 5.3 Retrieval Strategy: Mean-of-Top-N (Resolved)
**RESOLVED.** Mean-of-top-3 is the primary retrieval strategy; max-sim is the comparison baseline for the pilot.

Reviewers 1-3 originally endorsed multi-vector max-similarity. Reviewer 4 raised a structural concern: max-sim is monotonic — adding vectors can only *raise* a node's score, making it inherently vulnerable to poaching. A single poorly-disciplined statement that drifts into a neighbor's territory mis-captures every claim near that boundary. Neighbor-aware prompts are soft constraints fighting a hard geometric property.

**Mean-of-top-3 resolves this structurally.** Instead of winner-take-all, attribution requires *cluster density* — a node needs multiple vectors in a claim's neighborhood to score highly. This directly mitigates neighbor collapse: a single rogue vector contributes only 1/3 of the score, so boundary violations are naturally dampened. The expanded 40-vector budget provides enough coverage density for top-3 without sacrificing recall on niche facets (at 20 vectors, top-3 was risky).

Combined with generate-and-prune (which catches and removes the worst boundary violators before they enter the corpus), the two mechanisms provide defense in depth: pruning removes gross violations, mean-of-top-N dampens the residual noise.

**Pilot validation:** Compare max-sim vs. mean-of-top-3 vs. mean-of-top-5. Report MRR, per-node poaching rates, and disagreement cases under each strategy. Also instrument how often the 41st (description) vector appears in the top-3 — R4 suggests measuring rather than assuming its value.

### 5.4 The Attribution-Free Constraint
Conservative POV-level vocabulary harvesting endorsed as the safe default. Multi-signal pseudo-labeling accepted with caveats (top 5% only, archetype seeds not blanket exemplars). Reviewer 3 **strongly endorses disagreement contrastives** — using close top-1/top-2 pairs to generate explicit distinguishing statements for both nodes.

#### Confusable Neighbor Identification (Resolved)

**RESOLVED.** R4 argued that embedding proximity is contaminated by the model whose errors we're trying to fix. We adopt a **content + graph blend** that excludes current embeddings:

1. **Graph signal:** Same BDI category + same POV = high confusability prior. Nodes sharing a parent in the taxonomy hierarchy get an additional boost.
2. **Content signal:** BM25 or TF-IDF similarity between concatenated `description` + `assumes` fields. This captures genuine conceptual overlap through shared vocabulary (e.g., two nodes both discussing "correlated failures" or "regulatory frameworks").
3. **No embedding signal.** Current embedding proximity reflects the model's mistakes, not the taxonomy's genuine adjacencies.

The `Get-ConfusableNeighbors` cmdlet computes a ranked list of the top-4 confusable neighbors per node using a weighted combination of graph and content signals. This list feeds into neighbor-aware generation prompts and disagreement contrastive generation.

**Remaining open:** Should the content similarity use raw text overlap or semantic similarity from a *different* embedding model (to avoid contamination from MiniLM while still capturing semantic relatedness)?

### 5.5 Evaluation Strategy
Proposed metrics: MRR (primary), Recall@1/3/5, NDCG, axiological drift, inter-node cluster separation, per-node difficulty tracking, 50-claim blind human eval with "disputed-set" adjudication bucket, vocabulary fidelity check.

**Remaining open:** For the 50-claim blind human eval, what qualification criteria should annotators meet? Should inter-node cluster separation be measured on all node pairs, or only graph-adjacent / same-category pairs? What threshold of MRR lift from the pilot (section 3) justifies proceeding to full-scale generation?

### 5.6 Statement Count: 40 with Generate-and-Prune
**RESOLVED.** The original 20-statement budget was set before the hybrid design matured. Analysis of the archetype-to-field mapping reveals that 20 is too tight once individual assumptions are seeded separately (a single node's 5-7 `assumes` entries can consume 7-10 slots alone), disagreement contrastives take 2-4 slots, and audience modulation needs 8-12. The expanded budget of **~40 statements per node** (generated as 45-50 candidates and pruned after poaching analysis) gives each mechanism room to operate without crowding out the others.

The generate-and-prune strategy addresses Reviewer 4's max-sim poaching concern directly: every candidate statement is tested for boundary violations *before* entering the final corpus. Statements whose embeddings land closer to a neighboring node than to their own are pruned. This makes the pruning step itself a quality signal — nodes with high prune rates are flagged as "hard nodes" for prompt refinement.

**Remaining open:** Should the pilot compare 40-statement generate-and-prune against a 25-statement variant to measure marginal MRR lift per statement? What prune rate (percentage of candidates rejected) indicates a prompt quality problem vs. normal boundary proximity?

### 5.7 Risks and Failure Modes

| Risk | Severity | Source | Status |
|---|---|---|---|
| **Unmeasured ceiling** | Critical | R4 | **Unmitigated.** If IAA on top-1 is ~60-70%, MRR has a hard ceiling far below 1.0. All phase targets may be unrealistic. Gating question 5.0a. |
| **Max-sim poaching** | High | R4 | **Mitigated by generate-and-prune.** Max-sim is monotonic in vector count — adding vectors can only raise scores. The generate-and-prune pipeline (45-50 → ~40) directly instruments poaching and prunes boundary-violating statements before they enter the corpus. Mean-of-top-3 comparison still recommended for the pilot. |
| **Register mismatch** | High | R4 | **Partially mitigated.** Vocabulary mismatch bridging (POV few-shot exemplars + vocabulary profiles + claim distribution feedback) anchors generation to observed claim register. Full mitigation depends on Step 0b claim distribution analysis. |
| Cross-node collision | High | R1 | Mitigated: `Excludes:` clause as negative constraint |
| **Neighbor collapse** | High | R2, R3 | **Mitigated (defense in depth):** (1) neighbor-aware prompts + disagreement contrastives (generation-side), (2) generate-and-prune with prune-and-regenerate cycle (post-generation), (3) mean-of-top-3 retrieval dampens residual boundary noise (retrieval-side) |
| **Embedding saturation** | High (systemic) | R2, R3 | **Unmitigated — requires ablation.** Parallel test with all-mpnet-base-v2 or BGE-base-en-v1.5 recommended |
| **Model confounding** | Medium-High | R4 | **Unmitigated.** The two-model split (Gemini→general/journalist/technical, Sonnet→policymaker/academic) perfectly correlates model identity with audience. If one register outperforms, you can't tell whether it's the register or the model. Prefix-stripping doesn't remove deeper stylistic fingerprints (cadence, hedging, lexical priors). Must randomize model-to-archetype assignment or have both models generate everything. |
| **Vocabulary hallucination** | Medium | R2, R3 | Mitigated: POV-level harvesting + POV few-shot exemplars + vocabulary fidelity check + vocabulary profiles as generation constraints |
| Model stylistic fingerprinting | Medium | R1 | Partially mitigated: prefix stripping (R4 argues insufficient for deeper fingerprints) |
| Taxonomy drift from neighbor changes | Medium | R2, R3 | Mitigated: neighbor-propagation on rebuild + quarterly full refresh |

**Remaining open:** Is embedding saturation or the unmeasured ceiling the more fundamental risk? R4 argues: run IAA, encoder ablation, and a reranker *before* the corpus — all three are cheap and may capture most of the available lift, at which point the corpus may be the lowest-marginal-value item rather than the foundation.

### 5.8 Alternative and Complementary Approaches

| Approach | Reviewers | Consensus | Phase |
|---|---|---|---|
| BM25 + dense hybrid with RRF | R1, R2, R3 | High priority — keyword anchors in taxonomy are strong | Phase 2 |
| Cross-encoder / LLM reranker on top-5/10 | R1, R2, R3, R4 | Excellent ROI, lower-risk than corpus engineering | Phase 2 |
| **Contrastive fine-tuning** using taxonomy graph as supervision | R2, R3 | Strongest long-term direction. R3: "Do the synthetic corpus first — it gives you the hard negatives you need" | Phase 3-4 |
| Encoder upgrade (mpnet-class) | R2, R3, R4 | Ablation test recommended — potentially larger lift than corpus | Eval gate |
| **Agent-side register nudging** | R4 | If you control agent prompts, attack mismatch from the generation side (cheaper than expanding target side) | Alternative |

**R4 resequencing challenge (IMPORTANT):** R4 argues the corpus is the most expensive, highest-risk piece (~57K API calls) and should NOT be Phase 1. R3's justification ("it gives you the hard negatives for fine-tuning") is weaker than it sounds — hard negatives can be mined from the taxonomy graph itself (`Excludes`/`Encompasses`/`assumes` overlap between nodes encodes confusability directly, with zero API cost). R4's proposed ordering: **(1) clean gold + IAA**, **(2) encoder ablation**, **(3) reranker on top-K**. All three are cheap. A good cross-encoder makes the bi-encoder's exact geometry far less load-bearing, at which point the corpus may be the lowest-marginal-value item rather than the foundation.

**Remaining open:** Should the corpus be resequenced from Phase 1 to Phase 3 (after cheaper interventions are measured)? Or is R3's argument correct that the corpus is foundational because it reveals which nodes are genuinely confusable in practice?

### 5.9 Cross-POV Discrimination
Reviewer 3 says **yes — include it**. Even though retrieval is scoped to within-POV, explicit cross-POV contrast in generation prompts ("Emphasize how this node's framing of [concept] differs from how a Safetyist/Skeptic would express the same idea") sharpens within-POV boundaries and future-proofs the corpus if cross-POV retrieval is ever activated.

**Remaining open:** How to operationalize this in prompts without introducing excessive complexity? Should it apply to all nodes, or only nodes whose concepts clearly span POV boundaries (e.g., "alignment", "governance", "safety")?

### 5.10 Prompt Template Design
Reviewer 3 recommends a standardized template structure, now extended with vocabulary mismatch bridging:
1. Core node info (label, description, epistemic_type)
2. **POV few-shot exemplars** (3-5 real debate claims from this POV camp — register anchoring)
3. **POV vocabulary profile** (N-gram constraints, discourse markers, syntax guide for this perspective)
4. Archetype/audience-specific field injection
5. Universal negatives (Excludes + neighbor list)
6. Diversity instructions ("maximally distinct phrasings")
7. Output format: JSON array of `{statement, archetype, rationale}` for auditability

**Remaining open:** R4 argues `rationale` is worth the cost but should be used as a **filter**, not just an audit trail — discard any statement whose rationale reveals it's expressing a neighbor or a generic POV platitude rather than this specific node. Should this filtering be automated (LLM-based quality gate) or manual (spot-check during pilot)?

## 6. Summary of Constraints

| Constraint | Rationale |
|---|---|
| Embedding model: all-MiniLM-L6-v2 (384-dim) | Established across the project; changing it requires re-embedding all nodes and situations |
| Within-POV matching only | Claims from the Accelerationist agent only match against `acc-*` nodes |
| No per-node attribution feedback | Existing attributions are inaccurate — corpus-level patterns only |
| Must handle node lifecycle | Nodes are actively edited, merged, split, and deleted |
| Two generation models (Gemini Flash + Claude Sonnet) | Vocabulary diversity across model families |
| Evaluation baseline: MRR 0.354 | Current performance with raw claim text vs. single node embeddings |
| Failed baseline: canonical propositions MRR 0.267 | Register normalization loses discriminative information |

We welcome critique of any aspect of this plan — the problem framing, the proposed solution, the evaluation strategy, the use of node fields, or the overall approach. We are especially interested in failure modes we may not have considered and alternative techniques that could complement or replace this approach.

---

## Appendix A: Reviewer 1 Feedback and Our Response

*This section documents feedback from the first external review and the design decisions it informed. Subsequent reviewers may engage with, contradict, or build on these recommendations.*

### A.1 Rich Fields — Field-to-Audience Mapping

**Reviewer recommendation:** Do not dump all fields into one prompt — map specific fields to specific audience/register pairs where they natively align. Proposed mapping:

| Target Audience | Primary Rich Fields | Rationale |
|---|---|---|
| General public | `possible_fallacies`, `emotional_register`, `rhetorical_strategy` | Visceral discourse, common polemics, colloquial vulnerabilities |
| Policymakers | `policy_actions` + `framing`, `epistemic_type` | Explicit mandates, statutory constraints, governance trade-offs |
| Academics | `intellectual_lineage`, `assumes`, `epistemic_type` | Tradition-specific nomenclature, epistemological grounding |
| Journalists | `steelman_vulnerability`, `rhetorical_strategy`, `label` | Conflict, critique, dialectical friction points |
| Technical leaders | `description` (Encompasses/Excludes), `assumes` | Engineering edge cases, boundary conditions, operational constraints |

**Our response:** Adopted in full. Also added `Excludes:` clause as negative constraint for all audiences. See section 3 (Field-to-Audience Mapping).

### A.2 Retrieval Strategy — Skip Centroids

**Reviewer recommendation:** Averaging 20 register-diverse vectors in 384-dim space causes topological collapse. Go straight to multi-vector max-similarity. With within-POV scoping (~4,000 vectors per query), exact k-NN is trivially fast via NumPy.

**Our response:** Adopted. Centroid phase eliminated. See section 3 (Retrieval Strategy).

### A.3 Attribution-Free Bootstrapping

**Reviewer recommendation:** Group top 5-10% highest-similarity historical matches by POV camp (ignoring specific node ID). Extract N-gram vocabulary profiles, syntax guides, and discourse-marker inventories per perspective. Inject as style constraints into generation.

**Our response:** Adopted with conservative threshold (top 10%). See section 3 (POV-Level Vocabulary Harvesting).

### A.4 Evaluation Metrics

**Reviewer recommendations:**
- MRR is appropriate as primary metric
- Add Recall@3 and Recall@5
- Monitor "axiological drift" (cos-distance from node description to synthetic statements)
- Run blind multi-annotator human evaluation on ~50 claims — if the new method returns a node that humans agree is *better* than the approximate ground truth, a formal MRR drop actually indicates improvement

**Our response:** All adopted. See section 3 (Evaluation Plan in the architecture table is pending — tracked as open question 5.4).

### A.5 Statement Count

**Reviewer recommendation:** 20 is sufficient *if and only if* structural diversity is enforced. Proposed 4 variants: anecdotal assertion, interrogative framing, conditional if/then hypothesis, counterargument rebuttal. Increasing to 50 yields diminishing returns with cross-node collision risk.

**Our response:** The structural diversity enforcement was adopted, but subsequent design evolution (individual-assumption seeding, disagreement contrastives, audience modulation) revealed that 20 is too tight. **Updated to ~40 statements per node with generate-and-prune** (see §5.6). The prune step directly addresses R1's cross-node collision concern — statements that drift into neighbor territory are caught and removed.

### A.6 Risk Mitigations

**Reviewer-identified risks and mitigations:**
1. **Cross-node collision** (high severity) — inject `Excludes:` clause as explicit negative constraint
2. **Model stylistic fingerprinting** (medium) — strip formulaic LLM prefixes via regex before embedding

**Our response:** Both adopted. See section 3 (Post-Processing) and field-to-audience mapping.

### A.7 Complementary Approaches

**Reviewer recommendations:**
1. **BM25 + Dense hybrid with Reciprocal Rank Fusion** — taxonomy nodes contain distinct keyword anchors; sparse lexical search catches exact term matches that embeddings might fuzz
2. **Two-stage LLM reranking** — multi-vector surfaces top-5 candidates, then Gemini Flash performs genus-differentia classification on the shortlist

**Our response:** Both adopted as future phases. LLM reranking = Phase 2, BM25 hybrid = Phase 3. See section 3 architecture discussion.

### A.8 Revised Architecture (Post-Review 1)

| Phase | What | Expected MRR | Key dependency |
|---|---|---|---|
| **Phase 1** | Multi-vector synthetic corpus: ~40 statements/node (generate-and-prune), hybrid diversity, max-similarity retrieval | Target 0.50+ (from 0.354 baseline) | Corpus generation (~57K API calls) |
| **Phase 2** | LLM reranker on top-5 candidates from Phase 1 | Target 0.65+ | Gemini Flash reranking prompt |
| **Phase 3** | BM25 hybrid with RRF (if ceiling not reached) | Target 0.75+ | BM25 index infrastructure |

---

## Appendix B: Reviewer 2 Feedback and Our Response

*Reviewer 2 took a more technical, retrieval-engineering perspective. Several recommendations reinforce Reviewer 1; others introduce new ideas or directly challenge Reviewer 1's framing.*

### B.1 Core Diagnosis

**Reviewer assessment:** The proposal is directionally correct. The canonical proposition failure confirms that the attribution problem is **lexical grounding**, not semantic abstraction — the embedding model uses concrete vocabulary as a major discriminative signal. Expanding the target surface is the right pivot. Expected improvement: MRR ~0.35 → ~0.45-0.55 for Phase 1.

**Biggest risk identified (differs from Reviewer 1):** Not centroid collapse — the biggest risk is **synthetic statements becoming semantically homogeneous**, increasing intra-node density while doing nothing to increase inter-node distance. Generating 20 paraphrases of the description is easy; generating 20 statements that increase *discrimination from neighboring nodes* is the actual challenge.

**Our response:** This reframes the success criterion. The goal is not just "cover more register space" but specifically "expand the embedding surface in directions that increase distance from neighboring nodes." This has implications for prompt design — we need explicit neighbor-awareness in generation.

### B.2 Semantic Archetypes (Major New Idea)

**Reviewer recommendation:** Do not organize by audience. Organize by **statement archetype** — surface claim, assumption expression, policy implication, intellectual lineage framing, defensive formulation, real-world example, counterargument response. This produces *semantic* diversity (different facets of the node) rather than merely *stylistic* diversity (same idea in different registers).

**Reviewer argument:** Stylistic variants cluster tightly in embedding space because the core semantic content is identical. Archetype variants expand the semantic surface because each archetype draws on different node fields and expresses genuinely different aspects of the position.

**Our response:** This is a compelling argument. We have surfaced the audience-vs-archetype tension as the central open design question (section 5.1) rather than committing to either approach. A hybrid may be possible but needs to fit within the 20-statement budget.

### B.3 Field Value Ranking

**Reviewer ranking:**

| Field | Value | Key insight |
|---|---|---|
| `assumes` | Extremely high | Assumptions contain specific vocabulary ("correlated failures", "telemetry") more likely to appear in real claims than formal descriptions |
| `policy_actions` | Extremely high | Debate participants discuss regulations and treaties, not abstract beliefs — policy language is what claims actually sound like |
| `epistemic_type` | High | Different types generate different linguistic forms (empirical → "data show"; normative → "we should"; strategic → "we must implement") |
| `intellectual_lineage` | High | Injects tradition-specific vocabulary as lexical retrieval anchors |
| `steelman_vulnerability` | Medium | Use for *defensive* formulations only — e.g., "Even if safeguards fail, independent layers provide resilience" |
| `possible_fallacies` | Low | More useful for counterargument archetypes than direct generation |

**Our response:** Adopted the ranking into section 3. The insight that `assumes` may be more discriminative than `description` is particularly valuable — assumptions contain the specific, concrete vocabulary that debate claims actually use.

### B.4 Multi-Vector Retrieval (Reinforces Reviewer 1)

**Reviewer recommendation:** Skip centroids. Go directly to multi-vector. 12,700 vectors is "absolutely tiny" — even CPU FAISS handles this comfortably.

**Reviewer argument:** Embeddings are not linear semantic spaces. If a node has regulatory + technical + philosophical statements, their centroid occupies an artificial point that corresponds to no real claim.

**Our response:** Strong consensus across both reviewers. Multi-vector confirmed as the retrieval strategy.

### B.5 Attribution Bootstrapping (More Aggressive Than Reviewer 1)

**Reviewer recommendation:** Use multi-signal agreement for pseudo-labeling. Require embedding retrieval + reranker + LLM classifier to all agree on an attribution. These high-agreement instances become pseudo ground truth.

**Our response:** Added to section 3 as an alternative approach alongside POV-level harvesting. Not yet committed — the risk of reinforcing existing biases needs consideration. See open question 5.4.

### B.6 Evaluation (Expands Reviewer 1)

**Reviewer additions:**
- Add **Recall@1** (operational accuracy) and **NDCG** (for cases where multiple nodes could reasonably fit)
- Create **Gold-B** — 50 expert-reviewed attributions alongside the approximate Golden-A set
- Risk of "optimizing against noise" if we only use approximate ground truth

**Our response:** NDCG and Recall@1 added to the evaluation plan. Gold-B creation (human-reviewed subset) confirmed. See open question 5.5.

### B.7 New Failure Modes (Not Identified by Reviewer 1)

| Risk | Description | Severity |
|---|---|---|
| **Neighbor collapse** | Synthetic generation amplifies overlap between semantically adjacent nodes (e.g., "AI productivity gains" vs. "AI economic growth"), making retrieval *harder* | High |
| **Embedding saturation** | all-MiniLM-L6-v2 is too weak (384-dim) to represent the fine-grained distinctions the corpus introduces — improvements are invisible because the encoder can't capture them | High (systemic) |
| **Vocabulary hallucination** | LLMs generate vocabulary never used in actual debates — corpus optimizes for synthetic language rather than observed language | Medium |
| **Taxonomy drift from neighbor changes** | Content-hashing detects changes to *this* node, but not conceptual drift caused by *neighboring* nodes being edited, merged, or split | Medium |

**Our response:** All four added to the risk inventory (section 5.7). Embedding saturation is potentially the most fundamental — if the encoder is the bottleneck, no amount of corpus engineering will help. We have surfaced this as an explicit question: should we test a stronger model (e.g., all-mpnet-base-v2, 768-dim) as a comparison baseline?

### B.8 Long-Term Alternative: Contrastive Fine-Tuning

**Reviewer recommendation:** The strongest long-term solution is not the synthetic corpus itself but **contrastive fine-tuning** using the taxonomy graph as supervision:

1. Generate (anchor claim, positive node, hard negative node) triples
2. Fine-tune an embedding model to discriminate between nearby nodes
3. The taxonomy structure itself teaches inter-node boundaries

**Reviewer assessment:** This directly addresses discrimination between neighboring nodes — the core weakness. The synthetic corpus is a good intermediate step, but contrastive training is the end-game.

**Our response:** Added as a long-term phase in section 5.8. The question of whether to prioritize it over the synthetic corpus approach is surfaced as an open question. With ~636 nodes, we have enough structure for contrastive training, but generating quality hard negatives requires knowing which nodes are genuinely confusable — which the synthetic corpus + evaluation phase would help identify.

### B.9 Revised Architecture (Post-Review 2)

| Phase | What | Expected MRR | Key dependency |
|---|---|---|---|
| **Phase 1** | Multi-vector synthetic corpus: ~40 statements/node (generate-and-prune), hybrid diversity, max-similarity retrieval | Target 0.45-0.55 (from 0.354) | Corpus generation (~57K API calls) |
| **Phase 2** | Cross-encoder or LLM reranker on top-5/10 candidates | Target 0.60-0.70 | Reranker selection |
| **Phase 2b** | BM25 + dense hybrid with RRF | Target +0.05-0.10 | BM25 index |
| **Phase 3** | Contrastive fine-tuning using taxonomy graph as supervision | Target 0.75+ | Hard negative identification from Phase 1-2 |
| **Eval gate** | Test all-mpnet-base-v2 (768-dim) as encoder comparison | Informs ceiling | Re-embedding pipeline |

---

## Appendix C: Reviewer 3 Feedback and Our Response

*Reviewer 3 provided the most operationally specific review, directly answering every open question with concrete recommendations. This review resolves several design tensions from Reviewers 1 and 2.*

### C.1 Overall Assessment

**Reviewer verdict:** High-quality, well-diagnosed proposal. Implementable and should deliver a meaningful lift. Realistic Phase 1 target: MRR 0.48-0.58 from the 0.354 baseline, assuming good prompt discipline.

**Key reframing:** The plan is strong. The biggest remaining risk is not any single design flaw but **embedding saturation** — all-MiniLM-L6-v2 may lack the capacity to represent the distinctions the corpus introduces.

### C.2 Diversity Axis — Resolves R1/R2 Tension

**Reviewer recommendation:** Semantic archetypes are clearly superior for embedding discrimination. Originally proposed a **hybrid** to fit in 20 statements (since expanded to ~40 — see §5.6):
- Primary (12-14, now 25-30): Archetype-driven — surface claim, assumption expression, policy implication, intellectual lineage, defensive formulation, real-world example, counterargument response
- Secondary (6-8): Audience-modulated within the strongest archetypes (especially policy implication and defensive formulation)

**Critical addition:** Every prompt should list 2-4 most confusable neighboring nodes and instruct "Generate statements that express THIS node and not nearby positions X, Y, Z."

**Our response:** Adopted as the emerging consensus approach in section 3. The hybrid resolves the R1/R2 tension by making archetypes primary while preserving some register coverage. Neighbor-aware prompts adopted universally.

### C.3 Field Usage — Confirms and Refines R2

**Reviewer guidance:**
- `assumes`: Generate *from individual assumptions*, not the whole set. Each major assumption seeds 1-2 statements across archetypes. This is where the most discriminative material lives.
- `steelman_vulnerability`: Defensive formulation archetype only. Can seed "nuanced positive" statements but not pure positive surface claims.
- `confidence`/`confidence_history`: Do NOT inject. Risks artificial hedging. `epistemic_type` already provides tonal signal.
- Universal fields (every prompt): `label` + `description` + `epistemic_type` + `Excludes:` + neighbor list.

**Our response:** All adopted into section 3 (Field Value Ranking).

### C.4 21st Vector

**Reviewer recommendation:** Include the original node `description` embedding as the 21st vector per node. It serves as the semantic prototype/anchor — real claims sometimes match the canonical description more closely than any synthetic variant.

**Our response:** Adopted. Retrieval updated to 41 vectors per node (40 synthetic + 1 description).

### C.5 Attribution — Endorses Disagreement Contrastives

**Reviewer assessment:** POV-level harvesting is the right default. Multi-signal pseudo-labeling is moderately risky — use only on top 5% with margin, as archetype seeds not blanket exemplars.

**Strongest new recommendation:** Use attribution *disagreements* (close top-1/top-2 pairs) as gold for contrastive generation. For each such neighboring node pair, generate explicit distinguishing statements for both nodes. This is "one of the highest-leverage mitigations for neighbor collapse."

**Our response:** Disagreement contrastives adopted as a shared design element in section 3.

### C.6 Evaluation — Additional Metrics

**Reviewer additions:**
- **Inter-node cluster separation**: Mean cosine distance between synthetic statement clouds of graph-nearest-neighbor nodes. Directly measures whether generation increases discrimination where it matters.
- **Per-node difficulty tracking**: "Hard nodes" list — nodes that consistently contribute low MRR. Target for prompt refinement.
- **Disputed-set handling**: When the new method surfaces a different top node than the golden set, flag for human review rather than treating as error. Create an "adjudicated improvement" bucket.
- **Vocabulary fidelity check**: N-gram overlap between synthetic corpus and real debate claims vs. raw node descriptions. Surfaces hallucination risk early.

**Our response:** All adopted into section 5.5 evaluation plan.

### C.7 Risk Prioritization

**Reviewer priority ordering:**
1. **Neighbor collapse** (highest immediate) — mitigated by neighbor-aware prompts + disagreement contrastives + archetype diversity
2. **Embedding saturation** (systemic ceiling) — "Strongly recommend parallel ablation with all-mpnet-base-v2 or BGE-base-en-v1.5." Typical quality gap: 3-7%. If gap appears, encoder upgrade is higher-leverage than corpus engineering.
3. **Vocabulary hallucination** — mitigated by POV-level harvesting + post-generation filter against rare terms absent from debate logs
4. **Taxonomy drift from neighbors** — mitigated by periodic full refresh (quarterly) + neighbor-propagation on rebuild

**Our response:** Priority ordering adopted. mpnet ablation added as eval gate.

### C.8 Complementary Approaches — Sequencing

**Reviewer sequencing:**
- **BM25 hybrid**: High-priority quick win for Phase 2. Taxonomy keyword anchors are strong.
- **Cross-encoder/LLM reranker**: Excellent Phase 2, lower-risk than contrastive fine-tuning.
- **Contrastive fine-tuning**: Strongest *long-term* direction. "Do the synthetic corpus first — it gives you the hard negatives you need. Then move to contrastive fine-tuning. Do not skip or de-prioritize the corpus — it is the necessary foundation."

**Our response:** Sequencing adopted. Contrastive fine-tuning is Phase 3-4, not a replacement for the corpus.

### C.9 Practical Recommendations

- **Pilot first (20-30 nodes)** before committing ~57K API calls. Select both "easy" nodes and "hard" nodes.
- **Standardized prompt template**: Core node info → archetype-specific field injection → universal negatives (Excludes + neighbors) → diversity instructions → JSON output format with `{statement, archetype, rationale}` for auditability.
- **Lifecycle metadata**: Add `generation_timestamp`, `model_version`, `prompt_hash` to each entry.
- **Cross-POV discrimination**: Yes — include in prompts even though retrieval is within-POV. Sharpens boundaries and future-proofs.

**Our response:** All adopted. Pilot-first strategy added to section 3. Lifecycle metadata added. Cross-POV discrimination endorsed.

### C.10 Revised Architecture (Post-Review 3)

| Phase | What | Expected MRR | Key dependency |
|---|---|---|---|
| **Pilot** | 20-30 node test across all 3 POVs with hybrid diversity scheme | Validates approach | Node selection (easy + hard) |
| **Eval gate** | Parallel ablation: all-mpnet-base-v2 (768-dim) or BGE-base-en-v1.5 | Informs encoder ceiling | Re-embedding pipeline |
| **Phase 1** | Full synthetic corpus: 41 vectors/node, hybrid diversity, neighbor-aware prompts, generate-and-prune, max-similarity retrieval | Target 0.48-0.58 | Pilot validation, ~57K API calls |
| **Phase 2** | BM25 hybrid (RRF) + cross-encoder/LLM reranker on top-5/10 | Target 0.60-0.70 | BM25 index + reranker selection |
| **Phase 3-4** | Contrastive fine-tuning using synthetic corpus hard negatives + taxonomy graph | Target 0.75+ | Phase 1-2 confusion matrix |

---

## Appendix D: Reviewer 4 Feedback and Our Response

*Reviewer 4 challenges two upstream assumptions that the R1-R3 consensus did not question. This review argues the plan is "over-engineered relative to what's been validated" and proposes a fundamentally different sequencing.*

### D.1 Core Critique

**Reviewer assessment:** The plan is internally coherent but three reviewers have been agreeing inside a frame that two upstream questions haven't been allowed to challenge: (a) is the objective function trustworthy, and (b) is the target register distribution what you think it is.

### D.2 Upstream Issue 1: Machine-Generated Claims

**The problem:** The claims come from three AI agents with fixed LLM personas, not from diverse human discourse. The five-audience register grid models human diversity, but agent output likely clusters in a much narrower register band. A meaningful fraction of ~27K generations may cover register space the claims never visit.

**Reviewer recommendation:** Embed a few hundred real agent claims and visualize where they actually sit relative to the nodes. This reframes the corpus goal and may dramatically reduce the audience axis allocation. Also consider attacking from the generation side — nudge agent prompts toward the node-description register rather than only expanding the target side.

**Our response:** This is a valid reframing we hadn't considered. Added as gating question 5.0b. The claim-distribution analysis should be part of the pre-pilot work. The agent-side register nudging is an interesting cheaper alternative that may complement or partially replace the corpus. However, we note that the debate engine's prompts are owned by a different role (DebateTool), so agent-side changes require coordination.

### D.3 Upstream Issue 2: Unmeasured Objective Ceiling

**The problem:** Existing attributions are declared inaccurate, yet MRR against those attributions is the success metric. Without inter-annotator agreement (IAA) on top-1, we can't interpret any MRR number. If IAA is ~60-70%, single-node attribution is genuinely ambiguous for many claims, MRR has a hard ceiling far below 1.0, and the Phase 3 "target 0.75+" is unachievable.

**Reviewer recommendation:** Step zero before the pilot: build a clean gold set, have 2+ annotators independently assign top-1 nodes for ~50-100 claims, measure IAA. This tells you (a) whether 0.354 is as bad as it looks, (b) what the actual ceiling is, (c) whether the escalation ladder is worth climbing.

**Our response:** This is the most important recommendation across all four reviews. Added as gating question 5.0a. The IAA measurement is cheap and high-information — it should be done before committing any API budget. If IAA reveals that top-1 is genuinely ambiguous, the task may need to be reframed as top-K attribution rather than top-1, which would change the evaluation metrics and potentially the corpus design.

### D.4 Max-Sim Structural Bias

**Reviewer critique:** Max-similarity over an expanding vector set is monotonic — adding synthetic vectors can only raise a node's score. For boundary claims, whichever node happens to land one vector closer wins. A single poorly-disciplined statement that drifts into a neighbor's territory mis-captures many claims. Neighbor-aware prompts are soft constraints fighting a hard geometric property.

**Recommendations:**
- Instrument per-vector "poaching" — how often each synthetic vector wins the max for claims belonging *elsewhere*. Prune offenders. This is the real quality signal.
- Test mean-of-top-3 against pure max — far less sensitive to a single rogue vector.

**Our response:** This is a genuine structural concern not raised by R1-R3. Added to section 5.3 and the risk inventory. Both poaching instrumentation and mean-of-top-3 comparison should be tested in the pilot.

### D.5 Model Confounding

**Reviewer critique:** Assigning Gemini to specific audiences and Sonnet to others perfectly correlates model identity with register. If academic statements outperform, you can't tell whether it's the register or the model. Prefix-stripping removes surface tells but not deeper stylistic fingerprints (cadence, hedging, lexical priors) that embeddings encode.

**Recommendation:** Randomize model-to-archetype assignment, or have both models generate everything.

**Our response:** Valid experimental design concern. Added to section 3 (Generation Strategy) as an open design issue. The pilot should randomize model assignment to avoid confounding.

### D.6 Resequencing: Cheap Interventions First

**Reviewer argument:** The corpus is the most expensive, highest-risk piece (~57K API calls), and it's Phase 1. R3's justification ("it gives you the hard negatives for fine-tuning") is weaker than it sounds — hard negatives can be mined from the taxonomy graph itself (`Excludes`/`Encompasses`/`assumes` overlap encodes confusability directly, zero API cost).

**Proposed resequencing:**
1. Clean gold set + IAA measurement
2. Encoder ablation (mpnet/BGE comparison)
3. Cross-encoder reranker on top-K with current embeddings
4. *Then* decide whether the corpus earns its 27K calls

**Reviewer argument:** A good cross-encoder makes the bi-encoder's exact geometry far less load-bearing. The corpus may be the lowest-marginal-value item rather than the foundation.

**Our response:** This is the strongest challenge to the plan's architecture. The resequencing is logically sound — all three proposed steps are cheap and high-information. However, we note a tension: if the reranker captures most of the lift, it does so at inference time (every claim requires a reranking call), while the corpus approach improves the base embedding quality permanently. The right answer may depend on inference-cost constraints. Added as a key open question in section 5.8.

### D.7 Quick Hits

- **Confusable pairs (5.4):** Use node-content proximity (description + `assumes` overlap), NOT current embedding proximity. Embedding proximity is contaminated by the model whose errors you're trying to fix.
- **21st vector (5.3):** Easy to over-credit. Instrument how often it actually carries the max rather than reasoning about it.
- **Statement count (5.6):** The more important pilot variable is *boundary discipline per statement*, not count. Twenty disciplined statements beat thirty that widen the poaching surface.
- **Rationale field (5.10):** Worth the cost, but use as a *filter* — discard any statement whose rationale reveals it's expressing a neighbor or a generic platitude.

**Our response:** All adopted into respective sections.

### D.8 Revised Architecture (Post-Review 4)

| Phase | What | Cost | Key output |
|---|---|---|---|
| **Step 0a** | Clean gold set + IAA on top-1 (50-100 claims, 2+ annotators) | Low (human time) | Attribution ceiling, task well-definedness |
| **Step 0b** | Claim distribution analysis (embed real agent claims, visualize register space) | Trivial (compute only) | What register space actually needs coverage |
| **Step 1** | Encoder ablation (mpnet/BGE vs. MiniLM on current embeddings) | Low (re-embed ~636 nodes) | Whether encoder is the bottleneck |
| **Step 2** | Cross-encoder reranker on top-K with current embeddings | Low (off-the-shelf model) | How much lift is available without corpus |
| **Step 3** | Synthetic corpus (if Steps 0-2 indicate it earns its budget) | High (~57K API calls) | Improved base embeddings |
| **Step 4** | Contrastive fine-tuning | Medium | Inter-node discrimination |
