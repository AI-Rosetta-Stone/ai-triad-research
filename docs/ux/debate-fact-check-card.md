# Debate fact checks: the finding at a glance, details on demand

Status: approved by the human, 2026-11-26 (from the mockup `engineering/design/mockups/debate-factcheck-mockup.html`). Owner: Design. Build: Debate Engine (fact-check prompt) and DebateWorkspace (renderer). Companion to `debate-statement-density.md`.
Problem: a fact check is one long paragraph. It states the verdict three times, doesn't say whose claim it checked, and buries the caveat a reader most needs.

## 1. Card, top to bottom

1. **Header:** `Fact check`, then the verdict pill, then on the right `of {Speaker} · {Kind}`. The last part is a link that scrolls to and highlights the checked statement (`metadata.fact_check.target_an_id`, or the entry it was raised on).
   - The statement id (`S4`) leaves the visible header and goes in a `title`.
   - Without a known target, the `of …` part is omitted.
2. **Checked:** `Checked:` in `--text-secondary`, then the checked claim (`checked_text`) in italic serif with typographic quotes, on one or two lines.
3. **Finding:** one sentence in bold serif at `--text-lg`, beginning with a plain verdict word: `Accurate.`, `Partly accurate.`, `Overstated.`, `Disputed.`, `False.`, `Can't be verified.` At most about 25 words. This is the one place the verdict is put in words.
4. **Points:** 1–3 bullets, each about 25 words or fewer.
   - The first is the evidence: who, where and when.
   - Any caveat is its own bullet, starting with the label **`Limit`** (small caps, `--text-xs`, weight 700, in the warning text token). There's at most one `Limit` bullet.
5. **For `partially_accurate` only:** a two-row `Claimed` / `Source says` list from the existing `discrepancy` (`claimed`, `actual` and `source`) replaces the points. The finding still comes first.
6. **Sources:** `Sources:` followed by short links (publisher or short title plus year) to `web_search_citations[].uri`, with `· +N` when there are more than 3. Always visible. Omitted when there are none.
7. **`Show details` / `Hide details`:** a text button with `aria-expanded`. It expands in place.

## 2. Details panel

- **Full reasoning:** the existing `explanation`, unchanged, under the heading `Full reasoning`.
- **Web search:** the queries (`web_search_queries`) on one line, `Searched: "…" · "…"`, then the numbered citation list with domains, as today's web evidence shows it.
- **Taxonomy sources** (`sources[]` node and conflict ids) as chips, if any.
- This replaces the separate `Show Web Evidence` button and the `Verified against web search results` / `Web sources consulted: …` line in the body.

## 3. Verdict pills

The text is always present, so colour is never the only signal.

| verdict | Pill text | Token pair | Card left border |
|---|---|---|---|
| supported | `SUPPORTED` | success text / success bg | success |
| partially_accurate | `PARTLY ACCURATE` | warning text / warning bg | warning |
| disputed | `DISPUTED` | danger text / danger bg | danger |
| false | `FALSE` | danger text / danger bg | danger |
| unverifiable | `CAN'T VERIFY` | neutral (`--text-secondary` / `--bg-tertiary`) | neutral |
| pending | `CHECKING…` | neutral | neutral |

Each pair must pass AA in all four themes (`semantic-tint-tokens.md`).

## 4. Collapsing

- Fact checks join the §8 collapse rule of `debate-statement-density.md`. They count as turns for "all but the 2 newest" and collapse like statements.
- A collapsed fact check is two lines (as in t/761):
  - line 1: caret, `Fact check`, the pill, and `of {Speaker} · {Kind}` as plain text;
  - line 2: the finding sentence, ellipsized at 2 lines.

## 5. Generation (Debate Engine)

- `factCheckPrompt` (`lib/debate/prompts/synthesis.ts`) also returns:
  - `finding: string`: one sentence of at most 25 words, starting with the plain verdict word in §1.3;
  - `finding_points: string[]`: 1–3 items of at most 25 words. Name sources by title, publisher or author, never by raw document or node id.
  - `limit?: string`: at most 25 words, only when there's a real caveat.
- `explanation`, `discrepancy` and `sources` are unchanged. Store the new fields under `metadata.fact_check` as optional fields, and validate them: if malformed, drop them with a WARN.
- Neutral summary verbs, with no intensifiers (the rule from t/700).
- `formatFactCheckContent` stops writing the `**Fact Check: {Label}**` title line and the web note into `content`. The verdict is the pill, and provenance lives in the details panel.

## 6. Old fact checks

- An entry without `finding`: use the first sentence of `explanation` that isn't "This matters…" framing as the finding, if it's 30 words or fewer. Otherwise show `explanation` as today, under the header and the checked claim.
- `Show details` still holds the web evidence.
- No regeneration.

## Out of scope

- How and when fact checks are triggered.
- The verdict logic.
- The CLI/engine fallback path (`gapAndDrift.ts`).

## Evidence before sign-off

- Real-component renders in harvard and dark at 1280 and harvard at 390 for: supported with a `Limit`, partially accurate, disputed collapsed, details open, and an old fact check.
- One sample of 4 or more fact checks generated with the new prompt (TL spend approval).
