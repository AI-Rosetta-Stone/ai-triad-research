# AI Triad Research — System Narrative for Infographic

## The Story: Growing Truth Through Structured Argument

---

### Stage 1: Seed

The project began with a foundational question: how do different communities think about AI's future? We identified three distinct perspectives that dominate AI policy discourse:

- **Accelerationists** — emphasize capability growth, scaling, and transformative potential
- **Safetyists** — prioritize alignment, existential risk, and deployment caution
- **Skeptics** — focus on immediate harms: bias, labor displacement, institutional accountability

Using core position papers and foundational documents from each camp, an LLM generated a **seed taxonomy** — an initial structured map of each perspective's beliefs (empirical claims), desires (normative commitments), and intentions (strategic reasoning). This BDI decomposition (Belief-Desire-Intention) ensures that different *kinds* of disagreement are never collapsed into a single label.

Each node follows a precise genus-differentia format grounded in DOLCE ontology:
> "A [Belief|Desire|Intention] within [POV] discourse that [differentia]. Encompasses: [scope]. Excludes: [boundaries]."

This structured format is not just for readability — it produces better embeddings, more precise boundary detection, and consistent machine-readable descriptions across 565+ nodes.

---

### Stage 2: Grow

The seed taxonomy was then expanded through systematic document ingestion. Over 170 source documents — academic papers, policy reports, regulatory proposals, think-tank publications — were processed through a computational linguistics pipeline:

1. **Document conversion** — PDF/DOCX/HTML converted to clean Markdown via pandoc/ghostscript
2. **Intelligent chunking** — Documents split at semantic boundaries (headings, paragraphs) with content-aware token estimation
3. **POV classification (CHESS)** — A lightweight pre-classifier identifies which perspectives a document touches, narrowing the taxonomy search space
4. **Claim extraction (FIRE)** — Confidence-gated iterative extraction replaces single-shot summarization. Each claim is assessed for specificity, warrant quality, and internal consistency. Uncertain claims are iteratively refined through targeted follow-up queries — not accepted on faith
5. **Taxonomy mapping** — Extracted claims are matched to existing nodes or proposed as new additions using embedding similarity (all-MiniLM-L6-v2, 384-dim vectors with empirically validated field weighting)

**The human role is essential at every stage.** Researchers review proposed nodes, fix boundary issues, identify coverage gaps, and curate new source documents to fill them. The system proposes; humans decide.

At regular intervals, the taxonomy's thematic structure is re-evaluated:
- **Embedding-based clustering** identifies natural groupings and surface gaps
- **Hierarchy generation** proposes parent-child relationships using semantic similarity
- **Conflict detection** identifies where perspectives genuinely disagree (1,500+ cross-POV conflict instances)
- **Situation identification** surfaces shared concepts that all three camps engage with but interpret differently (212 situation nodes, each carrying three POV interpretations)

---

### Stage 3: Debate

With a rich taxonomy in hand, the system moves to its most distinctive phase: **structured multi-agent debate**. This is modeled on the adversarial epistemology tradition — the idea, central to both the Socratic method and the common law system, that **truth emerges through the rigorous testing of competing arguments**.

Three AI debaters — Prometheus (accelerationist), Sentinel (safetyist), and Cassandra (skeptic) — are grounded in their respective taxonomy branches. Each agent's worldview is structured by BDI category: "here are your empirical beliefs, your normative commitments, and your reasoning strategies."

Debates can be triggered by:
- A **topic** ("Should frontier labs share safety research?")
- A **source document** (a new policy paper to analyze)
- A **conflict** (a specific cross-POV disagreement in the taxonomy)
- A **situation** (a shared concept with divergent interpretations)
- A **URL** (a recent article or report)

**What makes these debates different from simple LLM chat:**

- **Structured argumentation graph** — Every claim is extracted, classified (13 argumentation schemes derived from Walton), and linked to prior claims via typed attack/support edges. This produces a formal argument network, not just a transcript.
- **QBAF strength propagation** — Argument strength flows through the network via DF-QuAD gradual semantics. A claim that faces strong attacks from multiple perspectives has its computed strength reduced — making it visible where positions are genuinely contested.
- **Adaptive phase management** — Debates progress through thesis-antithesis → exploration → synthesis phases, with transition governed by six weighted convergence signals (recycling pressure, crux maturity, concession plateau, engagement fatigue, pragmatic convergence, scheme stagnation). The system detects when arguments are being recycled and moves the debate forward.
- **Sycophancy detection** — Per-claim drift tracking distinguishes legitimate position refinement from accommodation. The system decomposes each debater's opening into individual claims and tracks whether they're maintained, refined, or abandoned — firing a warning only when >50% of claims are dropped without explicit concession.
- **Commitment tracking** — Each debater's assertions, concessions, and challenges are recorded. Silent self-contradiction is flagged. Genuine concessions are harvested for taxonomy evolution.
- **Convergence diagnostics** — Seven deterministic metrics (computed from the argument graph, not from LLM calls) track debate health: move disposition, engagement depth, recycling rate, strongest opposing argument, concession opportunity, position delta, and crux rate.

---

### Stage 4: Reflect & Evolve

After synthesis, each debater enters a **reflection** phase — a meta-cognitive pass where they review the full argument network, their commitments, and what their opponents argued. Each debater is asked: *"Given everything that happened in this debate, what changes — if any — should be made to the taxonomy?"*

Reflections produce concrete, evidence-backed taxonomy edit proposals:

| Edit Type | What It Does |
|-----------|-------------|
| **Revise** | Update a node's description to account for evidence surfaced in debate |
| **Add** | Propose a new node for a concept the taxonomy doesn't cover |
| **Qualify** | Add a boundary condition or caveat to an existing node |
| **Deprecate** | Flag a node as no longer defensible based on debate evidence |

Each proposal carries a confidence level and references specific debate moments as evidence. **All edits require human review** — the system proposes evolution, it doesn't automate it.

This creates a **living taxonomy** — one that grows not just through document ingestion but through the adversarial testing of its own content. The next debate runs against the updated taxonomy, producing a continuous refinement cycle:

**Seed → Grow → Debate → Reflect → Grow → Debate → Reflect → ...**

---

### The Closed Loop

The key insight is that each stage feeds the next:

```
Documents ──→ Taxonomy ──→ Debates ──→ Reflections ──→ Taxonomy (updated)
    ↑                                                        │
    └────────── Gap Analysis identifies missing sources ─────┘
```

- **Documents** grow the taxonomy through extraction and mapping
- **The taxonomy** grounds the debates with structured, ontologically-typed context
- **Debates** test the taxonomy's claims against competing perspectives
- **Reflections** propose revisions based on what survived adversarial scrutiny
- **Gap analysis** identifies what the taxonomy is missing and guides the search for new sources

The result is a multi-perspective knowledge structure that has been tested under argumentative pressure — not just compiled from documents, but refined through disagreement.

---

### By the Numbers (as of May 2026)

| | Count |
|---|---|
| Source documents ingested | 170+ |
| Taxonomy nodes (across 4 POVs) | 565+ |
| Cross-POV conflict instances | 1,500+ |
| Situation nodes (shared, 3 interpretations each) | 212 |
| Structured debate sessions | 93+ |
| Argument network claims extracted | 3,470+ |
| Argumentation schemes classified | 13 |
| Convergence diagnostics (deterministic) | 7 |
| Calibration parameters (auto-tuned) | 15 |
| Intellectual lineage entries tracked | 934 |
| Policy actions in shared registry | 1,080 |

---

### Design Principles

1. **Ontological grounding over flat labels** — BDI + DOLCE + AIF vocabulary ensures different kinds of claims are never conflated
2. **Adversarial epistemology** — Truth is tested through structured argument, not compiled through summarization
3. **Human-in-the-loop at decision points** — AI proposes, humans decide. No automated taxonomy evolution.
4. **Computational linguistics as quality infrastructure** — Genus-differentia descriptions, embedding-validated field weighting, negation-aware pragmatic signals, and domain vocabulary alignment ensure the system's language layer is as rigorous as its argumentation layer
5. **Neural-symbolic architecture** — LLMs generate content; symbolic components (QBAF, deterministic validation, graph traversal) provide structure, verification, and explanation

---

*AI Triad Research, 2026*
