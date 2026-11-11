# Op-Ed Tool: Theory of Outlets

**Author:** Ai Triad Research | **Status:** Design approved | **Last updated:** 2026-11-10

## Overview

This document describes **what changes when you pick a different outlet** in the Op-Ed tool. An outlet stands for a real publication's opinion desk. It sets the op-ed's target length, what the editor is looking for, the reading level, and the house style. The camp's argument and grounding don't change. Implementation details are cited in the Implementation references section.

## Where Outlets Are Defined

- **One source of truth:** `lib/oped/outlets.json`. It has 9 outlets, a default outlet, and a `styleDefaults` block. Its shape is fixed by `lib/oped/outlets.schema.json`.
- **Loader:** The loader throws if the declared outlet count doesn't match the number of outlets.
- **Lookup:** An unknown outlet name is refused with the list of valid names. No outlet given means `TechPolicyPress`.
- **Who reads it:**
  - the New Op-Ed dialog's outlet list and default;
  - the server's request validation;
  - the PowerShell cmdlet.

## What an Outlet Changes

An outlet entry has two required fields and two optional ones:

| Field | Required | What it changes |
|-------|----------|-----------------|
| `words` | yes | **Target length.** Used unless the request sets a word count above 0. It also sizes generation's token budget. It reaches the prompt in the system prompt (section proportions) and the user prompt. |
| `guidance` | yes | **What the editor wants.** One paragraph describing the desk: its length band, hook, audience and conventions. Injected into the user prompt. |
| `readability` | no | **When the readability edit runs.** Maximum reading level, sentence words, and paragraph words. A draft over any of them triggers the edit pass. Absent means default values: FK 11, 30-word sentences, 90-word paragraphs. |
| `style` | no | **House style in the generation prompt.** Six strings: `audience`, `readingLevel`, `sentenceMechanics`, `paragraphMechanics`, `jargonGuidance`, `bodyFormat`. Each replaces the matching default string. Absent means the mass-market defaults. |

**What an outlet does not change:**
- the camp's voice, values and grounding;
- the coherence checks;
- the grounding reflection;
- the model;
- the source-fidelity rules.

## Current Outlets

| Key | Dialog label | Words | Guidance (summary) | Readability | Style |
|-----|--------------|------:|--------------------|-------------|-------|
| `WashingtonPost` | The Washington Post | 800 | Max 800, strong news hook, sourced, zero jargon; national public | default | default |
| `NYTimes` | The New York Times | 800 | ~800, sharp thesis, general national readership | default | default |
| `WallStreetJournal` | The Wall Street Journal | 900 | 600-1200, rapid thesis, market and regulatory framing; executives, investors, policymakers | default | default |
| `USAToday` | USA Today | 650 | 550-750, verifiable sources, plain and direct; broad national | default | default |
| `ForeignAffairs` | Foreign Affairs | 1200 | 800-1500, deeper structural analysis; specialists, Hill staff, agency officials | default | default |
| `Politico` | Politico | 1000 | ~1000, policy mechanics, timely; Hill and agency | default | default |
| `Regional` | Regional / local daily | 650 | 500-800, regional relevance, local anecdotes, state-level calls to action | default | default |
| `Generic` | Generic | 800 | ~800, news hook, plain language; broad public | default | default |
| `TechPolicyPress` | Tech Policy Press | 1500 | 1200-2000 in 3-5 subheaded sections; analytical, precise policy vocabulary; tech-and-democracy audience | FK 16, 40, 120 | own block |

Values are from `lib/oped/outlets.json`. The dialog labels are presented in the Op-Ed interface. An outlet missing from the presentation map falls back to its key.

**The default outlet** is `TechPolicyPress`. It's set in two places: the outlets configuration (used by the dialog) and the outlet resolution function (used when a request has no outlet).

### What Tech Policy Press changes, concretely

Every other outlet uses the defaults. Tech Policy Press is the one that differs:
- **Audience:** "an informed policy audience" instead of "a broad, non-specialist public".
- **Reading level:** about grade 13 (no higher than 14) instead of about grade 10 (no higher than 11).
- **Sentences and paragraphs:** sentences up to 40 words (average under about 24) instead of 30 (average under 18); paragraphs up to about 120 words instead of 90.
- **Jargon:** keep the precise policy vocabulary, instead of eliminating jargon.
- **Body format:** 3-5 sections with `##` subheadings, instead of continuous prose with no headers.

## How to Add an Outlet

1. **Add an entry** under `outlets` in `lib/oped/outlets.json`, with `words` and `guidance`. Add `readability` and/or `style` only if the desk differs from the defaults. A `style` block must have all six strings.
2. **Bump the outlet count** in the same file. The loader throws if the count is wrong.
3. **Add a dialog label and band** to the presentation map in the Op-Ed dialog component. Without one, the dialog shows the raw key.
4. **Run the outlet tests:**
   - Check that the TypeScript outlet set equals `outlets.json`;
   - run outlet band and load outlet tests;
   - the PowerShell side validates the same file against the schema.
5. **Update the table above.**

---

## Implementation References

This section cites the code structures that implement the outlet system.

| Component | Implementation |
|-----------|-----------------|
| Outlet source file | `lib/oped/outlets.json` |
| Outlet schema | `lib/oped/outlets.schema.json` |
| Outlet type definitions | `lib/oped/outletsSsot.ts` → `OutletsData` (with `OutletsMeta` and `OutletStyleDefaults`) |
| Outlet loader | `lib/oped/loadOutlets.ts` → `loadOutletsData()` |
| Loader consistency check | `lib/oped/loadOutlets.ts` → `validateOutletsData()` (throws if `__meta__.outlets_count` differs from the number of outlets) |
| Outlet lookup function | `lib/oped/outletBands.ts` → `resolveOutletBand()` |
| Default outlet | `lib/oped/outletBands.ts` → `resolveOutletBand()` returns `TechPolicyPress` when no outlet is specified; the dialog's default is `defaultOutlet` in `lib/oped/outlets.json` |
| Outlet band types | `lib/oped/outletBands.ts` → `OutletBand` and `OutletBandStyle` |
| Word count usage | `lib/oped/generate.ts` → `targetWords` in `runVoiceGeneration()` (request word count if above 0, else the band's `words`); token budget `maxTokens` in `runVoiceGeneration()` (formula `ceil(words × 3) + 5000`) |
| Guidance slot injection | `lib/oped/promptLoader.ts` → `loadAndAssemblePrompt()` ({{OUTLET_GUIDANCE}}; only `op-ed-generation-user.prompt` contains this slot) |
| Word count slot injection | `lib/oped/promptLoader.ts` → `loadAndAssemblePrompt()` ({{WORD_COUNT}}) |
| Style defaults | `lib/oped/outlets.json` → `styleDefaults` (six prose strings) |
| Readability defaults | `lib/oped/outlets.json` → `styleDefaults.readability`, exposed as `DEFAULT_READABILITY_TARGETS` in `lib/oped/readabilityMeasure.ts` |
| Style slot injection | `lib/oped/promptLoader.ts` → `loadAndAssemblePrompt()` (each style string falls back to `styleDefaults`) |
| Style prompt sections | `op-ed-generation-system.prompt`: opening paragraph ({{STYLE_AUDIENCE}}) and the STYLE MECHANICS section; `op-ed-generation-user.prompt`: the `body_markdown` field ({{STYLE_BODY_FORMAT}}) |
| Readability check trigger | `lib/oped/generate.ts` → `runVoiceGeneration()` calls `needsEdit()` on `measureReadability()` with `readTargets` (the band's `readability`, else `DEFAULT_READABILITY_TARGETS`); both functions are in `lib/oped/readabilityMeasure.ts` |
| Readability edit prompt | `lib/oped/prompts/op-ed-readability-edit.prompt`: "RULES FOR YOUR EDIT (this outlet's targets)" ({{FK_MAX}}, {{MAX_SENT_WORDS}}, {{MAX_PARA_WORDS}}), filled by `assembleReadabilityEditPrompt()` in `lib/oped/promptLoader.ts` |
| Dialog outlet list | `taxonomy-editor/src/renderer/components/opeds/NewOpEdDialog.tsx` → `OUTLET_PRESENTATION` and `OUTLETS` |
| Server outlet validation | `taxonomy-editor/src/server/routes/oped.ts` → `validateOutlet()` |
| PowerShell outlet data | `scripts/AITriad/Private/Get-OpEdOutletsData.ps1` → `Get-OpEdOutletsData` (validates against `outlets.schema.json` with `Test-Json`) |

*Citations are file plus symbol (or JSON key / prompt section), checked against origin/main. When `outlets.json` or the prompts change, update this document and its citations.*
