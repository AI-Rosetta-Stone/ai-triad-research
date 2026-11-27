# Debate Synthesis v2: Sponsor Briefing

**Ticket:** t/807 · **Author:** Design · **Date:** 2026-11-27
**Source:** the human's implementation spec `Synthesis.pdf` (2026-11-27, written without repo access) and its canvas mock-up. Where this document and the PDF differ, this document is the repo-checked version; §10 lists every difference and why.
**Supersedes:** the layout in `debate-synthesis.md` (t/4914). It **keeps** that spec's top-3 plus **Show N more** rule (§4 there) and the expander pattern.
**Applies to:** the concluding card (`SynthesisSections.tsx`, `ConcludingSections` in `StatementCard.tsx`), every Text tier.

## 1. Goal

A debate's sponsor answers three questions in under a minute: **where did the debate come out, what can I fairly claim, what must I fix before the next round.** Verdict first, evidence after.

## 2. What the data is today

Checked against `lib/debate/synthesisPipeline.ts` (2026-11-27). The structured object is `entry.metadata.synthesis`; `content` is markdown built from it.

| Spec section | Source field | Note |
|---|---|---|
| Motion / title | `topic_resolution.restated_question` | Fallback: the session topic. |
| Bottom-line paragraph | `topic_resolution.where_it_landed` | **Exists.** No template sentence is needed except when it is absent (§4). |
| Decisive crux | `topic_resolution.what_would_resolve_it` | |
| Common ground | `areas_of_agreement[].point` | Already relevance-ordered (t/769, t/775). Drop `povers` chips here (§6). |
| Disputes | `areas_of_disagreement[]`: `point`, `positions[]`, `type?`, `bdi_layer?`, `resolvability?` | Relevance-ordered. |
| Verdicts | `preferences[]`: `conflict`, `prevails`, `criterion`, `rationale`, `what_would_change_this?` | `prevails: 'undecidable'` means Unresolved. |
| Cruxes | `cruxes[]`: `question`, `type?`, `if_yes?`, `if_no?` | |
| Open questions | `unresolved_questions: string[]` | Flat. No themes. |

**Blocker for the join:** `preferences[].conflict` is free text, not an ID or index. Joining it to a disagreement by text match is unreliable, and this panel's main promise ("each disagreement once, verdict on the same card") depends on it. **Debate Engine adds a stable `id` to each disagreement and a `disagreement_id` to each preference** (§9, child 1). For old debates without IDs, fall back to a normalised text match; an unmatched preference renders as its own card with no type chip, never dropped.

## 3. Panel structure

One scrolling column, `max-width: 760px`, readable at 680 and stacking at 360 (it lives in the concluding card, so it inherits the card's width below that). Eight sections, in this order. Every section with zero items is omitted, and so is its nav link.

1. **Header:** eyebrow **Debate synthesis**; the motion as the title (`--text-xl`, the app serif if it has one, else the sans, weight 600); debater chips (camp dot plus name, "vs" between); section nav with counts (**Common ground 15 · Disputes 4 · Cruxes 7 · Open questions 8**). Actions on the right: **Share** (secondary), **Export brief** (primary), each hidden when the app has nothing to call.
2. **Bottom line** (card): the paragraph (§4), the outcome strip (§5), and **What it takes to settle them** (one row per type present: Definitional → Clearer terms; Empirical → New evidence; Values → A judgment call).
3. **Next moves** (§7).
4. **Common ground:** intro **Points all camps accept.** First 3 in one bordered list with a check icon (`lucide-react` Check, `currentColor`, never emoji), **Show all N points** below.
5. **Disputes:** one card per disagreement (§6).
6. **Cruxes:** intro **Answer one of these and a position should move.** Numbered **C1…Cn**, type chip, text, **Debate this** button. First 3, then **Show N more cruxes**.
7. **Open questions:** intro **Nobody answered these. Expect reviewers to ask.** A checkbox plus label per question (§8).
8. **Footer:** **Synthesis of the full debate transcript.** with **Run another round** (secondary) and **Export brief** (primary).

Section order for model-produced lists is unchanged (t/769): never re-rank on camp.

## 4. Bottom line paragraph

- Primary: `where_it_landed`, shown as written, at most the first 3 sentences with a **Read more** if longer.
- Absent: a template from counts only, e.g. "The camps stated a stronger case on 2 of 4 disputes; 1 is unresolved; 1 has no verdict." **No camp is named as the "winner" in a template sentence.**
- Never write agreement claims the data doesn't carry.

## 5. Outcome strip

- One equal-width segment per dispute, labelled **D1…Dn**, in the Disputes section's order.
- A stronger-case segment is filled in that camp's colour; **Unresolved** is a light fill with a dashed border. They differ in lightness and border style, not hue alone.
- Legend under it: the count per camp and Unresolved; show camps with 0.
- The strip's heading is **Which camp made the stronger case (model's assessment)**. The verdicts are a model judgement (`preferences[].prevails`), and the label says so.
- `role="img"` with an `aria-label` spelling out every dispute's outcome, e.g. "D1: Skeptic stronger. D2: Unresolved."
- No verdicts yet (synthesis running): all segments Unresolved, label **Verdicts pending**.
- The camp colours are the existing `--color-acc`, `--color-saf`, `--color-skp` (`design-system.md` §colour). Segment text uses `-bg`/text pairs that pass 4.5:1 in all four themes; **Design measures them live** (`/design-review-workflow`).

## 6. Dispute card

- **Top row:** `D#` (mono), type chip, an optional "· about …" qualifier (from `bdi_layer`, §10), verdict chip on the right.
- **Question:** `<h4>`, `--text-md`, weight 600, `point` as written. **Don't rewrite it** (the PDF's "rewritten as a plain question" needs a model call; see §10).
- **Footer:** the one-line why (`Why: the <Camp>'s argument <phrase>.` from `criterion`, via one constant table; unknown codes show the raw value in plain text) and **Read both sides**, which expands `positions[]` in place (side by side at ≥640 px, stacked below).
- Each disagreement appears exactly once.
- Type chip labels: `Definitional`, `Empirical`, `Values`, never the raw tag. An unknown type shows its raw value in plain text, never a blank chip. Keep the raw value in a `data-` attribute.
- `bdi_layer` translations: belief → "about what's true", intention → "about what the plan intends", desire → "about what matters more".
- Camp chips are the no-fill style from `debate-synthesis.md` §5; text carries the name.

## 7. Next moves

Rule-generated, no model call, cheapest first. Heading **Next moves**, not "Your next moves": the app doesn't record who sponsored a debate, so nothing may say "your case".

| Present | Card |
|---|---|
| a Definitional dispute | **Define <term>**; chip "Settles D#" |
| Empirical disputes | **Find a way to measure <thing in dispute>**; chip "Bears on D#, D#" |
| a Values dispute | **Name the trade-off on <topic>**; chip "Answers D#" |

Body: one or two sentences, drawn from the dispute's `resolvability` / `what_would_change_this`. A debate with no Values dispute shows no trade-off card. `<term>` / `<thing>` / `<topic>` come from the dispute's `point`, shortened to 8 words at a word boundary.

## 8. Open questions

- Checkbox plus `<label>` per question. State is saved **with the debate** if the debate model can hold it, else in `localStorage` keyed by debate id. Debate Engine/DebateWorkspace say which in the PR; don't decide silently.
- **No keyword grouping.** The PDF's keyword map (funding/grant/budget, room/kit/bench, teacher) is specific to the physics-labs sample and would mis-group AI-policy debates. Until the model supplies themes (an optional `theme` string per question, §9 child 1), render one flat list. When themes exist, group in `fieldset` + `legend` cards, 2 columns at ≥640 px.

## 9. Work split

1. **Debate Engine (t/808):** `id` on each disagreement, `disagreement_id` on each `preference`, optional `theme` on each unresolved question; all optional, with a WARN fallback, in the style of t/700. Old debates stay readable.
2. **DebateWorkspace (t/809):** `buildSynthesisView(synthesis)`, a pure function with every join, label translation and rule (all unit-tested: all resolved, all unresolved, three debaters, unknown tag or code, empty sections, unmatched preference, old debate without IDs). Presentational components take view-model data only. Behind a flag (`synthesisV2`) that is **removed within one train after the human signs off**; no long-lived dual path.
3. **Debate Engine (t/810):** `debateExport` / `formatters` follow the panel's sections and order (Markdown brief), including verdicts on each dispute and the "(model's assessment)" label.

## 10. Differences from the PDF, with reasons

| PDF | This spec | Why |
|---|---|---|
| `--syn-*` hex palette (#FAF8F3 etc.) | The app's theme tokens; new ones only for type chips and verdict fills, each defined per theme | Hard-coded light hex breaks dark, bkc and harvard. The app has four themes. |
| Inter / Source Serif 4 | The app's fonts | No new font files. |
| "Safe to build your case on"; "Your next moves" | "Points all camps accept"; "Next moves" | The panel can't certify safety, and the app doesn't record a sponsor. |
| "Who made the stronger case" | Same strip, labelled "(model's assessment)" | Verdicts are a model judgement; the reader should know. |
| Keyword-map grouping of open questions | Flat list until a model `theme` exists | The map is domain-specific. |
| Question "rewritten as a plain question" | `point` as written | Needs a model call the PDF rules out. |
| Template bottom line | `where_it_landed` first | The field exists. |
| Join "by disagreement ID" | IDs added by Debate Engine (§2) | There is no ID today. |
| Fixture "physics-labs debate" | Any saved debate with verdicts; the human's `e81f79f2` for a real case | Use real data in the repo's scratch root. |

## 11. States, accessibility, acceptance

- **Empty/partial:** section absent when zero items (and its link); long text wraps, never ellipsised; "couldn't be read" (t/774) shows **Agreements couldn't be read for this synthesis.** in place of that section.
- **Accessibility:** real `<button>`, `<a href>`, `<input type="checkbox">` with `<label>`; `aria-expanded` + `aria-controls` on every expander; nav links scroll the panel and move focus to the section heading, honouring `prefers-reduced-motion`; full keyboard path in visual order; visible focus ring; buttons ≥40 px tall (44 px when alone).
- **Acceptance:**
  1. Bottom line, outcome strip and dispute types visible without scrolling at 680–900 px.
  2. Each disagreement appears once with its verdict; no raw tags (`[EMPIRICAL]`, `{belief}`, `D2-skeptic`) anywhere.
  3. Strip counts equal the verdicts per camp plus Unresolved; nav counts match the sections.
  4. Next moves come from the rule table only.
  5. 4.5:1 text contrast in light, dark, bkc and harvard, **measured live by Design**; no horizontal scroll at 360 px.
  6. Order of lists is the engine's (t/769); a label-swap test shows no camp-dependent sort.
  7. Export order matches the panel.
  8. Screenshots at 360, 680 and 1024 px, harvard and dark; every control hidden for lack of a backing action is listed in the PR.
  9. Design approves through the reviewer App; the human signs off before the flag is removed.
