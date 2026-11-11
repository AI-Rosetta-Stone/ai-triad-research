# Op-Ed Tool: Theory of Operations

**Author:** Ai Triad Research | **Status:** Design approved | **Last updated:** 2026-11-10

## Overview

This document describes how the Op-Ed tool works: how one request becomes a set of op-eds, one per selected camp, and what each stage of the pipeline does. It describes the code as it is, with file:line citations provided in the Implementation references section. Anything aspirational is marked as such.

Desktop and web run the same generator: `generateOpEdSet` in `lib/oped/generate.ts`. Desktop calls it from `taxonomy-editor/src/main/ipc/opedHandlers.ts:362`, and the web build calls it through `taxonomy-editor/src/server/ai/opedAdapter.ts`. The PowerShell `New-OpEd` cmdlet is a separate implementation and is not covered here.

## System Architecture

### Core Components

- **Generator.** `generateOpEdSet` is an async generator. It yields progress events and ends with `{ type: 'complete', set }`.
- **Prompts.** These are in `lib/oped/prompts/*.prompt`. The prompt loader fills their slots; a missing value becomes an empty string.
- **Outlet settings.** Outlet bands are read from the outlet configuration. See the [Theory of Outlets](./oped-tool-theory-of-outlets.md).
- **Camp voice.** A soul document per camp, rendered into the system prompt.
- **Grounding.** The camp's BDI nodes and situations, from the taxonomy.
- **Guards.** Fabricated-lede scanning, readability checks, and coherence checks.

### Data Flow

1. **Source brief.** URL mode only. One call per set, not per camp.
2. **Grounding.** Selected once per camp.
3. **Voices.** Each camp runs through the stages below, **one camp at a time**, which bounds peak memory.
4. **Set assembly.** Members are kept in request order, including failed and cancelled ones.

## The Pipeline, Stage by Stage

Every model call goes through one helper that records the call on the member's stage details: the exact prompt, the raw output or error, the attempt number and the model. That record is what the How panel's Raw Prompt and Raw Output sections show. A stage that didn't run leaves no entry.

| # | Stage | When it runs | Prompt | Temperature | What its output does |
|---|-------|--------------|--------|-------------|----------------------|
| 0 | `source-brief` | A source document was supplied (URL mode) | `op-ed-source-brief.prompt` | 0.1 | Extracts a neutral thesis, author, actor type, stance, recommendations and up to 8 key claims. Ignored if the model marks the source unreadable. |
| 1 | `generation` | Always | `op-ed-generation-system.prompt` + `op-ed-generation-user.prompt` | 0.8 | Returns JSON: headline, subtitle, body, rhetorical notes. An empty or non-JSON reply fails this camp's op-ed. |
| 2 | `coherence-judge` | The body is non-empty | `op-ed-coherence-judge.prompt` | 0.1 | Three self-consistency checks (below). A flag counts only if both conflicting spans are supplied and non-empty. |
| 3 | `coherence-rewrite` | The judge flagged something | `op-ed-coherence-rewrite.prompt` | 0.3 | A minimal edit that resolves only the flagged contradictions. |
| 4 | `coherence-rejudge` | A rewrite came back non-empty | `op-ed-coherence-judge.prompt` | 0.1 | The rewrite is kept only if every originally flagged check now passes; otherwise the original body is restored. |
| 5 | `readability-edit` | The body misses the outlet's readability targets | `op-ed-readability-edit.prompt` | 0.3, then a retry at 0.2 | A copy edit for reading level. Guards below. |
| 6 | `grounding-reflection` | There is grounding and a body | `op-ed-grounding-reflection.prompt` | 0.2, then a retry at 0 | Says, for each grounding element, how and where the op-ed reflects it, and maps the source's key claims to paragraphs. This feeds the Why section. |

### Coherence checks

The judge runs three checks against the op-ed's **own** claims. It does not judge whether the position is right or wrong.
- `thesis_solution`: the close asserts the negation of something the op-ed argued earlier.
- `mechanism_scope`: a proposed mechanism's default or failure behaviour violates the scope the op-ed set for it.
- `co_asserted_tension`: two conflicting positions are both asserted, with no reconciling scope stated.

The outcome is recorded on the member. If the judge call or its parse fails, the original body is kept and a WARN is recorded. The coherence pass runs **before** the readability edit, so a later readability edit can re-introduce a contradiction. That gap is accepted.

### Readability edit guards

The edit is checked before it's accepted:
- **Collapse guard.** A result more than 40% shorter than the original is discarded.
- **Voice guard.** If the edit introduces a banned "AI tell" that wasn't in the original, it's reverted.
- **Retry.** If the first edit made the reading grade worse, it's retried once at temperature 0.2, and the better of the two is kept.
- **Paragraph backstop.** Any paragraph still over the word limit is split at sentence boundaries, deterministically, with no model call.

The outcome is recorded as editorial metadata.

### Grounding reflection retry

If a source with key claims was supplied but the reflection extracted no claims, the reflection runs once more at temperature 0. Any reflection failure is non-fatal: grounding then reads "(not reported)".

### Fabricated-lede guard

When no news hook was given, the generation prompt tells the model not to invent a dated event. Afterwards, a pattern scan examines the first 500 characters of the body for markers such as "this week" or "pending vote". A match **flags** the member and records a WARN. It does not change the text.

## How BDI Elements Are Selected and Ranked (the Why section)

1. **Query.** The topic, news hook and thesis are joined and embedded.
2. **Scoring.** Every taxonomy node gets the cosine similarity between its embedding and the query. Nodes without an embedding get no score.
3. **Selection per camp.** A camp's own nodes only, with these settings:
   - threshold 0.48;
   - at least 2 nodes per BDI category, even below the threshold;
   - at most 12 nodes in total.
4. **Order.** Nodes are grouped Beliefs, then Desires, then Intentions, each sorted by score. When the 12-node cap trims the list, the camp's top two are kept first and the rest are ordered by score. **The grounding list is therefore not one global ranking by relevance.**
5. **Situations.** Selected once for the whole set, shared by all camps. Between 1 and 3, using the same 0.48 threshold.
6. **A POV tag** narrows (`scope`) or boosts (`prioritize`) the tagged camp's nodes only.

Each grounding element is stored on the member with `relevance` (its similarity score, to 4 decimals) and `how_reflected` (from the reflection stage). `relevance` measures how close the element is to the **request**. It does not measure how strongly the op-ed used the element: the code computes no such score.

## Interaction Patterns

### Multi-camp sets

One request produces one op-ed per selected camp. The camps share the topic, the parameters, the source brief and the situations; everything else is per camp. Each member is self-contained.

### Partial sets

A camp whose generation fails or is cancelled still appears in the set with `status: 'failed'` or `'cancelled'`, and keeps the stage details that ran before the failure.

## User Interaction Model

- **Single camp:** a set of one.
- **Multi-camp:** the same topic argued by several camps, side by side.
- **URL mode:** each camp responds to a supplied source document, held to the source-fidelity rules.
- **Settings:** outlet, word count, news hook, thesis, author bio, model, and an optional POV tag.
  - The New Op-Ed dialog also offers Max grounding nodes, Max situations and Temperature. These **are not yet wired** into this pipeline, which uses the fixed values above. That's a known issue.

## Performance Considerations

- **Calls per camp:** 2 to 8 model calls (generation, judge, rewrite and re-judge, up to two edits, up to two reflections), plus one source-brief call per set.
- **Concurrency:** camps run sequentially. A 4-camp set takes about four times as long as one camp, but its peak memory is that of one camp.
- **Token budget:** generation's maximum tokens scales with the target length: `ceil(targetWords × 3) + 5000`.
- **Captured text:** each captured prompt or output is capped at 200,000 characters.

---

## Implementation References

This section cites the code and internal structures that implement the operations described above. Citations use symbol names where possible to avoid line-number drift.

| Component/Operation | Implementation |
|---------------------|-----------------|
| Generator entrypoint | `lib/oped/generate.ts:1067` → `export async function* generateOpEdSet()` |
| Progress events | `lib/oped/generate.ts` → `OpEdProgressEvent` type (line 54) |
| Prompt loading and slots | `lib/oped/promptLoader.ts` → `loadAndAssemblePrompt()` |
| Camp soul document | `lib/oped/generate.ts` → `getSoulDocument()` (imported); rendering `buildVoiceBlock()` (line 322) |
| Taxonomy loading | `lib/oped/generate.ts` → `loadTaxonomy()` calls within `generateOpEdSet()` |
| Source brief calls | `lib/oped/generate.ts:1079-1112` (Step 0 source-brief comprehension block); yields `source_brief_done` event |
| Grounding selection | `lib/oped/generate.ts` → `selectRelevantNodes()` call (line 272); `selectRelevantSituationNodes()` within `selectSetGrounding()` |
| Per-camp pipeline | `lib/oped/generate.ts:1186` (sequential for-loop over `request.povs`); `runVoice()` called per POV; results collected via async IIFE |
| Set assembly | `lib/oped/generate.ts` → `OpEdSet` final assembly (line 1206); `orderedMembers` map (line 1199) |
| Call staging recorder | `lib/oped/generate.ts` → `callStage()` function (line 553); records stages to member's `stages` field |
| Source-brief prompt | `lib/oped/prompts/op-ed-source-brief.prompt`; model marks source unreadable; `selectSetGrounding()` handler at line 1033 |
| Generation prompt join | `lib/oped/generate.ts` → `loadAndAssemblePrompt()` assembles `system` + `user` prompts; temperature in `tuning` (line 548) |
| Generation output | `lib/oped/prompts/op-ed-generation-user.prompt`; failure handling via try/catch in `runVoiceGeneration()` (line 629) |
| Coherence checks | `lib/oped/prompts/op-ed-coherence-judge.prompt`; span validation in `coherenceCheck.ts` → `validateClaim()` |
| Coherence rewrite | `lib/oped/prompts/op-ed-coherence-rewrite.prompt` |
| Coherence re-judge | `lib/oped/generate.ts` → within `runVoiceGeneration()` coherence flow (lines 663-715 range) |
| Readability measurement | `lib/oped/readabilityMeasure.ts` → `measureReadability()` function; target check via `needsEdit()` |
| Readability edit guards | `lib/oped/generate.ts` → guards within `runVoiceGeneration()`; collapse guard (line 783); voice guard via `voiceOnly` param (line 549); retry logic in `attemptEdit()` (line 772); paragraph split via `splitLongParagraphs()` |
| Grounding reflection | `lib/oped/generate.ts` → reflection stage within `runVoiceGeneration()`; retry on missing claims via `runReflection()` (line 930) |
| Reflection retry | `lib/oped/generate.ts:962,979` → `runReflection()` first call at temperature 0.2 (:962), retry on missing claims at temperature 0 (:979); coherence re-judge at temperature 0.1 (:712) |
| Fabricated-lede guard | `lib/oped/generate.ts` → `FABRICATED_LEDE_GUARD.test()` on final body (line 1002); pattern from `lib/oped/opedGuards.ts` |
| Query embedding | `lib/oped/generate.ts` → `computeEmbedding()` call within `selectSetGrounding()` |
| Node scoring | `lib/debate/taxonomyRelevance.ts` → `scoreNodeRelevance()` function |
| Relevance threshold | `lib/debate/calibration-config.json` → `relevance.scoreThreshold` (0.48) |
| Selection per camp | `lib/oped/generate.ts` → `selectRelevantNodes()` call per POV (line 272); settings resolved in `resolveOpEdTuning()` (line 543) |
| Node ordering | `lib/debate/taxonomyRelevance.ts` → `selectRelevantNodes()` applies BDI grouping; top-2 preservation logic |
| Situations selection | `lib/oped/generate.ts` → `selectRelevantSituationNodes()` within `selectSetGrounding()` |
| POV tag scoping | `lib/oped/generate.ts` → `tagSoulForPov()` and tag application logic within `generateOpEdSet()` |
| Member grounding fields | `lib/oped/generate.ts` → `relevance` score assigned in `withAppliedTag()` chain; `how_reflected` from reflection output |
| Member types | `lib/oped/types.ts` → `OpEdMember` type definition |
| Partial failures | `lib/oped/generate.ts` → member status field (line 1167); `'failed'` or `'cancelled'` set on catch/abort |
| Dialog settings types | `lib/oped/types.ts` → `OpEdTuning` type definition; `OPED_TUNING_DEFAULTS` |
| Readability/coherence interaction | `lib/oped/generate.ts` → readability checks precede coherence (coherence only runs on readability-passed body) |
| Max tokens formula | `lib/oped/generate.ts` → `const maxTokens = Math.ceil(targetWords * 3) + 5000` (line 595) |
| Text capture limit | `lib/oped/generate.ts` → `capStageText()` function (line 510); 200k char limit enforced at line 517 |
| Word count resolution | `lib/oped/generate.ts` → `const targetWords` in `runVoiceGeneration()` (line 594); resolves from `request.params.wordCount` or outlet band default |
| Temperature defaults | `lib/oped/generate.ts` → `OPED_TUNING_DEFAULTS` (line 527) sets `temperature: 0.8` for generation; `0.1` for coherence retries (line 665, 712) |
| Voice guard activation | `lib/oped/generate.ts` → `voiceOnly: params.voiceOnly === true` (line 549); skips taxonomy load when true (line 1127) |
| Edit attempt retry loop | `lib/oped/generate.ts` → `attemptEdit()` async function (line 772); iterates with increasing temperature on edit failure |

*Symbol-based citations resolve to current code. Line numbers provided where the symbol name alone is ambiguous or for block ranges. Accurate to origin/main at t/174 rebase.*

