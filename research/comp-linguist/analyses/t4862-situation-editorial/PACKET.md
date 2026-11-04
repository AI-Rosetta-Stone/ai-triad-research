# t/4862: editorial packet for 4 situations (from the t/4860 DOLCE audit)

Read-only against `ai-triad-data` `origin/main` on 2026-11-04. **Nothing has been written to the corpus.** Every change below is a corpus content write and goes under `/data-mutation` with its own frozen list. The retire/generalize decisions (items 3–4) are research-content calls for the PI, routed via the TL (t/4278 and t/4624 precedent).

The rule each fix applies: a situation names a contested concept or configuration, stated neutrally. It must not assert one camp's position or prescribe a norm; in DOLCE D&S terms those are Descriptions, not Situations (`docs/ontology-reference.md`, PR #4518).

## 1. sit-488 "Loss-of-Control Incident Redefinition": reword (side-taking)

**Problem:** both the description and `plain_description` assert the safetyist position as the situation itself ("…requiring immediate regulatory intervention", "…demand immediate government intervention"). The genus also anchors on one event ("the Hugging Face attack").

**Proposed `description`:**
> A situation concept that concerns whether unauthorized autonomous modifications and security breaches by AI systems should be classified as critical safety incidents, and what response such a classification should trigger. Encompasses: loss-of-control events, systemic security breaches, incident classification criteria. Excludes: standard software bugs, routine data privacy violations.

**Proposed `plain_description`:**
> This situation is about whether unauthorized, independent changes to AI systems and major security breaches should count as critical safety incidents, and what should happen when they do. It covers moments where people lose control of a system, large security failures, and the rules for deciding how such incidents are classified.

**Unchanged:** label, `interpretations` (each camp's summary already frames its own view correctly), edges (3), parent `sit-153`.

## 2. sit-491 "Dignity Under Uncertainty as a Governance Principle": reword (prescription)

**Problem:** the description *asserts* the norm ("…mandates extending moral consideration…") instead of naming the contested question.

**Proposed `description`:**
> A situation concept that concerns whether moral consideration and welfare obligations should be extended to AI systems under uncertainty about whether they are conscious. Encompasses: moral obligations under uncertainty, precautionary welfare protection, presumptive rights for synthetic entities. Excludes: strict functionalism, purely instrumental AI governance.

**`plain_description`:** currently absent. Leave it for the t/4861 enrichment backfill to generate from the corrected description, so a generated text isn't written twice.

**Unchanged:** label (it names the concept under debate), `interpretations`, edges (3), parent `sit-170`.

## 3. sit-485 "Recursive Exploration Self-Improvement Loop": recommend GENERALIZE (keep the ID)

**Problem:** the description is one system's mechanism from a single paper (`dream-rsi-…`): "historical replay simulators", "discovery trees". It reads as engineering detail, not a contested concept.

**Why generalize, not retire:**
- No general recursive-self-improvement situation exists in the taxonomy to retire it into. I searched labels and descriptions for "self-improv" and "recursive"; the nearest are the adjacent feedback-loop situations sit-442 and sit-448, which aren't the same concept.
- Its three `interpretations` are **already written at the general RSI level** ("runaway capability scaling", "unpredictable capability takeoff", "automated parameter search within narrow domains").
- Only the description is over-specific. Generalizing keeps its 9 edges and its interpretations.

**Proposed label:** "Recursive AI Self-Improvement Loop".

**Proposed `description`:**
> A situation concept that concerns AI systems that evaluate and redeploy improved versions of their own strategies in a repeated cycle, and whether such loops can drive open-ended capability growth. Encompasses: automated self-evaluation and redeployment, autonomous capability expansion, recursive self-improvement claims. Excludes: single-round optimization, human-directed retraining.

**Alternative (not recommended):** retire into sit-153 "Ensuring AI Alignment and Control". That's too broad, and the RSI concept would lose its own node.

## 4. sit-486 "Unsatisfactory Substitutes Annotation Methodology": recommend RETIRE into sit-157

**Problem:** a crowdsourced image-annotation *method* from a single dataset paper (`intentonomy-dataset-…`). It's a Description (a method), not a policy situation. This is the same class as the t/4624 engineering artifacts.

**Recommended:** retire it via `superseded_by: sit-157` ("AI Evaluation, Performance, and Real-World Impact", already its parent). Use the t/4624 C1 precedent, `fold_edges: false`: its 14 edges stay dormant on the retired ID rather than being folded onto the general parent, because those edges are about the annotation method, and folding them would misrepresent sit-157. Nothing is deleted, and the ID still resolves.

**Alternative (not recommended):** generalize it to "Crowdsourced annotation of human intent as AI training data". The policy content is thin, and its interpretations argue about the method, not a contested concept.

## Sequencing

1. **The PI decides items 3–4** (via the TL digest). Items 1–2 are rewordings that keep the ID and can proceed under `/data-mutation` independently.
2. **The t/4861 backfill runs after item 4 is decided,** leaving out sit-486 if it's retired (t/4861#1).
3. **Each write:** frozen list, recorded authorization, second-agent recount, then a 0-collateral check through each file's real writer (`/data-mutation`).

## Provenance

These are category judgements by a single CL rater against the DOLCE D&S Situation/Description distinction. They are **stipulated** until editorial review. The edge counts, parents and the RSI-search result are **observed** on `origin/main`.
