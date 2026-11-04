# Debate-Tested: A Testing-History Instrument for the AI Rosetta Stone Taxonomy

**Prepared for:** external review
**Prepared by:** Computational Linguist, AI Triad Research
**Date:** 2026-07-13
**Companion document:** `corroboration-design.md` (full technical specification: schemas, cmdlet signatures, module layout, phasing)
**Status of the underlying proposal:** approved by Technical Lead 2026-07-13, Beliefs-only v1 scope confirmed. Three independent external reviews of this document (2026-07-13) are addressed in `corroboration-design.md`'s changelog and in ticket t/1523; the amendments (exclusion-mechanism guardrails, validation-study scope, rollout resequencing, content-increase revision gate, proportional outcome aggregation, era-stamping) are reflected inline below. The instrument was originally named "Corroboration"; a third review found this borrowed Popper's authority for a mechanism (reducing future testing of well-tested claims) his own account explicitly forbids, so this document is renamed throughout to "Debate-Tested." An investigation into a complementary "crux-discovery-density" signal and an external-evidence pointer feature remain open, tracked separately (t/1534, t/1535).

## How to Read This Document

This is a review package, not the engineering specification. Section 1 gives the background an outside reader needs to evaluate the proposal without prior familiarity with the platform. Sections 2 through 4 describe the proposal itself at a conceptual level. Section 5 states its known limitations without softening them. Section 6 lists the specific questions we want a reviewer to answer. Exact data schemas, file paths, and implementation phasing live in the companion technical document, referenced where relevant but not reproduced here.

---

## 1. Background: The System This Proposal Extends

### 1.1 What the platform is

The AI Rosetta Stone is a research platform for multi-perspective analysis of AI policy discourse. It maintains a structured taxonomy of claims drawn from roughly 650 source documents, organizes them into three competing worldviews, and runs adversarial debates between AI agents representing those worldviews to test how the claims hold up under pressure. The platform is a research prototype, not a deployed product, and it serves one research team today.

### 1.2 The taxonomy: three perspectives, three kinds of claims

Every claim in the taxonomy belongs to one of three camps: **accelerationist** (AI capability growth and transformative potential), **safetyist** (alignment and existential risk), and **skeptic** (immediate harms, bias, institutional accountability). Within each camp, claims are further sorted by kind, following the Belief-Desire-Intention (BDI) framework from agent modeling:

- A **Belief** is an empirical claim about how the world is.
- A **Desire** is a normative claim about what should be prioritized.
- An **Intention** is a strategic claim about how to act.

The distinction matters because the three kinds are contestable in different ways. Evidence can refute a Belief but not a Desire; feasibility can challenge an Intention but not the values behind it. A node in the taxonomy is one such claim, identified by a short id like `saf-beliefs-017`, carrying a text description and various metadata. This proposal adds one more piece of metadata to each node.

### 1.3 How a claim gets tested: debates and the argument network

A debate is a structured exchange among three AI agents, one per camp, on a specific policy question. Relevant taxonomy nodes are injected into each agent's context at the start. As the debate proceeds, agents make statements that get parsed into discrete **claims**, which are assembled into an **argument network**. Claims are nodes, and typed edges connect them as *attacks* (rebut, undercut, undermine) or *supports*. A formal algorithm (a Quantitative Bipolar Argumentation Framework, QBAF) propagates numeric strength through this network, so a claim under sustained, strong attack ends up computed as weaker than one that goes unchallenged. Each claim in a debate resolves to one of three outcomes. It **thrived**, **survived**, or **died**, depending on how much attack it withstood. Debaters can also **concede** a point outright.

Critically, a claim in the argument network can be linked back to the taxonomy node it originated from or elaborates on, via a reference field on the claim. This link is how a debate's outcome can, in principle, say something about a specific taxonomy node, not just about the ephemeral claims made in that one conversation.

### 1.4 The reflect step: how debates change the taxonomy, and who is in charge

After a debate ends, each agent reflects on what happened and proposes updates to its own beliefs, desires, and intentions in light of the exchange. These proposals never write to the taxonomy directly. They land in a review queue, where a human reviews, edits, and accepts or rejects each one before anything changes. The system's own framing document for this mechanism puts it plainly: the machine proposes, the human disposes. This is the pathway by which a taxonomy node's wording can be revised in response to a debate; it is the mechanism this proposal instruments.

### 1.5 The epistemic boundary already governing this system

This is the single most important piece of background for evaluating what follows, because it is easy to misread a system like this as claiming more than it does.

What a claim "survives" in this system is scrutiny by other AI-generated claims, under argumentation rules the project designed, over a corpus the project curated, argued by personas the project authored. Nothing in the debate loop touches the world directly. A claim can dominate an argument network and still be false; a claim can be defeated in one exchange and still be true. The system's own design documentation is explicit that this is a real limit, not a caveat to be minimized. Survival in this loop is **tested coherence**, not verified truth. Two things partially offset this, without erasing it. First, every write to the taxonomy is human-gated, as described above; a human reviewer filtering proposals is not the same as the world confirming a claim, but it is a real check against unreviewed drift. Second, the system is explicitly designed to identify **cruxes**, the pivotal disagreements a debate cannot resolve internally, and to treat locating a crux as a handoff to reality. That is where evidence from outside the system, real experiments, real institutional experience, would need to be consulted. The system's authority ends at that handoff.

This boundary is directly relevant to the proposal below. Debate-Tested, as defined here, measures how much adversarial testing a claim has survived inside this closed loop. It is explicitly not a claim about how likely the claim is to be true, and the proposal's terminology, its interpretation guidance, and its scoring choices are all constrained by that distinction.

### 1.6 How the system already handles "how much should we trust this number"

The platform has an existing discipline for a problem this proposal also runs into. Many of its internal scores (affect measures, quality metrics, threshold values) are set by design judgment rather than derived from data or validated against human raters. Rather than let that ambiguity hide, the project maintains a provenance register that classifies every such parameter as **stipulated** (asserted, no evidence pointer), **derived** (computed from an analysis), or **human-validated** (checked against human judgment, with a stated study and result). The register's stated rule is that the absence of an evidence pointer makes a parameter stipulated by definition, with no exceptions for convenience. This proposal follows that discipline. Every threshold and weight it introduces is declared stipulated, and a concrete validation study is specified as the path off that classification (Section 5).

### 1.7 A relevant precedent: down-weighting over-tested material

One further piece of context bears directly on part of this proposal. The platform noticed that debates tend to re-argue the same small set of claims across many different topics, a "greatest hits" pattern that leaves most of the taxonomy untested while a handful of nodes get tested repeatedly. An existing mechanism addresses this. When selecting which taxonomy nodes to inject into a new debate's context, nodes that have been cited across an unusually large number of prior debates receive a reduced relevance score, so debates naturally drift toward less-explored material. A node is exempted from this downweight when it also anchors a genuinely unresolved disagreement. This is a soft nudge, not a ban, and it was adopted only after a controlled comparison showed it increased taxonomy coverage without degrading debate quality. The Debate-Tested proposal's new "excluding well-tested nodes" mechanism (Section 3.7) is a direct extension of this same pattern to a different signal.

---

## 2. The Problem This Proposal Addresses

The taxonomy today is uneven with respect to how much adversarial testing each claim has actually received. Some claims have been tested repeatedly across multiple debates and held up. Some were revised in response to a debate and, in some cases, retested afterward. Most have never been tested at all. None of this history is visible anywhere. A claim that survived three adversarial debates and a claim no debate has ever touched render identically, and there is no way to sort or filter the taxonomy by testing history, or to direct future debate effort toward the material that most needs it.

An existing field, `confidence`, might seem to answer this, but it measures something different. A formula over the claim's inherent epistemic type, falsifiability, and evidence breadth produces a plausibility estimate, computed independent of whether the claim has ever actually been argued. The missing instrument answers a distinct question. How much adversarial pressure has this specific claim, in its current wording, actually survived?

---

## 3. The Proposal: Debate-Tested

### 3.1 The concept

The instrument is named **Debate-Tested**. Its design draws on Karl Popper's concept of **corroboration** as related inspiration, not as a claim of equivalence: a claim earns epistemic standing not by being plausible on its face but by surviving severe attempts to refute it. The instrument was originally named "Corroboration"; that name was withdrawn because it borrowed Popper's authority for a mechanism his own account explicitly forbids — using a well-tested status to reduce future testing (Section 3.7; see the companion design document's changelog). Popper's structural insight about severity of testing is retained as inspiration; the equivalence claim is not. Two adjacent terms were also deliberately avoided. "Certainty" describes a believer's state of mind, not a property of a claim's testing history. "Confidence" was rejected because the codebase already uses that word for the unrelated plausibility formula described above; reusing it for testing history would corrupt both measurements.

A second commitment, borrowed from Imre Lakatos's philosophy of science, shapes the design throughout: **revising a claim in response to a real challenge, and having the revised version subsequently hold, is not a reset of that claim's standing. It is the strongest form of standing the system can certify.** A design that zeroed a claim's testing history on every edit would penalize exactly the behavior the platform exists to encourage, namely updating a position when a real weakness is found.

### 3.2 What gets recorded

For each debate in which a taxonomy node was substantively engaged, the system records a compact outcome: which debate, when, whether the node was attacked and how strongly, how the claims tied to it resolved (thrived, survived, or died), whether a concession was made, and one of five outcome labels:

- **held**: the node was seriously challenged and survived intact.
- **weakened**: the node was seriously challenged and something tied to it failed, or was conceded.
- **refined**: the node's wording was revised, citing this debate, through the human-gated review process described in Section 1.4.
- **open**: the node was challenged but the debate ended without a clear result.
- **cited**: the node was referenced in the debate but never seriously challenged.

This record is never overwritten and never deleted by later debates. New entries accumulate. A revision (the `refined` label) is recorded as a new state to be tested, not as an erasure of what came before.

**How claim-level evidence becomes a node-level label, stated explicitly (this was missing from an earlier draft of this package and an external reviewer correctly flagged the gap).** A single taxonomy node is typically the anchor for more than one debate claim across its history. The outcome label for a given debate is not driven by any single claim in isolation: `held` requires every attributed claim in that debate to have survived; `weakened` requires either a full concession or at least half of the attributed claims to have failed, not merely one weak corollary among several strong ones. This proportional rule replaced an earlier, stricter draft that would have let one peripheral failing claim mark an otherwise strong node as weakened, which a reviewer correctly identified as a defect worth naming rather than leaving implicit. The reliability of the underlying claim-to-node linkage itself, not just this aggregation rule, is treated as an open question in Section 5.

### 3.3 The tier ladder

For display and sorting, this per-debate history is collapsed into one of four discrete tiers, in ascending order: **Untested**, **Cited**, **Contested**, **Well-Tested**. Well-Tested requires the node to have survived at least two severe challenges across at least two distinct debates, with no more recent failure than its most recent success. This is deliberately a small number of discrete categories rather than a continuous score. A single decimal number would imply a precision the underlying evidence does not support, and would invite readers to compare, say, a node at 0.71 against one at 0.68 as if the difference were meaningful, which it is not, given how few debates most nodes will have accumulated for the foreseeable future. A continuous value exists internally purely to produce a stable sort order within a tier; it is never shown to a reader.

### 3.4 Worked example: a claim that is revised and then holds

Concretely, consider a node representing a safetyist claim about training-data opacity. In an early debate, it is challenged strongly and, in post-debate reflection, revised to a sharper formulation citing the debate that prompted the change. Its testing-history record now shows one entry, marked revised, outcome pending, because nothing has yet tested the new wording. At this point the node's tier does not rise. Pending revisions receive partial credit toward the sort order, not full credit, and the tier itself sits at Contested, not Well-Tested, because a revision alone is not yet a demonstrated survival.

In a later debate, the revised claim is engaged again, challenged again, and this time everything tied to it survives. The system records a second, independent entry, marked held. And critically, it retroactively marks the earlier pending revision as confirmed. Both entries now count at full weight. The node crosses into the Well-Tested tier, and it carries a distinct visual marker showing that its Well-Tested status rests in part on a revision that was subsequently vindicated, which the design treats, per Section 3.1, as the strongest certificate the system can issue. Not a claim that was never challenged, but one that was found wanting, fixed, and proven again.

The converse path is handled symmetrically. If the later debate instead finds the revised wording fails too, that failure is recorded on its own terms, and the earlier pending revision stops accruing partial credit rather than continuing to count indefinitely for a fix that did not work.

### 3.5 Where a reader encounters this

The tier appears as a colored marker on each claim in the taxonomy browser. An outlined neutral marker signals Untested (the default state of most of the taxonomy, and not meant to read as a deficiency), progressing through Cited, amber Contested, and green Well-Tested, with the revision marker overlaid where relevant. Clicking the marker opens a short provenance panel narrating the record in plain language ("survived three debates; revised on this date in response to this debate; view the exchange"), with a link to the underlying debate. The taxonomy browser and a command-line tool both gain the ability to sort and filter the full node list by this measure, which was one of the four requirements set for this work at the outset.

### 3.6 An active program: spending debate effort where it is most needed

Beyond passive measurement, the proposal specifies a scheduling loop. Periodically rank taxonomy nodes by a combination of their importance (centrality in the graph, policy relevance, usage frequency) and their testing deficit (how far below Well-Tested they sit), generate debate topics specifically engineered to put the highest-priority under-tested claims under pressure, run those debates, and re-rank. This targets debate effort where it does the most epistemic work rather than leaving testing to chance topic selection.

### 3.7 A newer addition: making room by stepping back

A further mechanism, added during scoping for this proposal, addresses the same goal from the other direction. Rather than only pulling debate attention toward under-tested claims, a node that has already reached the Well-Tested tier is given a reduced chance of being selected for ordinary debates going forward, and inside the dedicated scheduling runs described in 3.6, well-tested nodes other than the one being deliberately targeted are excluded from that debate's context outright. The reasoning is that a claim which has already survived genuine testing has, at the margin, less to prove than one nobody has examined, so debate attention is better spent elsewhere. This directly extends the citation-frequency downweight described in Section 1.7 to a new signal (testing tier rather than citation count), reusing the same soft-nudge posture, the same integration point in the codebase, and the same requirement that any rollout be validated by a controlled comparison before being trusted. Taxonomy coverage must improve without any measurable loss in how well debates engage the actual disagreement.

External review flagged this as the proposal's riskiest piece, on the grounds that two survived challenges is a thin evidence base for reducing scrutiny, even softly, and the coverage-versus-quality guardrail above checks aggregate outcomes without catching a specific claim quietly escaping further testing for good. The mechanism now guarantees no node is excluded indefinitely. A Well-Tested node automatically returns to the normal candidate pool after a fixed interval (proposed: ninety days or twenty new debates in its topic area, whichever comes first), whether or not anyone requests it. Inside scheduler batches, the hard exclusion is capped at a small number of consecutive cycles, after which the node becomes eligible again even if it is not that cycle's specific target. And the record now tracks which camp made each challenge, not just how many challenges occurred, so a claim tested twice by the same opponent can be distinguished from one tested by two structurally different worldviews, a distinction the raw challenge count alone erases.

---

## 4. Design Commitments Worth Scrutinizing

We want reviewers to focus particular attention on the following choices, since they are the ones a different design could reasonably have made differently.

1. **Revision as strength, not reset (Section 3.1, 3.4).** This is the Lakatosian commitment at the center of the design. Is it the right model of how epistemic credit should work for an AI system that revises its own claims, or does it risk letting a system talk itself into unwarranted confidence through a sequence of self-authored revisions and self-authored retests?
2. **Discrete tiers over a continuous score (Section 3.3).** Is the false-precision concern that motivated this choice sound, or does collapsing the evidence into four buckets discard information a more careful continuous measure could responsibly convey?
3. **What counts as a severe challenge.** The proposal gates "challenged" status on a numeric strength threshold produced by the argument-network algorithm described in Section 1.3. That threshold is currently a design guess (Section 5), not derived from data. Is threshold-gating the right mechanism at all, independent of where the threshold is initially set?
4. **The exclusion mechanism (Section 3.7).** Deliberately reducing a well-tested claim's chances of being engaged further is a trade-off between broadening coverage of the taxonomy and continuing to stress-test claims that have already held up once or twice, which is a small sample by ordinary epistemic standards. Is two survived challenges enough evidence to justify de-prioritizing further testing, even provisionally and even with a soft, reversible mechanism?
5. **Everything remains stipulated until an explicit validation study runs (Sections 1.6, 5).** Is deploying an unvalidated instrument, with tiers and priorities visible in a working research tool before that validation happens, an acceptable order of operations, or should visibility be gated behind the validation step?

---

## 5. Explicit Limitations and Open Questions

- **Every threshold in this design is a design-time guess, not a derived or validated value**, including the number of challenges required for the top tier, the strength cutoff for what counts as a severe challenge, and the weighting scheme used internally to order nodes within a tier. A concrete validation plan exists. Once at least fifty debates have accumulated testing records, a stratified sample of nodes will be shown to human raters, blind to the system's own tier assignment, who will judge independently whether each node was severely tested and whether it held up. Agreement between the human judgments and the system's tiers, measured by Cohen's kappa, needs to clear a pre-registered bar (0.7) before the instrument is reclassified from stipulated to validated; if it does not clear that bar, the thresholds get revised and the study repeats. This study validates **reliability**, whether the tier accurately summarizes what happened in the debates it draws from, not **validity** in the stronger sense of whether surviving this closed loop corresponds to real-world epistemic merit. No study conducted entirely inside this system can establish the latter; that is precisely the boundary described in Section 1.5. At least a third of the human raters will be people unfamiliar with this project's own vocabulary and internal framing, not merely blind to the specific tier labels, since an all-in-house rater pool risks measuring agreement with the project's worldview rather than an independent read of the debate record.
- **This measure applies only to camp-specific claims (Beliefs, Desires, Intentions) in this version.** The taxonomy also contains shared "situation" nodes that all three camps interpret differently, and this proposal does not yet define what "held up under testing" would mean for a claim that is not defended by any single camp. That extension is deliberately deferred.
- **Concession tracking, one of the inputs the outcome labels depend on, has a data field defined in the schema whose population by the debate pipeline has not yet been verified.** Implementation is expected to confirm this and fall back to an alternate source if the primary field turns out to be unpopulated.
- **A node's testing record is invalidated by any edit to its wording that is not explicitly linked to the debate that prompted it.** The current version treats every wording change as material regardless of how trivial (a typo fix has the same effect as a substantive rewrite); a mechanism for exempting cosmetic changes is a known future refinement, not yet built.
- **The system does not currently propose feeding a claim's testing history into the separate plausibility-confidence score described in Section 2.** That coupling was considered and explicitly set aside; whether it should happen eventually remains open and is not part of what this proposal asks reviewers to evaluate.

---

## 6. Questions We Are Asking Reviewers to Evaluate

1. **Naming — resolved by this rename; the residual question is about the new name.** This review round asked whether "corroboration," used in its Popperian sense, was an accurate and non-misleading name, given the epistemic boundary in Section 1.5 — and whether a reader unfamiliar with that boundary would over-read a "Corroborated" tag as a claim of truth rather than testing history. The reviews found the risk real and, decisively, that the top-tier mechanism (Section 3.7) does what Popper's account of corroboration explicitly forbids; the instrument was renamed to **Debate-Tested** and its top tier to **Well-Tested** in response. The question that remains for reviewers: do "Debate-Tested" / "Well-Tested" cleanly avoid the truth-adjacency misreading, or do they carry residual over-reading risk of their own?
2. Does the tier ladder's structure (Section 3.3) correctly separate cases that should be kept distinct, and are there states a real debate history could produce that the ladder cannot currently represent?
3. Is the Lakatosian non-punitive treatment of revision (Section 3.1, 3.4) well-justified for this specific application, where the entity doing the revising is an AI system reflecting on its own AI-generated debate performance, rather than a human scientist responding to an experiment?
4. Is the proposed validation study (Section 5) an adequate test of whether this instrument measures what it claims to measure? Is Cohen's kappa the right agreement statistic, and is 0.7 an appropriate bar?
5. Does the exclusion mechanism in Section 3.7 risk any failure mode the stated guardrail (coverage gains without measurable loss in debate quality) would not catch?
6. Is there a simpler design that would achieve the stated goals (name the concept, measure it, make it visible, use it to direct future testing effort) without the complexity introduced by revision tracking, the tier-versus-score distinction, or the exclusion mechanism?

---

## Appendix: Where to Find More

The full technical specification, including the exact data schema, the algorithm for attributing debate outcomes back to taxonomy nodes, the sort-key formula, command-line tool signatures, user-interface details, and the phased implementation plan with named owners, is maintained separately in `corroboration-design.md` in the same repository location as this document. That document is the authoritative source for anything this package simplifies or omits; where the two disagree, the technical specification governs.
