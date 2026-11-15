# `disagreement_type` Classification Rubric

**Ticket:** t/2170
**Author:** Computational Linguist (Orca)
**Created:** 2026-08-05
**Status:** CL deliverable. Vocabulary confirmed; rubric and enrichment prompt ready for the population pass (routed to PowerShell / AIEnrich).
**Provenance:** vocabulary **stipulated** (schema enum, this doc); per-node labels will be **LLM-classified (unvalidated judge)** until an agreement check against the seed set below is run. Register row added in the same PR (`metric-provenance-register.md`).

## 1. Why this exists

`situation_component_scores.diversity` (`computeDiversityComponent`, `lib/debate/situationScoring.ts`) reads a situation's `disagreement_type` and awards a selection bonus to under-represented types. The field is populated on **1 of 436** situation nodes (`taxonomy/Origin/situations.json`), so the component logs as **0 for effectively every node**, which makes it degenerate. This rubric defines how the remaining 435 nodes get a reproducible label so the component carries signal.

**The vocabulary is not new.** The situation schema (`taxonomy/schemas/situations-taxonomy.schema.json:144`) already fixes a three-value enum (`definitional | interpretive | structural`), and `computeDiversityComponent` is already coded to exactly that three-type model (it treats `presentTypes.size >= 3` as saturated). The ticket's original premise ("vocabulary TBD, e.g. empirical/normative/definitional/predictive") is superseded. Changing the axis would require re-touching the scoring code across scope, and the existing axis (*the structure of the cross-POV disagreement*) is the right one for a **selection-diversity** signal, where the goal is a spread of disagreement *kinds*, not of claim *content*. We keep the schema vocabulary and document it here.

## 2. The vocabulary (three types)

The classification answers one question: **at what level do the POVs actually disagree about this situation?**

| Type | The POVs disagree about… | Test |
|---|---|---|
| **definitional** | *what the thing is* — they hold different definitions of the concept the situation turns on | Would the disagreement dissolve if they first agreed on a shared definition? If yes → definitional. |
| **interpretive** | *what follows* — they share a working definition but split on implications, value, urgency, or the right response | Do they name the same object and then diverge on "so what should we do / how much does it matter"? → interpretive. |
| **structural** | *which frame applies* — they organize the issue under incompatible foundational framings; one side often rejects that the other's frame is even the right lens | Is at least one POV saying "this is the wrong way to look at the problem," not just "I draw a different conclusion"? → structural. |

### 2.1 Decision procedure (apply in order)

1. **Definitional first.** If the POVs assign genuinely different *meanings* to the central concept (so they are, in effect, talking about different objects), label **definitional**. This is the rarest case; it requires a real definitional fork, not merely different emphasis.
2. **Structural next.** Label **structural** if they share the concept's meaning but the POVs are **in conflict over the framing** the situation is posed in: one POV rejects it under a competing foundational lens (e.g. "normal technology" vs "discontinuous existential risk") **and another adopts or defends it** as the right lens. One POV rejecting a framing that the other two set aside is not enough, even when the situation is itself a framework, lens or analogy (§2.2). *(Reconciled with §2.2 under the PI construct decision of 2026-11-11, t/246: this step used to read "at least one POV rejects the framing", which contradicted the dominant-axis rule.)*
3. **Interpretive by default.** If they name the same object under a shared frame and diverge only on implications / desirability / urgency / prescribed action, label **interpretive**. Most cross-POV policy disagreements land here.

### 2.2 The dominant-axis rule (load-bearing)

Real situations mix levels. A skeptic frequently reframes ("wrong question") even when the accelerationist and safetyist are having an interpretive dispute. **Label the axis on which the *primary* disagreement turns, not the most extreme single POV move.** If two of three POVs share a frame and split on implications while the third reframes, the primary axis is interpretive; note the reframe but do not let one voice promote the label to structural. Only promote to structural when the *framing conflict itself* is what the situation is about.

## 3. Seed set (hand-labeled anchors)

Labeled by the CL from each node's `description` + per-POV `interpretations`. These serve as (a) rubric anchors and (b) the agreement-check gold set for the enrichment pass. Run the classifier over these ten **three times**. Require each of the nine non-abstain seeds' **majority label** to be correct (9/9), **and** the abstain anchor's majority label to be `insufficient`, before trusting the full-corpus pass. A single draw that must be 9/9 fails by chance even for a sound prompt (t/246 run 1: 9/9, 8/9, 9/9).

| Node | Label | Why |
|---|---|---|
| `sit-447` (AI as autopoietic vs allopoietic) | **definitional** | The situation *is* the dispute over what AI is — self-producing entity vs externally-organized artifact. |
| `sit-001` (AGI timeline) | **interpretive** | acc & saf agree AGI is likely soon, split on response (race vs safety-first); skeptic reframe present but non-dominant. |
| `sit-100` (labor-market transformation) | **interpretive** | All agree AI reshapes labor; split on intervene-vs-let-markets-resolve. |
| `sit-250` (maximum feasible participation) | **interpretive** | All accept the participation concept; dispute its value and role. |
| `sit-350` (code-attribution reliability) | **interpretive** | Shared concept; dispute its purpose (audit tool vs safety prerequisite vs accountability gap). |
| `sit-430` (pluralistic self-narrative) | **interpretive** | Shared concept of the constructed self; dispute the implications. |
| `sit-470` (shared responsibility framework) | **interpretive** | Dispute how to allocate/enforce responsibility, not what it is. |
| `sit-300` (plural futures) | **structural** | acc rejects the frame as a distraction; skeptic centers it — the disagreement is about which frame organizes the issue. |
| `sit-400` (normal externality management) | **structural** | "AI is a normal technology governed by ordinary mechanisms" vs "discontinuous catastrophic risk" — competing foundational frames. |
| `sit-154` (challenges in AI governance and policy) | **abstain** | All three per-POV interpretations are empty strings (a `[DEPRECATED]` node, not superseded): insufficient signal (see §4.2). |

The seed distribution (6 interpretive, 2 structural, 1 definitional, 1 abstain) is expected: definitional forks are genuinely rare, and interpretive is the modal case for AI-policy situations.

*Replaced (t/246):* `sit-050` (business skin in the game) used to be the abstain anchor, because its `interpretations` were null. They were filled on 2026-08-25 (t/3018). As of 2026-11-11, `sit-154` is the **only** live situation whose interpretations are empty (no situation is single-POV), so it is the abstain anchor. The t/246 iteration-2 classifier run returned `insufficient` for it in 3 of 3 replicates.

## 4. Classification prompt (for the AIEnrich population pass)

The population step is owned by PowerShell / AI-enrichment; this is the CL-authored rubric it runs. The classifier is given the node's `description` and its per-POV `interpretations` (belief / desire / intention / summary) and returns one enum value plus a confidence and a one-line rationale.

### 4.1 Prompt

> You are classifying the **type of cross-POV disagreement** a policy "situation" turns on. You are given a situation's description and how up to three points of view (accelerationist, safetyist, skeptic) interpret it.
>
> Choose exactly one label:
>
> - **definitional** — the POVs assign different *meanings* to the central concept; they are effectively disputing what the thing *is*. The disagreement would dissolve if they first agreed on a shared definition. (Rare.)
> - **interpretive** — the POVs share a working definition of the concept and disagree about *implications*: what follows, how much it matters, what should be done. (Most common.)
> - **structural** — the POVs organize the issue under *incompatible foundational frames*; at least one POV rejects the others' framing as the wrong lens, not merely reaching a different conclusion within a shared frame.
>
> Apply this order: check definitional first, then structural, else interpretive. **Label the axis of the *primary* disagreement.** If two POVs share a frame and split on implications while a third reframes the whole question, the primary axis is interpretive — note the reframe but do not promote the label to structural on the strength of one POV. Promote to structural only when the framing conflict *is* what the situation is about.
>
> If the interpretations are absent or too thin to judge the disagreement's level, return `"insufficient"` with low confidence rather than guessing.
>
> Return JSON: `{ "disagreement_type": "definitional|interpretive|structural|insufficient", "confidence": 0.0-1.0, "rationale": "<= 25 words" }`.

### 4.2 Handling low signal

Nodes whose `interpretations` are null or single-POV (e.g. `sit-154`) cannot support a reliable label. The classifier must return `"insufficient"`, and the population step **must not** write a `disagreement_type` for these (leave the field absent) rather than fabricate one. `computeDiversityComponent` already treats a missing value as no-diversity-contribution (`if (!situation.disagreement_type) return 0`), so abstention is safe and honest. Track the count of abstentions; if it is large, the fix is to enrich `interpretations` first (a separate concern), not to force labels.

## 5. Acceptance mapping (t/2170)

- **Vocabulary defined + documented in schema**: already satisfied by `situations-taxonomy.schema.json:144`; confirmed and rationalized here (§2). ✅ CL
- **Classification rubric/prompt drafted**: §2–§4. ✅ CL
- **All situation nodes carry a value**: population pass (PowerShell/enrichment); nodes with insufficient signal are legitimately left absent (§4.2), so "all *classifiable* nodes." → routed
- **`diversity` shows non-zero variance in a later cal log**: verified after the population pass in a situation-injecting debate. → post-population
- **Writes go through the situations.json writer contract**: population step's responsibility.

## 6. Post-population validation (CL, after the pass lands)

1. **Agreement check:** run the classifier over the §3 seed set; require reproduction of the nine non-abstain labels (the interpretive/structural boundary is the expected source of any miss, so inspect disagreements there). Record agreement in the register row.
2. **Distribution sanity:** confirm the corpus is not collapsed onto one type (a degenerate label distribution reproduces the original degeneracy at a different value). Expect interpretive-dominant but with a live minority of definitional/structural.
3. **Metric check:** run one situation-injecting debate and confirm `situation_component_scores.diversity` shows non-zero variance across nodes.
