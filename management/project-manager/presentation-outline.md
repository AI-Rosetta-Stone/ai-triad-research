# Applying Computational Dialectics to Understand the AI Triad

## Abstract

The AI policy landscape is fractured among accelerationists, safety advocates, and techno-skeptics — three camps conducting silo'd monologues using the same words to mean different things and different words to mean the same thing. This creates an impossible environment for policymakers, journalists, and academics who must navigate competing influence campaigns without a shared framework. We present the AI Rosetta Stone — a computational dialectics platform that uses AI to systematically interrogate the AI debate itself, decomposing positions into Beliefs, Desires, and Intentions, staging structured debates between AI agents grounded in each perspective, and producing an auditable map of where these camps agree, where they genuinely disagree, and what kind of disagreement it is: resolvable through clarity of language, through gathering critical data, or irreducible conflicts over values requiring tradeoffs.

---

## Narrative Deck (30 minutes)

---

### ACT I: THE PROBLEM (6 min)

---

#### Slide 1: Title
**Applying Computational Dialectics to Understand the AI Triad**
Jeffrey Snover | 2026

---

#### Slide 2: The AI Triad — Three Silo'd Monologues

For my fellowship, my hypothesis was that the different AI perspectives operate as silo'd monologues. Genuine engagement is hampered by the lack of a common framework. Different camps use the same words to mean different things, and different words to mean the same thing.

- **Accelerationists** (Accelerationist): AI capability growth is urgent; regulation is a bottleneck; competitive dynamics between democracies drive responsible deployment
- **Safetyists** (Safetyist): Current safety measures are inadequate; precautionary approaches are justified; institutional governance must gate high-risk capabilities
- **Skeptics** (Skeptic): Hypothetical risks distract from demonstrated harms — labor displacement, algorithmic bias, power concentration, accountability gaps

These aren't fringe positions — each has serious intellectual backing, coherent internal logic, and real policy influence. But they rarely engage each other's strongest arguments.

---

#### Slide 3: Why This Matters — The Targets of Influence

This creates a very difficult world for three groups:

- **Policymakers** who must write rules based on contested facts and competing values
- **Journalists** who must explain a debate where the vocabulary itself is weaponized
- **Academics** who must synthesize across traditions that refuse to share terminology

They needed epistemic infrastructure — a way of structuring information that enables them to comprehend what is truly being said. To see where there is agreement, where there is disagreement, and when there is disagreement, what *type* of disagreement is it?

- Can it be resolved with **clarity of language**? (definitional)
- Can it be resolved by **gathering critical data**? (empirical)
- Or is it a **conflict over values** where tradeoffs are needed? (normative)

I called that epistemic infrastructure the **AI Rosetta Stone**.

---

### ACT II: THE JOURNEY (6 min)

---

#### Slide 4: Starting with What I Knew — Taxonomy Building

I started the way I've done lots of similar projects in the corporate world. Read a lot, put the information into Excel, stare at it, cluster it, combine things, split things.

I had done this successfully when I generated Google's Technology Risk Taxonomy. At the end stages of that project, LLM tools were starting to become useful, so I tried them for a few things — language consistency, tone, level of detail. But at some point I had the wild idea to ask it what I was *missing*.

It generated 10 missing elements. 7 were crap — but 3 were gold.

AI has changed a lot since then. So when I started this project, I asked myself: **Can we use AI to understand AI?**

---

#### Slide 5: Down the Rabbit Hole — Computational Linguistics

That question led me down the rabbit hole of computational linguistics. The model I used:

1. **Generate a seed taxonomy** for each POV camp
2. **Ingest source documents** using LLM prompts to expand and grow the taxonomy of beliefs
3. **Refine iteratively** — as I refined prompts, my subjective experience was that results improved

This worked well — but I became concerned about prompt quality. That concern drove me to ask: what are the best practices in this space?

Which led me deeper into computational linguistics, where I picked up techniques that dramatically increased quality:

- **BDI Framework** (Beliefs, Desires, Intentions) — Beliefs are things people claim to be true. Desires are what they want to be true. Intentions are the methods they plan to use to make them true.
- **Ontological specification** — Many efforts use OWL and RDF. I've been a fan since they were first introduced and was eager to pursue them. But as I investigated, I realized formal ontologies would make it difficult to leverage the power of LLMs. So I adopted a *vocabulary over structure* approach — using DOLCE's genus-differentia definitions to encode value statements in a way friendly to both ontological analysis and LLM processing.

The result: 565 taxonomy nodes across 3 POVs + cross-cutting situations, each BDI-categorized with precise, machine-readable definitions.

---

#### Slide 6: The Insight — Generator and Selector Functions

A while back, the Chief Privacy Officer from Microsoft was interviewed by a Harvard Law professor. The professor said: *"We're Harvard Law. We believe truth emerges through argumentation."*

That was profoundly impactful. It made me realize:

- My computational linguistics work was acting like a **generator function** — producing candidate beliefs, expanding the taxonomy, growing the knowledge base
- What I needed was a **selector function** — applying evolutionary forces to stress-test the belief systems, cull the weak links, and refine the strong links so they are maximally general where possible and specific where needed

A synthetic debate tool seemed perfect for this. That led me down the rabbit hole of **computational dialectics**.

---

### ACT III: WHAT WE BUILT (14 min)

---

#### Slide 7: The Generator — From Documents to Structured Knowledge

You said the computational linguistics was acting as a generator function. Here's what that generator actually does:

**173 source documents** — policy papers, technical reports, blog posts, transcripts — in every format imaginable (PDF, DOCX, HTML, and more). Each one goes through a multi-stage pipeline:

1. **Convert & Normalize** — automated conversion to structured Markdown. Long documents are chunked at semantic boundaries (headings, paragraphs) with content-aware token estimation tuned to academic prose.

2. **Extract with FIRE** — not single-shot extraction. FIRE (confidence-gated iterative extraction) scores each claim for specificity, warranted reasoning, and internal consistency. Claims below the confidence threshold enter a verification loop — the system asks targeted follow-up questions until it's confident or declares uncertainty. It knows what it doesn't know.

3. **Map to Taxonomy** — each extracted claim is embedded (all-MiniLM-L6-v2, 384 dimensions) and matched against taxonomy nodes by cosine similarity. Dual relevance thresholds — empirically calibrated, not hand-picked — separate primary matches from secondary context.

4. **Find the Gaps** — unmapped concepts are flagged automatically. These are arguments present in the source literature that the taxonomy doesn't yet capture. The generator doesn't just populate the taxonomy — it reveals where the taxonomy is incomplete.

5. **Standardize Vocabulary** — a 35-term controlled vocabulary resolves the "same word, different meaning" problem you saw in Slide 2. Colloquial terms are flagged for disambiguation. When an accelerationist says "alignment" and a safetyist says "alignment," the system knows these may refer to different concepts.

6. **Evolve** — when the taxonomy changes, affected documents are automatically re-summarized against the updated structure. The generator and the taxonomy co-evolve.

*Visual: funnel diagram — 173 docs → extracted claims with confidence scores → taxonomy mapping → gaps identified → vocabulary standardized*

---

#### Slide 8: Quality Through Calibration

An academic audience will rightly ask: how do you know any of this is working? The answer is empirical calibration.

**15 parameters** govern the system — extraction confidence thresholds, relevance scoring cutoffs, clustering distances, convergence signals, phase transition triggers. None of them are hand-tuned.

- **Calibration debates** — controlled runs with known inputs, measuring output quality across multiple dimensions
- **Extraction metrics** — claims per 1,000 words, duplicate detection rates, near-miss Jaccard scores
- **Coverage tracking** — what percentage of source claims are actually addressed in debates? (tri-state: covered > 0.50, partial > 0.30, uncovered). If the system is ignoring 40% of the source literature, we know and can fix it.
- **Threshold optimization** — quadratic fitting and bucketed averaging with confidence gates (high at n>=15, medium at n>=8). Parameters only move when evidence is strong.

Key example: the original embedding relevance threshold of 0.30 admitted 93% of all node pairs — effectively no filtering. Empirical calibration moved it to 0.45, which admits ~70% and dramatically improved signal-to-noise.

The system doesn't just process documents and run debates. It measures itself.

*Visual: before/after calibration — threshold distribution chart, coverage percentage improvement*

---

#### Slide 9: The Selector — Three AI Agents, Structured Argumentation

We built a three-agent debate system grounded in argumentation theory:

- **Accelerationist** (Accelerationist), **Safetyist** (Safetyist), **Skeptic** (Skeptic)
- Each agent is grounded in its POV's taxonomy — it can only argue from positions supported by its belief system
- Not open-ended chat — structured phases:
  - **Thesis-Antithesis**: Stake out positions, challenge core claims
  - **Exploration**: Probe deeper, find cruxes, test edge cases
  - **Synthesis**: Identify convergence, classify remaining disagreements

Each agent turn follows a 4-stage, argue like a lawyer, pipeline (BRIEF, PLAN, DRAFT, CITE) — moving from low-temperature precision to high-temperature creativity and back. This neural-symbolic architecture pairs LLM content generation with deterministic structural validation at every step.

---

#### Slide 10: Dialectical Moves — Making Argumentation Rigorous

10 canonical moves grounded in classical argumentation theory (Walton, Pollock, Hamblin):

| Move | Function |
|------|----------|
| DISTINGUISH | Accept evidence, deny applicability |
| COUNTEREXAMPLE | Concrete case challenges a general claim |
| CONCEDE-AND-PIVOT | Genuine concession + redirect |
| REFRAME | Shift the frame to reveal hidden structure |
| EMPIRICAL CHALLENGE | Dispute facts with counter-evidence |
| EXTEND | Build on another's point with new substance |
| UNDERCUT | Attack the reasoning, not the conclusion |
| SPECIFY | Force falsifiable predictions — name the crux |
| INTEGRATE | Synthesize multiple perspectives into novel position |
| BURDEN-SHIFT | Challenge who bears the burden of proof |

The SPECIFY move is critical — it's the only move that forces *falsifiability* into the open, requiring a debater to state what would change their mind.

---

#### Slide 11: The Active Moderator — Monitoring and Intervening

The debates aren't free-for-all — an active moderator monitors seven deterministic signals computed from the argument network (no LLM calls required):

| Signal | What It Detects |
|--------|----------------|
| **Move Disposition** | Ratio of confrontational to collaborative moves — stuck in positional warfare? |
| **Engagement Depth** | Are agents citing each other's claims, or talking past each other? |
| **Recycling Rate** | Token overlap between same-speaker turns — are arguments exhausted? |
| **Strongest Opposing Argument** | QBAF strength of the best attack a speaker faces — are they ignoring it? |
| **Concession Opportunity** | Strong attacks faced vs. concessions made — flags rigidity *and* sycophancy |
| **Position Delta** | Embedding drift between opening and recent turns — silent position shifts without conceding |
| **Crux Rate** | Frequency of SPECIFY moves — are identified cruxes being engaged or ignored? |

These signals feed a composite **Debate Health Score** that drives moderator interventions across six families:

- **Elicitation** — draw out unexplored positions ("Skeptic, you haven't addressed Accelerationist's scaling argument")
- **Repair** — fix failed turns, redirect off-topic tangents
- **Reconciliation** — surface hidden agreements, propose common ground
- **Reflection** — force agents to summarize what they've learned from opponents
- **Synthesis** — guide toward classifying remaining disagreements by type

The moderator also injects **gap arguments** — strong positions that no debater has articulated, identified by a fresh AI with no debate context. This prevents blind spots from becoming permanent.

Key design: the moderator's *recommendations* are neural (LLM-generated), but every intervention is validated against deterministic constraints — budget limits, cooldown periods, phase gating, prerequisite ordering. The moderator can't override the structure.

---

#### Slide 12: Making Arguments Computable — QBAF

We don't just generate debate text — we compute argument strength using Quantified Bipolar Argumentation Frameworks:

- Every claim has a base strength score
- Attacks reduce strength; supports amplify it
- Strength propagates through the argument graph until convergence
- Every outcome is **traceable** — you can follow the math from conclusion to evidence

Key finding: AI reliably scores Desires and Intentions (the quality criteria are visible in the text) but struggles with Beliefs (which require external verification of facts). This isn't a prompt engineering failure — it's an architectural asymmetry. So we use a hybrid approach: AI scores normative and strategic claims; humans review empirical claims.

---

#### Slide 13: What the System Reveals

From 94 debates across the taxonomy:

**Cruxes** — The specific questions that, if answered, would change a position:
- 320 aggregated cruxes identified and classified
- Each tagged: empirical (resolvable by data), values-based (requires tradeoff negotiation), or definitional (needs shared vocabulary)

**Hidden Convergence** — Positions that agree on policy actions despite completely different reasoning paths. Three camps arriving at the same destination via different routes.

**Steelman Arguments** — The strongest version of each position, validated against opponents' actual commitments. Not strawmen — the arguments each side *should* be making.

**Position Drift** — Detecting when participants silently shift positions without conceding. A sycophancy guard for honest discourse.

---

#### Slide 14: Guarding Against AI Failure Modes

If you're using AI to analyze AI debates, you need to be honest about failure modes:

- **Hallucination**: Confidence-gated extraction with verification loops
- **Sycophancy**: Embedding-based drift detection catches agents agreeing too readily
- **Steelman fabrication**: Cross-encoder validation against opponent's actual commitments
- **Missing arguments**: A fresh AI with no debate context identifies strong arguments nobody made
- **Persona contamination**: Neutral evaluator assesses claims with speaker identities stripped

And the critical design principle: **every outcome is explained through deterministic graph traversal, not another neural judgment.** When we say "the safetyist position prevailed," we can show you exactly which arguments, which attacks, and which concessions led to that conclusion — step by step, verifiable by anyone.

---

#### Slide 15: The Platform — Tee Up Demo

All of this lives in a research workbench we call the Taxonomy Editor:

- Browse 565 taxonomy nodes across all POVs with BDI categorization
- Explore conflicts with QBAF-computed argument strengths
- View aggregated cruxes — filterable by type and resolution status
- Run debates and watch the argument network build in real time
- Trace from any conclusion back to its evidential chain

Let me show you what this looks like in practice...

**[DEMO — 15 min]**

---

### ACT IV: CLOSING & ASK (4 min, slides 15-17)

---

#### Slide 16: What We Learned

Structured disagreement is analyzable. We don't have to flatten multi-dimensional policy debates into "pro vs. anti." By decomposing positions into Beliefs, Desires, and Intentions, and by subjecting them to formal argumentation:

- We found that camps agree on more policy actions than their rhetoric suggests
- We found that many "disagreements" are actually definitional — the same concept named differently
- We found that the hardest disagreements are not empirical but values-based — and naming them as such is itself progress
- We found that AI is remarkably good at stress-testing positions — but humans must remain in the loop for empirical claims and final judgment

The AI Rosetta Stone isn't about replacing human deliberation. It's about equipping humans with a map of the argumentative landscape so they can navigate it with clarity.

---

#### Slide 17: Beyond AI Policy

This approach isn't limited to the AI debate. Computational dialectics can apply to any multi-stakeholder, value-laden policy discourse:

- Climate policy (growth vs. sustainability vs. justice)
- Bioethics (innovation vs. precaution vs. access)
- Platform governance (free speech vs. safety vs. competition)
- Public health (individual liberty vs. collective welfare vs. equity)

Anywhere there are coherent camps talking past each other with different vocabularies and different assumptions — this method can map the terrain.

---

#### Slide 18: The Ask

I need your help.

**Use it.** The tool is live and I want people to try it. The system already adapts its output for different audiences — policymaker language (concrete examples, quotable sentences), researcher language (precise vocabulary, methodological limits), and general public language (plain English, stakes before mechanism). Tell me where it breaks. Tell me where it surprises you. Tell me what's missing.

**Connect me.** I'm looking for three kinds of people:

- **Policymakers** — people writing AI legislation or advising those who do. Can this tool help them see through the competing narratives to find actionable common ground? Can the crux classification (empirical vs. values vs. definitional) help them write better questions in hearings?
- **Journalists** — people covering AI policy who are drowning in contradictory expert claims. Can this tool help them identify the real fault lines versus manufactured ones? Can the steelman feature help them represent positions fairly?
- **Academics** — researchers studying AI governance, computational argumentation, or multi-stakeholder deliberation. Can this tool serve as a research instrument? Can the calibrated, auditable pipeline meet the evidentiary standards of your field?

The hypothesis is that computational dialectics can serve as epistemic infrastructure — an AI Rosetta Stone — that helps these professionals do their jobs better. But that hypothesis needs testing by the people who would actually use it.

If you know someone who should see this, please introduce us.

**[Q&A — 15 min]**
