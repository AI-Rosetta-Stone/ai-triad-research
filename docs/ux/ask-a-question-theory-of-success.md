# Ask a Question: Theory of Success

## Overview

Ask a Question is a research inquiry feature that enables users to pose a question to the AI Triad debate engine and receive a structured, multi-perspective answer grounded in the taxonomy. This document describes what success looks like for the feature: who it serves, what good outcomes are, how we measure them, and the honest constraints we communicate.

## User and System Goals

**Who asks:** Researchers, policymakers, and informed practitioners who want to understand how the AI policy and safety community disagrees on a specific topic.

**Why they ask:** They need a grounded, multi-perspective perspective on a concrete question—not speculation, but evidence-backed positions held by distinct camps in the taxonomy, plus points of convergence.

**User goal:** I can ask a natural-language question about AI policy or safety and receive a structured answer that shows me what each perspective believes, where they agree, and what remains unresolved.

**System goal:** Transform a user question into a concrete, bounded debate about that question, run it through the neutral evaluation pipeline, and synthesize the results into a structured answer artifact that preserves both fidelity to the debate and uncertainty about the conclusions.

## What a Good Answer Looks Like

A successful answer has five properties:

1. **Grounded Why:** The answer shows positions held by specific POV camps and cites which taxonomy nodes (beliefs, goals, methods) ground each position. The user can trace the answer back to source material.

2. **Stated Divergence:** When camps disagree, the answer makes the disagreement legible—which axis separates them, and whether the disagreement is factual, value-based, or methodological.

3. **Convergence Made Visible:** The answer identifies claims on which two or more camps agree, even if they reached those claims for different reasons.

4. **Direct Answer:** The answer directly addresses the user's question with a clear statement, not a summary of debate positions. The debate is evidence for the answer, not the answer itself.

5. **Honest Uncertainty:** The answer carries two certainty qualifiers:
   - A **single-run caveat:** This is one debate run, not a replicated finding. The replication standard in social science is n ≥ 10. This result is an exploratory draft.
   - **Per-metric trust projection:** If the debate was truncated by budget, rate limits, or other faults, the answer explicitly marks which metrics are unreliable under those conditions.

## How We'd Know It Works

Success is measured by user research and system diagnostics:

### User Research Signals

- **Comprehensibility:** Users report the structured answer helps them understand camp disagreements better than reading the raw debate transcript.
- **Actionability:** Users can point to specific nodes and camps whose disagreement matters to their work.
- **Appropriate Caution:** Users do not treat the single-run result as a replicated finding; they understand it's exploratory.

### System Diagnostics

- **Debate Completion Rate:** The debate engine completes its full turn sequence without budget exhaustion. (A truncated run yields low-trust metrics per t/1671.)
- **Synthesis Fidelity:** The synthesized answer cites only nodes from the grounding envelope; no hallucinated claims appear in the structured output.
- **Meaningful Engagement:** The synthesis meaningfully engages with the grounding nodes, building positions from taxonomy content rather than generating generic conclusions.

## Design Principles

1. **Exploration, Not Prescription.** The feature helps researchers discover how the community disagrees on a question. It does not prescribe a single right answer.

2. **Scaffold the Debate.** Grounding nodes are *not* search results; they form a finite scaffold. The debate run stays focused on topics present in the taxonomy, avoiding hallucinated tangents.

3. **One Run Is Not a Finding.** This principle shapes every surface in the feature—the caveat is always visible, the visual hierarchy emphasizes it, and the confidence scores are muted to discourage overclaiming.

4. **Trust Projection.** Metrics computed from truncated runs (budget-exhausted, rate-limited) are flagged visually as less reliable. Users make their own judgment, but the system never hides the truncation.

## Honest Constraints

This feature has real boundaries:

- **Time.** Each run takes 2–60 minutes depending on fidelity level (see `lib/inquiry/durationEstimate.ts`). Quick fidelity: 2–8 min; standard: 8–25 min; deep: 30–60 min. Users cannot treat this as a synchronous search. The feature uses an async job model; users poll for results.

- **Scope.** The question is answered only with respect to the taxonomy's current content. If the taxonomy lacks a POV on a topic, the answer reflects that gap ("The taxonomy has little that speaks directly to this question").

- **Replication.** One run is an exploratory draft. A defensible research claim requires ≥10 independent runs; the caveat says this plainly.

## Connection to Ask a Question UX

In the UI, this theory surfaces as:

- **Why section:** Contextual help that links to this document.
- **How section:** Links to the Theory of Operations; shows the pipeline's five stages; surfaces real metrics and trust projections.
- **Result artifact:** The structured answer, with the single-run caveat and per-metric trust indicators always visible.
- **Share/export:** The caveat is embedded in exported or shared results so recipients see it, not just the person who ran the inquiry.

---

**Related:**
- `docs/hld-inquiry-ux.md` — High-level design and pipeline architecture
- `docs/adr/ADR-0002-inquiry-result-contract.md` — Result contract and trust projection rules
- `lib/debate/inquiryPipeline.ts` — Orchestrator code
- `lib/debate/prompts/inquiry.ts` — Synthesis prompt template
