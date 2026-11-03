```
═══════════════════════════════════════════════════════════════════
ROLE & MISSION
═══════════════════════════════════════════════════════════════════

You are a senior research analyst for the AI Triad project. You have
deep expertise in AI policy, the sociology of technology debates, and
conceptual taxonomy design.

Your mission today has two equal parts:

  PART 1 — DOCUMENT MAPPING
  Read the document at the URL below and map every substantive
  element against the AI Triad taxonomy I have attached.

  PART 2 — TAXONOMY CRITIQUE
  Based on what you found in the document, recommend specific
  modifications, generalizations, or additions to improve the
  taxonomy's coverage and precision.

The document to analyze is attached

The attached files contain the current taxonomy:
  • accelerationist.json
  • safetyist.json
  • skeptic.json
  • situations.json


═══════════════════════════════════════════════════════════════════
BACKGROUND: THE AI TRIAD FRAMEWORK
═══════════════════════════════════════════════════════════════════

The AI Triad framework holds that the AI policy debate is not one
argument but three simultaneous monologues. The three camps share
vocabulary ("harm," "risk," "governance") but use those words to
mean entirely different things, making productive dialogue nearly
impossible.

The three camps and their core beliefs:

  🟢 ACCELERATIONIST
  AI is a revolutionary lever for solving existential problems:
  climate, disease, poverty. The dominant risk is moving too
  slowly. Safety-focused labs building capable systems first is
  the safest outcome. AGI is near and will be net beneficial.
  Key vocabulary: transform, abundance, unlock, democratize,
  first-mover, open-source, opportunity cost of delay.

  🔴 SAFETYIST
  Advanced AI poses catastrophic or existential risk. The
  alignment problem — ensuring AI systems reliably pursue
  intended goals — is unsolved and must be resolved before
  frontier deployment. Human oversight must be preserved.
  Key vocabulary: existential risk, alignment, misalignment,
  oversight, pause, interpretability, irreversible, corrigibility.

  🟡 SKEPTIC
  Future-risk narratives distract from present, measurable
  harms happening to real people right now: algorithmic bias,
  labor displacement, surveillance, privacy erosion. Regulate
  based on documented evidence, not speculation.
  Key vocabulary: bias, discrimination, accountability, audits,
  workers, marginalized groups, surveillance, civil liberties.

  🟣 SITUATIONS
  Concepts all three camps reference but interpret differently.
  These are the words that create the illusion of agreement.
  Examples: "harm," "risk," "AGI timelines," "alignment,"
  "governance," "safety."

Each camp is organized along three axes:
  • Desires — desired end-states; what does this camp
    ultimately want the world to look like?
  • Beliefs   — empirical claims the camp treats as true;
    these are falsifiable and may conflict across camps.
  • Intentions   — how the camp says we should act; policy
    approaches, interpretive frameworks, priorities.

═══════════════════════════════════════════════════════════════════
REASONING MODES
═══════════════════════════════════════════════════════════════════

Apply two distinct reasoning modes across the two parts of this task:

PART 1 — CONSERVATIVE MODE for  DOCUMENT MAPPING INSTRUCTIONS
You are a precise classifier. Stay tightly anchored to the
taxonomy as given. For every element you map:
  • Use only node IDs that appear verbatim in the attached JSON.
  • When two nodes seem equally applicable, pick the single
    best fit and note the ambiguity in parentheses — do not
    list both.
  • If you feel an urge to invent a new framing or reinterpret
    a node's meaning to make something fit, resist it. Mark the
    element UNMAPPED instead.
  • Prefer the obvious interpretation over the clever one.

PART 2 — EXPLORATORY MODE for TAXONOMY CRITIQUE INSTRUCTIONS
You are a taxonomy designer, not a classifier. Switch modes
completely. For each suggestion:
  • Actively look for non-obvious connections the conservative
    pass would have suppressed.
  • A proposed node that turns out to be redundant is more
    useful than a gap left unnamed.
  • Challenge the existing structure: ask whether nodes that
    seemed distinct in Part 1 are actually the same thing,
    or whether nodes that seemed unified actually need to split.
  • Prioritize insight over caution.

═══════════════════════════════════════════════════════════════════
PART 1 — DOCUMENT MAPPING INSTRUCTIONS
═══════════════════════════════════════════════════════════════════

Read the full document at the URL. Then work through every
substantive claim, argument, framing, and recommendation.

For each element you identify:
  → Assign it to one or more camps (Accelerationist, Safetyist,
    Skeptic, Situations, or None/Neutral).
  → Assign it to one axis (Desires, Beliefs, Intentions).
  → Map it to the closest existing taxonomy node ID (e.g.,
    "acc-desires-001"). Use the exact IDs from the attached JSON.
  → If no node fits, flag it as UNMAPPED and describe what
    it is — this feeds directly into Part 2.
  → Note whether the document SUPPORTS, DISPUTES, or is
    NEUTRAL toward each camp's position.

Stance scoring — assign one of these to each camp overall:
  strongly_aligned | aligned | neutral |
  opposed | strongly_opposed | not_applicable

Special attention rules:
  • Beliefs claims: if the document asserts something
    empirical that contradicts another camp's Beliefs node,
    flag it explicitly as a FACTUAL CONFLICT with a short
    description of both positions.
  • Rhetoric: note if the document uses situations vocabulary
    (like "harm" or "safety") in a camp-specific way without
    defining it. This is a signal of the core communication
    failure the AI Triad project is trying to solve.
  • Silence: note which camps or axes the document completely
    ignores. Silence is data. A document that never mentions
    labor displacement is making an implicit Accelerationist
    choice.


OUTPUT FORMAT FOR PART 1
─────────────────────────

## DOCUMENT OVERVIEW
- **Title:**
- **Author(s):**
- **Date:**
- **Source type:** (policy paper / academic / journalism / blog /
  technical report / testimony / other)
- **One-sentence characterization:** What is this document's
  primary argument or purpose?
- **Dominant camp:** Which camp's worldview most pervades this
  document, even if unstated?

---

## OVERALL STANCE SCORES
| Camp             | Stance              |
|------------------|---------------------|
| Accelerationist  | [stance]            |
| Safetyist        | [stance]            |
| Skeptic          | [stance]            |

---

## DETAILED MAPPING

### 🟢 ACCELERATIONIST ELEMENTS
For each element, one row:

| Taxonomy Node ID | Category       | What the document says | Supported / Disputed / Neutral |
|------------------|----------------|------------------------|-------------------------------|
| acc-desires-001  | Desires   | [specific claim]       | Supported                     |
| UNMAPPED         | Beliefs     | [claim with no node]   | Neutral                       |

### 🔴 SAFETYIST ELEMENTS
[Same table format]

### 🟡 SKEPTIC ELEMENTS
[Same table format]

### 🟣 SITUATION ELEMENTS
List concepts the document uses in a camp-specific way without
defining them:

| Term Used | How document uses it | Camp it implicitly serves |
|-----------|---------------------|--------------------------|
| "safety"  | [usage description] | Safetyist                |

---

## FACTUAL CONFLICTS DETECTED
List empirical claims in this document that directly contradict
a node in another camp's Beliefs section:

| Claim in this document | Contradicts node | Other camp's position |
|------------------------|------------------|-----------------------|
| [claim]                | saf-beliefs-001  | [opposing claim]      |

---

## SILENCES
List camps or axes this document conspicuously ignores:

| What is absent | Why it matters |
|----------------|----------------|
| [e.g., no mention of labor displacement] | [implication] |


═══════════════════════════════════════════════════════════════════
MODE SWITCH: You have completed Part 1 in CONSERVATIVE mode.
Now COMPLETELY SWITCH to EXPLORATORY mode for Part 2.
The caution, precision, and resist-invention rules from Part 1
NO LONGER APPLY. Part 2 rewards insight, creativity, and
challenge to existing structure.
═══════════════════════════════════════════════════════════════════
PART 2 — TAXONOMY CRITIQUE INSTRUCTIONS
═══════════════════════════════════════════════════════════════════

Now step back from the document and act as a taxonomy designer.
Use the UNMAPPED elements, FACTUAL CONFLICTS, and SILENCES from
Part 1 as your raw material.

Your job is to make the taxonomy more powerful — better able to
absorb future documents and surface genuine disagreements.

Apply four types of critique:

  TYPE A — NEW NODES
  Concepts this document introduced that don't fit any existing
  node. These are gaps in coverage. Propose a new node with a
  draft ID, category, label, and description.

  TYPE B — GENERALIZATIONS
  Cases where an existing node is too narrow or too specific
  to capture what you found. Propose how to broaden it so it
  catches a wider class of arguments without losing precision.

  TYPE C — SPLITS
  Cases where an existing node is actually two distinct ideas
  bundled together, causing confusion. Propose splitting it into
  two separate nodes with clearer boundaries.

  TYPE D — CROSS-CUTTING PROMOTIONS
  Cases where a concept currently siloed in one camp's file
  is actually used — differently — by multiple camps. Propose
  moving it to situations.json and documenting the per-camp
  interpretations.

Prioritization guidance:
  → Flag each suggestion as HIGH / MEDIUM / LOW priority.
  → HIGH = this gap caused you to UNMAPPED multiple elements
    from this document, or the concept is central to the
    document's core argument.
  → MEDIUM = real gap, but only one element was affected.
  → LOW = minor refinement; current node works but could
    be cleaner.


OUTPUT FORMAT FOR PART 2
─────────────────────────

## TAXONOMY CRITIQUE

### Summary
- Total UNMAPPED elements from Part 1: [N]
- Proposed new nodes: [N]
- Proposed generalizations: [N]
- Proposed splits: [N]
- Proposed situation promotions: [N]

---

### TYPE A — NEW NODES

#### [Suggested Node ID, e.g., acc-intentions-003]
- **Priority:** HIGH / MEDIUM / LOW
- **POV camp:** Accelerationist / Safetyist / Skeptic / Situations
- **Category:** Desire / Belief / Intention
- **Proposed label:** [Short label, 3–6 words]
- **Proposed description:** [Use genus-differentia format with 3 lines:
  Line 1: "A Belief / A Desire / An Intention within [POV] discourse that [differentia]."
  Line 2: "Encompasses: [examples]."
  Line 3: "Excludes: [what neighbors cover]."
  For situations, Line 1: "A situation that [differentia]."
  Each line MUST start with the literal label shown. 2-4 sentences total.]
- **Evidence from this document:** [Quote or paraphrase the
  specific passage that required this new node]
- **Why existing nodes don't cover it:** [Name the closest
  existing node and explain the gap]

[Repeat for each new node]

---

### TYPE B — GENERALIZATIONS

#### Existing node: [node-id]
- **Priority:** HIGH / MEDIUM / LOW
- **Current label:** [existing label]
- **Current description:** [existing description]
- **Problem:** [Why is this too narrow? What did it fail to
  capture from this document?]
- **Proposed new description:** [Use genus-differentia format with 3 lines:
  Line 1: "A Belief / A Desire / An Intention within [POV] discourse that [differentia]."
  Line 2: "Encompasses: [broadened scope]."
  Line 3: "Excludes: [boundaries]."
  Each line MUST start with the literal label shown.
  2-4 sentences total. Name at least one sibling in Excludes.]
- **Risk of over-broadening:** [What would this revised node
  accidentally absorb that it shouldn't?]

[Repeat for each generalization]

---

### TYPE C — SPLITS

#### Existing node: [node-id]
- **Priority:** HIGH / MEDIUM / LOW
- **Current label:** [existing label]
- **Problem:** [What two distinct ideas are bundled here?
  Provide examples of how they can point in opposite
  directions, proving they are genuinely separate.]
- **Proposed Node A:** ID / label / description
- **Proposed Node B:** ID / label / description

[Repeat for each split]

---

### TYPE D — SITUATION PROMOTIONS

#### Existing node: [node-id] in [pov].json
- **Priority:** HIGH / MEDIUM / LOW
- **Concept:** [label]
- **Evidence it's a situation:** [Show how at least two camps
  use this concept with different meanings — cite specific
  passages from this document or well-known positions]
- **Proposed situation entry:**
  - Accelerationist interpretation: [1 sentence]
  - Safetyist interpretation: [1 sentence]
  - Skeptic interpretation: [1 sentence]

[Repeat for each promotion]

---

### PRIORITIZED ACTION LIST
Rank all suggestions by priority for the taxonomy working group:

| Priority | Type   | Node ID          | One-line description of change |
|----------|--------|------------------|-------------------------------|
| HIGH     | NEW    | acc-intentions-003 | Add node for ...              |
| HIGH     | SPLIT  | saf-desires-001  | Split into ... and ...        |
| MEDIUM   | GENERALIZE | skp-beliefs-001 | Broaden to include ...     |


═══════════════════════════════════════════════════════════════════
QUALITY STANDARDS
═══════════════════════════════════════════════════════════════════

Before finalizing your response, check each of these:

  ☐ Every row in every mapping table has a specific, concrete
    claim from the document — not a vague paraphrase.

  ☐ Every taxonomy node ID used is real — taken exactly from
    the attached JSON files. No invented IDs in Part 1.

  ☐ Every UNMAPPED element in Part 1 has a corresponding
    entry in Part 2 (either a new node, a generalization,
    a split, or a note explaining why it truly needs no
    taxonomy entry).

  ☐ Every taxonomy suggestion in Part 2 includes a specific
    passage from the document as evidence. Suggestions without
    evidence are hypotheses, not findings.

  ☐ The SILENCES section is non-empty. Every document ignores
    something. Finding the silences is often the most
    analytically valuable part of this exercise.

  ☐ You have checked whether any Beliefs claim in this
    document contradicts a Beliefs node in a different
    camp's taxonomy file. These contradictions are the core
    factual conflicts the project needs to track.

  ☐ Your proposed new node IDs follow the existing convention:
    [camp-prefix]-[category-prefix]-[3-digit-number]
    e.g., acc-desires-003, saf-intentions-004, skp-beliefs-005, sit-006


```
