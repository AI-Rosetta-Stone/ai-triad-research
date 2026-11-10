# Op-Ed Tool: Theory of Operations

## Overview

This document describes how the Op-Ed tool works: how one request becomes a set of op-eds, one per selected camp, and what each stage of the pipeline does. It describes the code as it is, with file:line citations. Anything aspirational is marked as such.

Desktop and web run the same generator: `generateOpEdSet` in `lib/oped/generate.ts`. Desktop calls it from `taxonomy-editor/src/main/ipc/opedHandlers.ts:362`, and the web build calls it through `taxonomy-editor/src/server/ai/opedAdapter.ts`. The PowerShell `New-OpEd` cmdlet is a separate implementation and is not covered here.

## System Architecture

### Core Components

- **Generator.** `generateOpEdSet` (`lib/oped/generate.ts:1007`) is an async generator. It yields progress events (`generate.ts:54-63`) and ends with `{ type: 'complete', set }`.
- **Prompts.** These are in `lib/oped/prompts/*.prompt`. `lib/oped/promptLoader.ts` fills their `{{SLOTS}}` (`promptLoader.ts:41-43`); a missing value becomes an empty string.
- **Outlet settings.** `lib/oped/outlets.json`, read through `outletBands.ts`. See the [Theory of Outlets](./oped-tool-theory-of-outlets.md).
- **Camp voice.** A soul document per camp (`loadSoulDoc`, `generate.ts:115`), rendered into the system prompt by `buildVoiceBlock` (`generate.ts:321`).
- **Grounding.** The camp's BDI nodes and situations, from the taxonomy (`loadTaxonomy`, `generate.ts:1066`).
- **Guards.** `FABRICATED_LEDE_GUARD` (`lib/oped/opedGuards.ts:12`), readability checks (`lib/oped/readabilityMeasure.ts`), and coherence checks (`lib/oped/coherenceCheck.ts`).

### Data Flow

1. **Source brief.** URL mode only. One call per set, not per camp (`generate.ts:1026-1053`).
2. **Grounding.** Selected once per camp (`generate.ts:1055-1094`).
3. **Voices.** Each camp runs through the stages below, **one camp at a time** (`generate.ts:1144`), which bounds peak memory (t/2719).
4. **Set assembly.** Members are kept in request order, including failed and cancelled ones (`generate.ts:1155-1176`).

## The Pipeline, Stage by Stage

Every model call goes through one helper, `callStage` (`generate.ts:524`). It records the call on the member's `stages` (t/171): the exact prompt, the raw output or error, the attempt number and the model. That record is what the How panel's Raw Prompt and Raw Output sections show. A stage that didn't run leaves no entry.

| # | Stage | When it runs | Prompt | Temperature | What its output does |
|---|-------|--------------|--------|-------------|----------------------|
| 0 | `source-brief` | A source document was supplied (URL mode) | `op-ed-source-brief.prompt` | 0.1 | Extracts a neutral thesis, author, actor type, stance, recommendations and up to 8 key claims (`op-ed-source-brief.prompt:9-15`). Ignored if the model marks the source unreadable (`generate.ts:1036`). |
| 1 | `generation` | Always | `op-ed-generation-system.prompt` + `op-ed-generation-user.prompt`, joined with `---` (`generate.ts:580`) | 0.8 (`generate.ts:583`) | Returns JSON: headline, subtitle, body, rhetorical notes (`op-ed-generation-user.prompt:41-49`). An empty or non-JSON reply fails this camp's op-ed (`generate.ts:594-609`). |
| 2 | `coherence-judge` | The body is non-empty (`generate.ts:624`) | `op-ed-coherence-judge.prompt` | 0.1 | Three self-consistency checks (below). A flag counts only if both conflicting spans are quoted (`coherenceCheck.ts:45-47`). |
| 3 | `coherence-rewrite` | The judge flagged something | `op-ed-coherence-rewrite.prompt` | 0.3 | A minimal edit that resolves only the flagged contradictions (`op-ed-coherence-rewrite.prompt:1-9`). |
| 4 | `coherence-rejudge` | A rewrite came back non-empty | `op-ed-coherence-judge.prompt` | 0.1 | The rewrite is kept only if every originally flagged check now passes; otherwise the original body is restored (`generate.ts:687-715`). |
| 5 | `readability-edit` | The body misses the outlet's readability targets (`generate.ts:735`) | `op-ed-readability-edit.prompt` | 0.3, then a retry at 0.2 | A copy edit for reading level. Guards below. |
| 6 | `grounding-reflection` | There is grounding and a body (`generate.ts:861`) | `op-ed-grounding-reflection.prompt` | 0.2, then a retry at 0 | Says, for each grounding element, how and where the op-ed reflects it, and maps the source's key claims to paragraphs. This feeds the Why section. |

### Coherence checks

The judge runs three checks against the op-ed's **own** claims (`op-ed-coherence-judge.prompt:7-13`). It does not judge whether the position is right or wrong.
- `thesis_solution`: the close asserts the negation of something the op-ed argued earlier.
- `mechanism_scope`: a proposed mechanism's default or failure behaviour violates the scope the op-ed set for it.
- `co_asserted_tension`: two conflicting positions are both asserted, with no reconciling scope stated.

The outcome is recorded on the member as `coherence_meta`. If the judge call or its parse fails, the original body is kept and a WARN is recorded (`generate.ts:718-723`). The coherence pass runs **before** the readability edit, so a later readability edit can re-introduce a contradiction. That gap is accepted (`generate.ts:619-620`, t/3826).

### Readability edit guards

The edit is checked before it's accepted (`generate.ts:737-834`):
- **Collapse guard.** A result more than 40% shorter than the original is discarded (`generate.ts:751`).
- **Voice guard.** If the edit introduces a banned "AI tell" that wasn't in the original, it's reverted (`generate.ts:766`).
- **Retry.** If the first edit made the reading grade worse, it's retried once at temperature 0.2, and the better of the two is kept (`generate.ts:777-790`).
- **Paragraph backstop.** Any paragraph still over the word limit is split at sentence boundaries, deterministically, with no model call (`generate.ts:802`).

The outcome is recorded as `editing_meta`.

### Grounding reflection retry

If a source with key claims was supplied but the reflection extracted no claims, the reflection runs once more at temperature 0 (`generate.ts:939-951`, t/2919). Any reflection failure is non-fatal: grounding then reads "(not reported)" (`generate.ts:846`).

### Fabricated-lede guard

When no news hook was given, the generation prompt tells the model not to invent a dated event (`promptLoader.ts:50-56`). Afterwards, `FABRICATED_LEDE_GUARD` scans the first 500 characters of the body for markers such as "this week" or "pending vote" (`opedGuards.ts:12-13`, `generate.ts:968`). A match **flags** the member (`fabricated_lede: true`) and records a WARN. It does not change the text.

## How BDI Elements Are Selected and Ranked (the Why section)

1. **Query.** The topic, news hook and thesis are joined and embedded (`generate.ts:1067-1069`).
2. **Scoring.** Every taxonomy node gets the cosine similarity between its embedding and the query (`lib/debate/taxonomyRelevance.ts:137-148`). Nodes without an embedding get no score.
3. **Selection per camp.** A camp's own nodes only (`generate.ts:1072-1075`), via `selectRelevantNodes` with these settings (`generate.ts:271-277`):
   - threshold 0.48 (`lib/debate/calibration-config.json:65`);
   - at least 2 nodes per BDI category, even below the threshold;
   - at most 12 nodes in total.
4. **Order.** Nodes are grouped Beliefs, then Desires, then Intentions, each sorted by score (`lib/debate/taxonomyRelevance.ts:332-339`). When the 12-node cap trims the list, the camp's top two are kept first and the rest are ordered by score (`lib/debate/taxonomyRelevance.ts:368-385`). **The grounding list is therefore not one global ranking by relevance.**
5. **Situations.** Selected once for the whole set, shared by all camps. Between 1 and 3, using the same 0.48 threshold (`generate.ts:1077-1083`).
6. **A POV tag** narrows (`scope`) or boosts (`prioritize`) the tagged camp's nodes only (`generate.ts:263-319`).

Each grounding element is stored on the member with `relevance` (its similarity score, to 4 decimals, `generate.ts:845`) and `how_reflected` (from the reflection stage). `relevance` measures how close the element is to the **request**. It does not measure how strongly the op-ed used the element: the code computes no such score.

## Interaction Patterns

### Multi-camp sets

One request produces one op-ed per selected camp. The camps share the topic, the parameters, the source brief and the situations; everything else is per camp. Each member is self-contained (`lib/oped/types.ts:46-50`).

### Partial sets

A camp whose generation fails or is cancelled still appears in the set, with `status: 'failed'` or `'cancelled'`, and keeps the `stages` that ran before the failure (`generate.ts:1123-1131`).

## User Interaction Model

- **Single camp:** a set of one.
- **Multi-camp:** the same topic argued by several camps, side by side.
- **URL mode:** each camp responds to a supplied source document, held to the source-fidelity rules (`op-ed-generation-user.prompt:31`).
- **Settings:** outlet, word count, news hook, thesis, author bio, model, and an optional POV tag (`lib/oped/types.ts:11-21`).
  - The New Op-Ed dialog also offers Max grounding nodes, Max situations and Temperature. These **are not yet wired** into this pipeline, which uses the fixed values above. That's tracked as t/203.

## Performance Considerations

- **Calls per camp:** 2 to 8 model calls (generation, judge, rewrite and re-judge, up to two edits, up to two reflections), plus one source-brief call per set.
- **Concurrency:** camps run sequentially. A 4-camp set takes about four times as long as one camp, but its peak memory is that of one camp (t/2719).
- **Token budget:** generation's `maxTokens` scales with the target length: `ceil(targetWords × 3) + 5000` (`generate.ts:561`).
- **Captured text:** each captured prompt or output is capped at 200,000 characters (`generate.ts:507`).

---

*Accurate to the code at the time of writing. When the pipeline changes, update this document and its citations.*
