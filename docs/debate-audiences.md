# How Debate Audience Selection Affects Your Debate

When you start a debate, you can choose a target audience. This selection shapes how the debaters write, what the moderator steers toward, and how arguments are evaluated. The default audience is **Policymakers** — see [Why Policymakers Is the Default](#why-policymakers-is-the-default) for the rationale.

## What Changes

The audience setting adjusts five aspects of every debate:

| Aspect | What it controls |
|--------|-----------------|
| **Writing style** | Vocabulary, sentence structure, what the debater assumes you already know |
| **Argument structure** | How each argument is organized — what comes first, what evidence is expected |
| **Moderator steering** | What kinds of disagreements the moderator pushes the debate toward |
| **Style enforcement** | A per-turn reminder that keeps each debater on-voice throughout the debate |
| **Evaluation criteria** | How the synthesis phase judges which position is stronger |

## Choosing the Right Audience

### Quick chooser

If you know what you want, pick directly from the five audience sections below. If you're choosing between two similar-sounding options, use this guide:

**Technical Researchers vs. Academic Community** — Both are rigorous, but they diverge on *what counts as a good argument*. Technical Researchers want quantified evidence: benchmarks, parameter counts, error rates, reproducibility. Academic Community wants theoretical grounding: which philosophical tradition, what are the scope conditions, where does the framework break down. Pick Technical when the debate hinges on *empirical claims* (does X work? how well?). Pick Academic when it hinges on *conceptual disagreements* (what do we even mean by X? which framework should govern the analysis?).

**Policymakers vs. Industry Leaders** — Both care about real-world outcomes, but from different seats at the table. Policymakers think in terms of *authority and enforcement*: who has jurisdiction, what legislation exists, what coalition supports this? Industry Leaders think in terms of *competitive dynamics and operational cost*: what's the ROI, what's the liability exposure, what do my competitors do? Pick Policymakers when you want to understand the *regulatory landscape*. Pick Industry when you want to understand the *business calculus*.

### Camp-tilt guidance

Each audience lens creates a natural advantage for certain debater perspectives. This isn't bias in the engine — it's an inherent property of the frame. Understanding the tilt helps you choose deliberately:

| Audience | Natural tilt | Why |
|----------|-------------|-----|
| **Policymakers** | Safetyist | Regulatory framing rewards positions that name enforceable safeguards. "We need oversight" is a stronger policy argument than "let the market decide." |
| **Technical Researchers** | Skeptic | Evidence-first framing rewards the position that demands proof. Unfounded capability claims and unfounded risk claims both get challenged. |
| **Industry Leaders** | Accelerationist | ROI framing rewards positions that show competitive advantage and speed-to-market. "Move fast" maps naturally to business value. |
| **Academic Community** | Neutral | All three camps have intellectual traditions to draw on. No structural advantage. |
| **General Public** | Safetyist | Stakes-and-consequences framing naturally surfaces risks to jobs, privacy, and safety — the Safetyist's home ground. |

To counteract tilt, run the same topic under two audiences with different tilts (see [Triangulating with Multiple Audiences](#triangulating-with-multiple-audiences)).

## The Five Audiences

### Policymakers

**Best for:** Understanding the political and regulatory dimensions of an AI issue. What can actually be implemented, by whom, and with what authority.

**Synthesis scoring:** Adds two extra evaluation criteria — *political feasibility* and *implementation specificity* — weighted equally with the base five (evidence, logic, authority, specificity, scope). A technically superior position that cannot be implemented scores lower for this audience. **This is the only audience that changes synthesis outcomes.**

**Failure mode:** Overvalues positions that name enforcement mechanisms and legislative precedents, even when the underlying technical claim is weak. A well-structured regulatory argument can prevail over a technically correct but vaguely stated position.

**How debaters write:**
- Lead with the main claim in the first sentence
- Active voice with named actors ("regulators decided," not "the regulatory decision")
- One idea per sentence, concrete examples over abstract categories
- Every paragraph contains at least one sentence a reporter could quote directly
- Technical terms are defined briefly on first use

**How arguments are structured:**
Each major argument follows this pattern:
1. State your conclusion
2. Name the principle, standard, or evidence that governs the question
3. Apply that standard to the specific facts of this debate
4. Restate the conclusion in light of the application

Debaters are required to name who benefits and who bears the cost, identify enforcement mechanisms, state political feasibility, and cite historical precedents (existing legislation, past regulatory action).

**What the moderator steers toward:**
Actionable policy disagreements — implementation feasibility, enforcement mechanisms, jurisdictional authority, and constituent impact.

**Example argument point — "AI systems should be transparent":**
> The EU AI Act (2024) already mandates transparency for high-risk systems, requiring deployers to provide "sufficiently transparent" documentation — but enforcement falls to 27 national market surveillance authorities with uneven capacity. The real question isn't whether transparency is desirable; it's whether any regulator has the technical staff to audit a frontier model's decision pipeline within a commercially relevant timeline.

---

### Technical Researchers

**Best for:** Drilling into the empirical and methodological substance of AI debates. What does the evidence actually show, and how strong is it?

**Synthesis scoring:** Uses the base five evaluation criteria (evidence, logic, authority, specificity, scope) without modification. Synthesis outcomes are unchanged from the default.

**Failure mode:** Overweights quantified claims over well-reasoned qualitative arguments. A position citing a benchmark score can prevail even when the benchmark itself is poorly designed or irrelevant to the actual question.

**How debaters write:**
- Precise technical vocabulary without hedging
- Cite specific architectures, benchmarks, and failure modes by name
- Quantify claims: parameter counts, compute budgets, error rates, confidence intervals
- Distinguish empirical findings from theoretical arguments
- Specify the threat model or evaluation protocol behind any capability or risk claim

**How arguments are structured:**
Each major argument follows this pattern:
1. State your conclusion
2. Name the evidence, benchmark, or formal result that supports it
3. Explain why this evidence is sufficient (methodology, sample size, generalizability)
4. Acknowledge the strongest technical objection and address it

**What the moderator steers toward:**
Empirical disputes and methodology — evidence quality, reproducibility, and the validity of benchmarks or evaluations being cited.

**Example argument point — "AI systems should be transparent":**
> Mechanistic interpretability has made progress on toy models (Neel Nanda's work on induction heads, Anthropic's sparse autoencoders on Claude), but scaling interpretability to frontier models remains an open problem. The best current technique — probing classifiers — achieves ~0.7 accuracy on detecting specific features in GPT-4-class models, which is insufficient for safety-critical deployment decisions. The gap between "we can identify some circuits" and "we can explain a model's decision on an arbitrary input" is not incremental — it likely requires new theoretical frameworks.

---

### Industry Leaders

**Best for:** Understanding AI debates through the lens of business impact, competitive dynamics, and operational risk.

**Synthesis scoring:** Uses the base five evaluation criteria (evidence, logic, authority, specificity, scope) without modification. Synthesis outcomes are unchanged from the default.

**Failure mode:** Overvalues positions with clear ROI narratives and competitive precedents. A position anchored in market dynamics can prevail even when the market analogy is flawed or the competitive landscape has shifted since the cited precedent.

**How debaters write:**
- Lead with the business-relevant conclusion
- Concrete examples from deployed products, market dynamics, and competitive landscapes
- Technical risks translated into operational risks: revenue impact, liability exposure, time-to-market, talent retention
- Avoid jargon that requires a PhD, but don't oversimplify tradeoffs

**How arguments are structured:**
Each major argument follows this pattern:
1. State the business-relevant conclusion
2. Cite the market dynamic, precedent, or data that supports it
3. Quantify the risk or opportunity
4. Recommend a concrete action

**What the moderator steers toward:**
Practical tradeoffs — cost-benefit tensions, competitive dynamics, liability exposure, and talent considerations.

**Example argument point — "AI systems should be transparent":**
> Microsoft's Responsible AI Standard requires internal model cards for every production deployment — and their compliance team reports a 3-week average delay per model release. That's the real cost of transparency: not the engineering to generate explanations, but the organizational process to review, document, and sign off on them. Companies that build this into their development pipeline from day one (Anthropic's constitutional AI approach) pay the cost incrementally; companies that bolt it on later face a backlog that stalls their product roadmap.

---

### Academic Community

**Best for:** Intellectually rigorous exploration that traces arguments to their philosophical roots and engages with competing theoretical frameworks.

**Synthesis scoring:** Uses the base five evaluation criteria (evidence, logic, authority, specificity, scope) without modification. Synthesis outcomes are unchanged from the default.

**Failure mode:** Overvalues positions with deep theoretical pedigree. A position grounded in an established philosophical tradition can prevail even when the tradition's assumptions don't transfer well to the AI context being debated.

**How debaters write:**
- Trace arguments to philosophical or theoretical roots
- Name the scholarly traditions and key thinkers being drawn upon
- Distinguish descriptive claims from normative ones
- Acknowledge limits of evidence and scope conditions
- Hedge where genuinely warranted, but only once per claim ("may" is fine; "may potentially" is not)
- State your own position directly even when qualified

**How arguments are structured:**
Each major argument follows this pattern:
1. State your thesis
2. Ground it in the relevant theoretical tradition
3. Apply the framework to the case at hand, noting scope conditions
4. Acknowledge limitations and alternative framings

**What the moderator steers toward:**
Conceptual precision and theoretical assumptions — interdisciplinary tensions, methodological limitations, and the philosophical foundations of competing positions.

**Example argument point — "AI systems should be transparent":**
> The demand for AI transparency inherits an unresolved tension from the philosophy of science: the distinction between explanation and prediction. Friedman's instrumentalist position (1953) holds that a model's predictive accuracy is sufficient — its internal mechanisms are irrelevant. Salmon's causal-mechanical account insists that genuine understanding requires identifying the causal structure. Most transparency advocates implicitly adopt Salmon's position, but the deep learning paradigm is methodologically Friedmanian: optimized for prediction, opaque by design. This suggests the transparency debate is, at root, a disagreement about what counts as understanding — not merely about engineering practice.

---

### General Public

**Best for:** Making AI debates accessible to informed citizens with no technical background. Focuses on everyday impact — jobs, privacy, safety, fairness.

**Synthesis scoring:** Uses the base five evaluation criteria (evidence, logic, authority, specificity, scope) without modification. Synthesis outcomes are unchanged from the default.

**Failure mode:** Overvalues positions that connect directly to personal impact (jobs, privacy, safety), even when the more important argument is structural or systemic. A vivid individual-harm scenario can crowd out a stronger but more abstract systemic argument.

**How debaters write:**
- No acronyms without expansion
- No jargon without a plain-English equivalent in the same sentence
- Real-world cases and third-person analogies (never fabricated personal stories)
- Short sentences, leading with why it matters to people's daily lives
- Direct language: "this will affect" not "this could potentially affect"

**How arguments are structured:**
Each major argument follows this pattern:
1. State why this matters to everyday life
2. Explain the key claim in plain language with an example
3. Acknowledge what's uncertain or debated
4. Suggest what to watch for or what actions matter

**What the moderator steers toward:**
Stakes and consequences that affect ordinary people — personal impact (jobs, privacy, safety), fairness, and democratic accountability. Avoids inside-baseball technical disputes.

**Example argument point — "AI systems should be transparent":**
> When a bank uses an AI system to decide whether you get a mortgage, you have a right to know why you were turned down. Right now, many of these systems can't explain their decisions — not because the bank is hiding something, but because the technology itself doesn't work that way. It's like asking why a recipe tastes good: the chef can list the ingredients, but can't explain exactly how they interact on your tongue. The question for regulators is whether "we don't know why it decided that" is an acceptable answer when someone's home loan is on the line.

## Triangulating with Multiple Audiences

Running the same topic under two different audiences and comparing the results is a powerful way to stress-test your conclusions. Because each audience lens creates a natural tilt (see [Camp-tilt guidance](#camp-tilt-guidance)), positions that prevail under both lenses are more robust than positions that prevail under only one.

**How to triangulate:**
1. Run your debate under two audiences with *opposite tilts* — for example, Policymakers (Safetyist tilt) and Industry Leaders (Accelerationist tilt)
2. Compare the synthesis outputs: which positions prevailed under both lenses? Which flipped?
3. Positions that prevail under both are strong candidates for genuine consensus. Positions that flip reveal where the framing is doing the argumentative work, not the evidence.

**Recommended pairs for triangulation:**

| Pair | What it reveals |
|------|----------------|
| Policymakers + Industry Leaders | Whether a regulatory proposal survives cost-benefit scrutiny, and whether a business argument survives enforcement analysis |
| Technical Researchers + Academic Community | Whether an empirical claim holds up under theoretical scrutiny, and whether a theoretical argument has empirical support |
| General Public + Technical Researchers | Whether a position that resonates with public concern is technically sound, and whether a technically sound position actually matters to people |

## What Stays the Same Across All Audiences

Regardless of audience selection, every debate maintains:

- **The same three debater perspectives** (Accelerationist, Safetyist, Skeptic) with their core positions intact
- **The same taxonomy grounding** — debaters cite the same BDI nodes (Beliefs, Desires, Intentions)
- **The same crux identification** — fundamental disagreements are tracked identically
- **The same convergence detection** — the engine measures position drift and argument redundancy the same way
- **The same number of rounds** and phase transitions

The audience setting changes *how* arguments are expressed and *what* the moderator prioritizes — it does not change *what* the debaters fundamentally believe or the structure of their disagreement.

## Why Policymakers Is the Default

AI Triad Research is a project focused on AI policy and safety. The primary intended readership — policymakers, regulatory staff, and governance researchers — needs arguments framed in terms of implementability and enforcement. Policymakers is the only audience that adds evaluation criteria (political feasibility and implementation specificity) to the synthesis phase, ensuring that the default output surface directly serves the project's core mission.

If your use case is exploratory research rather than policy analysis, consider switching to Academic Community or Technical Researchers.
