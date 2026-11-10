# Op-Ed Tool: Theory of Success

## Overview

This document describes what success means for the Op-Ed tool: what a good op-ed is, how the tool checks for it today, and how it can still fail. Where the tool measures something, the measurement is cited. Where it doesn't, that's said plainly, and the goal is marked **aspirational**.

The Op-Ed tool writes a publication-ready guest essay arguing one camp's position on an AI policy topic. It can write several camps at once on the same topic, so readers can compare how each camp would make its case.

## Goals

- **User goal:** see how each camp would argue a topic, in a form an editor could actually run, and see why each op-ed says what it says.
- **System goal:** keep every op-ed rooted in the camp's own registered positions (its BDI nodes) and voice, rather than in generic model opinion.
- **Outcome goal:** readers understand the camps' real disagreements better by reading their strongest cases side by side.

## What a Successful Op-Ed Is

1. **Grounded.** It argues from the camp's own belief, desire and intention nodes that are most relevant to the topic, and doesn't contradict them (`lib/oped/prompts/op-ed-generation-user.prompt:33-36`).
2. **Faithful to the camp.** It sounds like a conviction held by that camp, in its voice, honouring its values and its banned phrases (`op-ed-generation-system.prompt:1,36`).
3. **Internally coherent.** Its close doesn't contradict its own thesis, its mechanisms don't break the scope it set, and it doesn't assert two conflicting positions without reconciling them (`op-ed-coherence-judge.prompt:7-13`).
4. **Readable for the outlet.** It hits the outlet's length, reading level and house style. See the [Theory of Outlets](./oped-tool-theory-of-outlets.md).
5. **Faithful to its source.** In URL mode, it represents the source document accurately, whether it agrees or rebuts (`op-ed-generation-user.prompt:31`).
6. **Honest about the news.** With no news hook, it doesn't invent a dated event to manufacture urgency (`op-ed-generation-system.prompt:13`).
7. **Persuasive to the outlet's audience.** It has one clear thesis, two or three evidence pillars, an honest counterargument, and a concrete remedy (`op-ed-generation-system.prompt:11-21`).

## How Success Is Checked Today

| Criterion | Checked by | What happens on a miss |
|-----------|------------|------------------------|
| Grounded | **Grounding reflection** (`op-ed-grounding-reflection.prompt`). Reports, for each element, how and where the op-ed reflects it. Shown in the Why section. | Reported, not enforced. An element can go unused, and the Why section shows that. |
| Internally coherent | **Coherence judge**: three checks, and a flag counts only if both conflicting spans are supplied and non-empty (`lib/oped/coherenceCheck.ts:45-47`). | A minimal rewrite, kept only if a re-judge passes; otherwise the original stays. |
| Readable | **Readability measure.** Flesch-Kincaid grade, longest sentence, longest paragraph (`lib/oped/readabilityMeasure.ts:26-56`), against the outlet's targets. | A guarded copy edit, plus a deterministic paragraph split. Recorded in `editing_meta`, including any checks still failing. |
| Honest about the news | **Fabricated-lede guard.** A pattern scan of the first 500 characters, when no news hook was supplied (`lib/oped/opedGuards.ts:12-13`). | The op-ed is flagged (`fabricated_lede`); the text isn't changed. |
| Faithful to the camp | Prompt instructions only. The edit pass reverts an edit that introduces a banned "AI tell" (`lib/oped/generate.ts:766`). | Partly checked: only the banned-phrase list. |
| Faithful to the source | Prompt instructions only. | **Not measured.** |
| Persuasive | Prompt instructions only. | **Not measured.** |

**Transparency.** Each op-ed records every model call it made: the exact prompt, the raw output or error, and the attempt number (`stages`, t/171). The How panel shows them. That lets a reader check whether a weak op-ed came from weak grounding, a failed stage, or the model.

## Key Success Metrics

- **Grounding use:** the share of grounding elements the reflection reports as reflected in the op-ed. **Aspirational:** the per-op-ed data exists, but no aggregate is computed.
- **Coherence:** the rate of flagged checks, and of rewrites that resolved them. **Aspirational:** recorded per op-ed in `coherence_meta`, but `coherence_meta` isn't kept when the set is saved, and no aggregate is computed.
- **Readability:** the share of op-eds that meet their outlet's targets after editing. **Aspirational:** same storage gap, via `editing_meta`.
- **Completion:** the share of camps per set that finish (`status: 'complete'`). Recorded on every saved set.

## Design Principles

1. **The camp argues, the tool doesn't.** Each op-ed is one-sided by design. Balance comes from reading several camps side by side, not from hedging inside one.
2. **Grounding over generic opinion.** The camp's registered positions are the substance of the argument, not background.
3. **Show your work.** Why (grounding and how it was used) and How (the raw prompts and outputs) let readers audit any op-ed.
4. **Fail visibly.** A stage that fails degrades to the previous version and records a WARN. A camp that fails still appears in the set as failed, and is never silently dropped.

## Known Failure Modes

- **The readability edit can undo coherence.** The coherence pass runs before the readability edit, so an edit can re-introduce a contradiction that was just removed. This gap is accepted (`generate.ts:619-620`, t/3826).
- **The readability edit ignores the outlet's register.** The edit prompt's rules are fixed at grade 10, so a Tech Policy Press op-ed can be pushed toward mass-market prose. Tracked as t/202.
- **Some dialog settings do nothing.** Max grounding nodes, Max situations and Temperature in the New Op-Ed dialog aren't wired into the pipeline. Tracked as t/203.
- **Retrieval relevance isn't use.** The grounding `relevance` score measures closeness to the request, not how much the op-ed relied on the element. The reflection's `how_reflected` is the only signal of use.
- **The guards are narrow.** The fabricated-lede guard is a fixed phrase list, and source fidelity and persuasiveness aren't checked at all.
- **Model failures.** An empty or non-JSON generation reply fails that camp's op-ed (`generate.ts:594-609`). It's shown as failed, and its `stages` show the failing call.

## User Scenarios

- Seeing how an Accelerationist, a Safetyist and a Skeptic would each argue whether AI agents should have legal personhood, written for the same outlet.
- Responding to a published report (URL mode) from each camp's perspective, then checking each response's faithfulness against the source.
- Opening an op-ed's Why section to see which of the camp's positions it drew on, then its How section to see the exact prompts that produced it.

---

*Accurate to the code at the time of writing. The aspirational metrics need aggregation and persistence that don't exist yet.*
