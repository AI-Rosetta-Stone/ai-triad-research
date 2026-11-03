# The Rosetta Stone Project: Theory of Success

**AI Triad Research · 2026**

*A theory of success states what problem a project solves, how it solves it, and why that
approach is the right one. This document does that for the Rosetta Stone Project. Read it first,
then follow the pointers into the detailed design docs.*

---

## 1. The Problem

### 1.1 The landscape problem

AI policy is not a single argument with two sides. It is a dense landscape of overlapping
worldviews (accelerationist, safetyist, skeptic), and each carries its own empirical model of how
AI develops, its own values about what matters, and its own strategies for what to do. People who
study this landscape need to understand more than *what* each camp claims. They need to see *how*
the claims relate: what supports what, what attacks what, and where the disagreements are
genuinely irreducible rather than only apparent.

The default tools do not give you this. A literature review gives you citations without structure.
A general-purpose AI chat gives you a single-perspective summary that flattens the disagreement
into "there are many views." Neither answers the one question a policy analyst actually needs
answered. Given all this argument, what specific question, if resolved, would move a position?

### 1.2 Why you cannot just prompt an LLM to debate itself

The obvious shortcut is to ask one model to play three characters and argue. It works, in the
sense that you get something that *looks* like a debate. But an LLM debating itself is a single
mind wearing three hats. One model, one training set, one set of biases, putting on three costumes
and pretending to disagree. That architecture has three failure modes no amount of prompt
engineering can fix.

1. **Ambiguity collapse.** The three characters silently resolve contested terms the same way
   underneath the surface disagreement. The model cannot report that it did this, any more than a
   fish can describe water. The genuine conceptual conflict, the part worth studying, never
   surfaces, because it was dissolved before the debate started.

2. **False consensus.** RLHF rewards helpfulness and agreeableness, so the arguments drift toward
   "balanced governance is important" by round five. This is sycophancy with extra steps. You
   cannot prompt your way out of it. Telling a model "don't agree too easily" is like telling water
   not to flow downhill.

3. **Nothing compounds.** Run the prompt again and you get a different debate with no memory of the
   first. There is no record of what was conceded and no accumulation of what survived challenge.
   Knowledge does not build.

These are the physics of the problem. A better prompt does not change them. A different
architecture does.

---

## 2. The Approach

The Rosetta Stone Project is to prompted debates what PowerShell was to the GUI: not a nicer
version of the same thing, but a different architecture built around the actual physics of the
problem. Three ideas do the work.

### 2.1 Three structurally distinct agents, not one mind in costume

The system stages a debate between three agents, Accelerationist, Safetyist, and Skeptic, each
grounded in its own curated slice of a taxonomy of 320+ argument nodes. Each agent argues from a
coherent epistemic stance built out of its Beliefs, Desires, and Intentions, rather than from a bag
of talking points. Because each agent's context is a genuinely different worldview drawn from the
scholarly literature, the disagreement between them is structural rather than performed.

### 2.2 A neural-symbolic pipeline: the LLM generates, deterministic systems validate and explain

The core design principle is that the LLM is never trusted on its own. Every model output passes
through symbolic validation before it enters the debate record, and every outcome is explainable by
walking a graph, with no need to re-query a model and ask why it decided something.

- **Every claim becomes a typed node** in an argument network, classified as a Belief (empirical),
  a Desire (normative), or an Intention (strategic). The type sets the evidence standard. Beliefs
  must cite evidence and are candidates for fact-checking, Desires must acknowledge tradeoffs, and
  Intentions must specify mechanisms.
- **Every attack becomes a weighted, typed edge.** The system records not merely that one claim
  attacks another but *how*, whether by rebut, undercut, or undermine. Argument strength is then
  computed with QBAF gradual semantics (DF-QuAD), so a claim attacked by strong, uncontested
  evidence actually gets weaker because the formal semantics require it, not because a model felt it
  should.
- **Nothing disappears when the context window fills.** Concessions live in a commitment ledger,
  not in prose that gets compressed away. A debater cannot quietly un-concede a point from three
  rounds ago, because the ledger holds the record.
- **A moderator enforces engagement.** It acts as a quality controller rather than a neutral party.
  It forces debaters to address claims they are avoiding (PIN), breaks repetition loops (PROBE,
  CHALLENGE), and stops any one agent from being ganged up on (burden tracking). Its interventions
  are advisory, and a deterministic engine holds veto power over every one of them.
- **A persona-free evaluator** reads the debate with all speaker labels stripped, at three
  checkpoints. Its neutral verdict is then compared against the persona-grounded synthesis. Where
  the two diverge, for instance the synthesis calls a point resolved while the evaluator still calls
  it contested, the gap is surfaced rather than hidden.
- **Outcomes are explained by graph traversal.** A deterministic breadth-first walk of the argument
  network produces a per-claim provenance chain of who argued what, what attacked it, and what
  survived, readable by a human with no further model call.

### 2.3 Preserving ambiguity instead of collapsing it: the Rosetta Stone function

The project's namesake mechanism is the **situation node**, a contested concept that carries three
structured interpretations at once, one per camp, and never resolves which is correct. The
adversarial process then reveals where those interpretations genuinely conflict. This is the
translation function of a Rosetta Stone. It holds three languages of salience side by side without
choosing a winner, so you can read the same situation through each worldview and see where the
readings come apart.

### 2.4 A closed loop: debates improve the taxonomy

The debate is not the product; the taxonomy is. Each debate feeds back into it. Concessions are
harvested, coverage gaps are diagnosed, and each agent proposes concrete taxonomy edits (revise,
add, qualify, deprecate) grounded in specific debate turns. Over many debates, the arguments that
repeatedly survive challenge from three structurally different perspectives stop being opinions and
become tested knowledge. The cycle is simple. Debate, reflect, update the taxonomy, debate again.

---

## 3. The Rationale

Why build all this infrastructure instead of writing a better prompt? Because each design choice
answers a specific failure the prompt-only approach cannot escape.

| Design choice | The failure it defeats | Why the choice works |
|---|---|---|
| Three taxonomy-grounded agents | One mind performing three views | Structural difference in context produces genuine rather than simulated disagreement |
| Typed argument network with QBAF semantics | "Winning" arguments decided by model vibe | Strength is a property of graph topology, computed the same way every time, auditable rather than opinion |
| Commitment ledger | Positions silently drifting; false consensus | A concession is recorded and cannot be reversed unacknowledged; per-claim drift detection fires when a debater abandons claims without an opponent conceding |
| Structural sycophancy guards | RLHF-driven agreeableness | Doctrinal boundaries, drift detection, and moderator interventions are validation-layer constraints, not prompt pleas, so false consensus becomes mechanically hard |
| Situation nodes with multiple interpretations | Ambiguity collapse | Contested terms are held open, so the conflict surfaces instead of dissolving |
| Persona-free evaluator with divergence view | Self-serving synthesis | An independent neutral reading is compared against the synthesis, and disagreements are flagged rather than smoothed over |
| Deterministic dialectic traces | "Trust me, this side won" | The outcome can be reconstructed by walking the graph, with no model in the loop |
| Closed feedback loop | Nothing compounds across runs | Insights persist as taxonomy edits and accumulating concession weights, so knowledge builds |

The tradeoff is real. This costs more, roughly 150 API calls against one, minutes against seconds,
tens of TypeScript modules against a paragraph of prompt. If you need a quick illustration of
different perspectives for a blog post, the prompted approach is genuinely the right tool, the way
a shovel beats a backhoe for a small hole. But if you need to actually know, with evidence, formal
justification, and an audit trail, where the irreducible disagreements lie, what questions would
resolve them, and which arguments survive real adversarial scrutiny, then you need the
infrastructure. The prompted debate is a GUI. It looks good, works for simple cases, and leaves no
record of what happened. The Rosetta Stone is the pipeline: typed, auditable, reproducible, and
built to hold up when the argument gets messy, which in AI policy it always does.

---

## 4. What Success Looks Like

Success is defined at two levels, per debate and across the project.

### 4.1 A successful debate produces five measurable outcomes

1. **Crux discovery.** The two to five questions on which the perspectives actually diverge are
   surfaced, rather than the surface talking points.
2. **Argument grounding.** Every claim traces to a taxonomy node or is flagged as novel. No claim
   floats without a warrant.
3. **Position movement.** At least one debater genuinely concedes, narrows, or conditionalizes a
   claim, and the commitment store records it with the triggering evidence. Three agents ending
   where they started is a system failure, not a failure to agree.
4. **Coverage.** The debate engages the relevant taxonomy, using more than 60% of the injected
   nodes, and it names the important nodes that went unused.
5. **Explainability.** A human can reconstruct why the debate concluded as it did by reading the
   dialectic trace, without re-querying any model.

A debate that hits all five is a contribution to the taxonomy. One that hits only a couple is still
useful as a diagnostic, because it shows where the system or the taxonomy is weak.

*(Full metric definitions, targets, and measurement sources live in
[`docs/theory-of-success.md`](theory-of-success.md) §5.)*

### 4.2 Project-level success

The taxonomy becomes more complete, more precise, and more internally consistent with every debate.
The debate engine is the mechanism by which three adversarial perspectives pressure-test every node,
edge, and interpretation, and the neural-symbolic architecture keeps that pressure test rigorous,
fair, grounded, and explainable. The long-run deliverable is not a pile of transcripts. It is a body
of AI-policy argument stress-tested to the point where what survives can be relied upon.

---

## 5. Where to Read Next

| To understand… | Read |
|---|---|
| The tool at a glance | [`README.md`](../README.md) |
| The full per-debate success criteria and metrics | [`docs/theory-of-success.md`](theory-of-success.md) |
| The complete debate architecture, phase by phase | [`docs/debate-system-overview.md`](debate-system-overview.md) |
| The case against prompt-only debate, in depth | [`docs/why-not-just-prompt-a-debate.md`](why-not-just-prompt-a-debate.md) |
| How the system is positioned and for whom | [`docs/market-positioning.md`](market-positioning.md) |
| The overall system architecture | [`docs/architecture-overview.md`](architecture-overview.md) |

---

*Jeffrey Snover · AI Triad Research · 2026*
