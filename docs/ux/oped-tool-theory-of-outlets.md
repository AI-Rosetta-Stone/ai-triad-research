# Op-Ed Tool: Theory of Outlets

## Overview

This document describes **what changes when you pick a different outlet** in the Op-Ed tool. An outlet stands for a real publication's opinion desk. It sets the op-ed's target length, what the editor is looking for, the reading level, and the house style. The camp's argument and grounding don't change. It describes the code as it is, with file:line citations.

## Where Outlets Are Defined

- **One source of truth:** `lib/oped/outlets.json`. It has 9 outlets, a default outlet, and a `styleDefaults` block. Its shape is fixed by `lib/oped/outlets.schema.json`, and it's typed in `lib/oped/outletsSsot.ts:29-36`.
- **Loader:** `lib/oped/loadOutlets.ts:24-30`. It refuses to load if `__meta__.outlets_count` doesn't match the number of outlets (`loadOutlets.ts:8-20`).
- **Lookup:** `resolveOutletBand` (`lib/oped/outletBands.ts:33-50`). An unknown outlet name is refused with the list of valid names. No outlet given means `TechPolicyPress` (`outletBands.ts:35`).
- **Who reads it:**
  - the New Op-Ed dialog's outlet list and default (`taxonomy-editor/src/renderer/components/opeds/NewOpEdDialog.tsx:17,50-59`);
  - the server's request validation (`taxonomy-editor/src/server/routes/oped.ts:69-70`);
  - the PowerShell cmdlet (`scripts/AITriad/Private/Get-OpEdOutletsData.ps1`).

## What an Outlet Changes

An outlet entry has two required fields and two optional ones (`outlets.schema.json:50-90`, `outletBands.ts:22-29`):

| Field | Required | What it changes |
|-------|----------|-----------------|
| `words` | yes | **Target length.** Used unless the request sets a word count above 0 (`lib/oped/generate.ts:560`). It also sizes generation's token budget, `ceil(words × 3) + 5000` (`generate.ts:561`). It reaches the prompt as `{{WORD_COUNT}}` in both the system prompt (section proportions, `op-ed-generation-system.prompt:11`) and the user prompt ("a hard editorial limit", `op-ed-generation-user.prompt:6`). |
| `guidance` | yes | **What the editor wants.** One paragraph describing the desk: its length band, hook, audience and conventions. Injected verbatim as `{{OUTLET_GUIDANCE}}` into both prompts (`lib/oped/promptLoader.ts:77,88`). |
| `readability` | no | **When the readability edit runs.** `fkMax`, `maxSentWords` and `maxParaWords`. A draft over any of them triggers the edit pass (`generate.ts:559,735`; `readabilityMeasure.ts:67-69`). Absent means `styleDefaults.readability`: FK 11, 30-word sentences, 90-word paragraphs (`outlets.json:17-21`). |
| `style` | no | **House style in the generation prompt.** Six strings: `audience`, `readingLevel`, `sentenceMechanics`, `paragraphMechanics`, `jargonGuidance`, `bodyFormat`. Each replaces the matching `styleDefaults` string (`promptLoader.ts:64-71`). They fill the system prompt's opening line and STYLE MECHANICS section (`op-ed-generation-system.prompt:1,23-28`), and the body-format instruction in the user prompt (`op-ed-generation-user.prompt:44`). Absent means the mass-market defaults (`outlets.json:11-16`). |

**What an outlet does not change:**
- the camp's voice, values and grounding;
- the coherence checks;
- the grounding reflection;
- the model;
- the source-fidelity rules.

### Known gap: the readability-edit prompt ignores the outlet

When the readability edit runs, the measured problems it's given use the outlet's targets (`readabilityMeasure.ts:72-82`). But the prompt's own rules are fixed at grade 10: "no higher than 11", 30-word sentences, 90-word paragraphs (`lib/oped/prompts/op-ed-readability-edit.prompt:1,10-12`).

For an outlet with looser targets (today, only Tech Policy Press), the editor gets contradictory instructions. One line says "no higher than 16" and another says "no higher than 11", which pulls a specialist op-ed toward mass-market prose. This is tracked as t/202. **Until it's fixed, the readability pass is reliably outlet-aware only for outlets that use the default targets.**

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

Values are from `lib/oped/outlets.json:23-73`. The dialog labels come from `NewOpEdDialog.tsx`'s presentation map (`NewOpEdDialog.tsx:38-48`). An outlet missing from that map falls back to its key (`NewOpEdDialog.tsx:50-54`).

**The default outlet** is `TechPolicyPress`. It's set in two places: `outlets.json:9` (`defaultOutlet`, which the dialog uses) and `outletBands.ts:35` (used when a request has no outlet).

### What Tech Policy Press changes, concretely

Every other outlet uses the defaults. Tech Policy Press is the one that differs (`outlets.json:56-72`):
- **Audience:** "an informed policy audience" instead of "a broad, non-specialist public".
- **Reading level:** about grade 13 (no higher than 14) instead of about grade 10 (no higher than 11).
- **Sentences and paragraphs:** sentences up to 40 words (average under about 24) instead of 30 (average under 18); paragraphs up to about 120 words instead of 90.
- **Jargon:** keep the precise policy vocabulary, instead of eliminating jargon.
- **Body format:** 3-5 sections with `##` subheadings, instead of continuous prose with no headers.

## How to Add an Outlet

1. **Add an entry** under `outlets` in `lib/oped/outlets.json`, with `words` and `guidance`. Add `readability` and/or `style` only if the desk differs from the defaults. A `style` block must have all six strings (`outlets.schema.json:76-88`).
2. **Bump `__meta__.outlets_count`** in the same file. The loader refuses to start if it's wrong (`loadOutlets.ts:8-20`).
3. **Add a dialog label and band** to the presentation map in `NewOpEdDialog.tsx`. Without one, the dialog shows the raw key.
4. **Run the outlet tests:**
   - `lib/oped/__tests__/outletsKeySetGate.test.ts` checks that the TypeScript outlet set equals `outlets.json`;
   - `outletBands.test.ts` and `loadOutlets.test.ts`;
   - the PowerShell side validates the same file against the schema (`Get-OpEdOutletsData.ps1:78`).
5. **Update the table above.**

---

*Accurate to the code at the time of writing. When `outlets.json` or the prompts change, update this document and its citations.*
