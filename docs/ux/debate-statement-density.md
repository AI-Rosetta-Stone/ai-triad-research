# Debate statements: less to take in at once

Status: approved by the human, 2026-11-25 (from the mockup, `engineering/design/mockups/debate-brief-mockup.html`). Owner: Design. Build: DebateWorkspace (renderer) and Debate Engine (summary prompt).
Problem: people report that the debate is overwhelming. Each statement is one dense paragraph at full weight, every turn is open, and the controls don't say what's behind them.

## 1. Brief is the default, and has a shape

- The debate-wide default statement length is **Brief**.
- A Brief is **one claim sentence plus 2 or 3 support bullets**, about 50–70 words in total.
  - The claim is the speaker's position in one sentence, rendered bold in the statement font, one step above body size (`--text-lg`).
  - Each bullet is one piece of support: a study with its year, a fact, or the inference that ties them together. No bullet longer than about 25 words.
  - No tagline, sign-off or rhetorical close in the Brief.
- **Generation (Debate Engine):** `entrySummarizationPrompt` returns the Brief as structured data, `brief_claim: string` and `brief_points: string[]` (2–3 items), alongside the existing `brief` and `medium` strings. The new fields are optional on `entry.summaries`, so old debates keep working.
- **Old debates** without `brief_claim` show the existing `brief` string as a paragraph, as today. They aren't regenerated.

## 2. Two lengths, not three

- The global control at the top of the debate is a two-way toggle: **Brief | Full**. It replaces the Brief / Medium / Detailed dropdown.
  - Full is the statement's own text (`entry.content`), today's Detailed.
  - Medium is no longer offered in the UI. Its data stays.
- The per-statement length dropdown goes away. Each card has its own link instead (§3).
- The choice persists per user as today's default display tier does. A stored `medium` maps to Brief, and a stored `detailed` maps to Full.

## 3. Every Brief says that more exists

- Under each Brief, a text link: **`Read full statement (≈N words)`**, where N is the word count of `entry.content`, rounded to the nearest 10.
- Clicking it shows the full text in place of the Brief, and the link becomes **`Show brief`**. Focus stays on the link.
- It's a button (`aria-expanded`), in link colour, `--text-sm`.
- When the global toggle is Full, cards show the full text, and the link reads `Show brief`.

## 4. Tabs say what's behind them

- The card's Text / Why / How control reads **`Statement`**, **`Why · N sources`** and **`How`**.
  - N is the number of BDI grounding refs the Why tab lists. If there are none, it's just `Why`.
  - The count is `--text-secondary`, normal weight.
- No other change to Why or How content.

## 5. Plain header

- The header reads **`{Speaker} · {Kind}`**, for example `Accelerationist · Opening statement`, `Safetyist · Response`, `Moderator · Question`.
- The statement id (`S2`) and argument-node id (`AN-1`) leave the visible header. They go in the kind label's `title` and stay in the DOM for diagnostics links.

## 6. Turn symbols (model-chosen emoji)

- They move into the header, after the kind, at body size (`--text-base`), not `--text-2xl`.
- Each is `<span role="img" aria-label="{tooltip}">`, with the analogy as its `title`.
- They're decoration, not a control: the click that opens the symbol list is removed.
- No row of their own between the header and the text.

## 7. Tagline

- In Full text, a trailing `Tagline: …` line renders as the statement's last line, in italics, **without the word `Tagline:`**.
- The engine should stop emitting the label: Debate Engine, in the same change as §1. The renderer strip stays as a guard for old debates.

## 8. Older turns collapse to their claim

- In a debate with more than 3 turns, **every turn except the 2 most recent** starts collapsed.
  - A collapsed turn is one row: caret ▸, speaker, kind, and the claim (`brief_claim`, or the first sentence of `brief` for old debates), on one line, ellipsized at two lines.
  - Clicking the row or the caret expands it (`aria-expanded`). Keyboard: Enter and Space.
- When a new turn arrives, the third most recent collapses, unless the user expanded it by hand.
- **`Expand all turns` / `Collapse earlier turns`** sits in the debate toolbar next to Brief | Full.
- Expansion state lasts for the session. It isn't saved with the debate.

## Shared rules

- Tokens only. Contrast checked in harvard, dark, bkc and light.
- Status and controls are text, never colour alone.
- Exports (PDF and Markdown) are unchanged: they keep the full text.

## Out of scope

- Why and How panel content.
- The Convergence view (removed separately, t/697).
- Chat and Op-Ed readers.

## Evidence before sign-off

Real-component renders of a 6+ turn debate in harvard and dark at 1280, and harvard at 390:
- the default (Brief, older turns collapsed);
- one card expanded with `Read full statement`;
- Full mode;
- an old debate without `brief_claim`.

Plus one live debate generated after the prompt change, to check the Brief shape on real output.
