# Ask a Question: collapse run settings into an Options disclosure

**Status:** Spec, ready to implement (t/4667)
**Owner:** Design. **Builds it:** Rosetta Stone. **Reviews before Done:** Design.
**Requested by:** PI, p/351#51 (2026-10-30), with a marked-up screenshot of the New question screen. TL direction on t/4667 (p/376#118).
**Component:** `taxonomy-editor/src/renderer/components/inquiry/InquiryAskPanel.tsx` (+ `InquiryTab.css`)

## Why

The New question screen shows every run setting at once: three fidelity cards, two model pickers, the POV tag picker and a note about model defaults. Most people only type a question and press Ask, and the defaults (Quick, with the models that come with it) are right for them. The settings push Ask down and make a one-field task look like a configuration form. The PI asked for these controls to move into a separate Options area.

## What moves, what stays

| Stays outside Options | Moves inside Options |
|---|---|
| "← My Questions" back button | Fidelity cards (Quick / Standard / Deep) |
| "New question" heading | Debaters model picker |
| Research question field (still focused on open, cursor at end, per t/4562) | Evaluator model picker |
| Ask button and the budget line | POV tag picker (`InquiryTagPicker`) |
| Error line (`role="alert"`) | The "Both default from the fidelity you picked…" note |

Nothing else changes: not the store, the defaults, or what gets recorded with the answer. This is a layout and interaction change only.

## Pattern: the t/4639 accordion, and why not New Debate's dialog

**Use the t/4639 disclosure** (`LibraryGettingStarted`): one full-width toggle `<button aria-expanded aria-controls>` with a chevron, and a body that uses the `hidden` attribute. It's a recessed strip when collapsed and the filled card when expanded.

**Why Ask doesn't reuse New Debate's settings dialog.** New Debate keeps its preset cards on the main screen and opens a sectioned `DebateSettingsDialog` (five sections, Apply, save-as-preset) from an "Advanced settings" button. Ask differs in three ways:
1. **The PI's markup puts the fidelity cards inside Options.** New Debate's preset cards are the part it keeps outside, so its split doesn't match.
2. **Ask has four controls and no presets.** A sectioned modal with Apply would be heavier than the thing it hides.
3. **The budget line has to track the fidelity live.** Inline, the user changes a card and sees the budget beside Ask update. A modal would hide that until it closed.

**What Ask does reuse from New Debate:** showing that something changed from the default. Ask shows that through the summary text itself (below), not with a count badge, because the summary already names the values.

## Layout

### Collapsed (default)

```
New question
Research question
┌──────────────────────────────────────────────────────────┐
│ What counts as an AI harm, and what would prove one?     │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ Options · Quick · gemini-3.5-flash-lite · Untagged    ▾  │
└──────────────────────────────────────────────────────────┘
[ Ask ]  Budget for this run: 120 API calls. You'll see it deplete as it goes.
```

### Expanded

```
┌──────────────────────────────────────────────────────────┐
│ Options · Quick · gemini-3.5-flash-lite · Untagged    ▴  │
│                                                          │
│ ( Quick )  ( Standard )  ( Deep )     ← existing cards   │
│ Debaters   [ gemini-3.5-flash-lite — from Quick    ▾ ]   │
│ Evaluator  [ gemini-3.5-flash-lite — from Quick    ▾ ]   │
│ POV tag    [ existing InquiryTagPicker ]                 │
│ Both default from the fidelity you picked. …             │
└──────────────────────────────────────────────────────────┘
[ Ask ]  Budget for this run: …
```

### The toggle (summary line)

- **Label:** `Options` in the t/4639 title style (15px, 600, `--text-primary`), followed by the summary in `--text-secondary`: `· {Fidelity} · {model} · {tag}`.
  - `{model}` is the debater model. When the evaluator differs, show `Debaters {a} · Evaluator {b}`.
  - `{tag}` is the selected tag's label, with `(prioritize)` in prioritize mode, or `Untagged`.
  - Each value truncates with an ellipsis at about 32 characters, with the full text in the toggle's `title`.
- **The summary stays visible when expanded,** so the toggle reads the same in both states. The chevron flips.
- **Accessible name:** the whole button text, e.g. "Options · Quick · gemini-3.5-flash-lite · Untagged", plus `aria-expanded`. Screen-reader users hear the current settings without opening it.
- **Hit area:** `min-height: 44px` when collapsed and at least 24px when expanded, per t/4639#4 item 4. Use `font: inherit` on the button, per t/4639#4 item 2.

### The body

- Move the existing markup in unchanged: the `inquiry-fid` radiogroup, both `inquiry-mrow` selects, `InquiryTagPicker` and `inquiry-mnote`. Don't restyle the cards.
- Use the `hidden` attribute for collapse (the global `[hidden]` reset from t/4647 protects it).
- Changes write to the store immediately, as today. The summary and the budget line update live.

### State

- **Collapsed by default** on every visit, so each question starts uncluttered.
- **Auto-expand when the tag blocks the run** (below), so the cause is never hidden.
- Don't persist the open state. If the PI later wants it remembered, persist it per user, not per question.

## Blocked tag

When `inquiryTagBlocked(tagSelection)` returns a reason, Ask is disabled. The cause must never sit inside a collapsed area:
- the disclosure expands automatically;
- the toggle's summary shows `POV tag: {reason}` in `--warning`, replacing the tag segment;
- the reason is added to Ask's `aria-describedby`.

## Keyboard and focus

- The toggle is a native `<button>`, so Enter and Space work and focus stays on it after toggling.
- Tab order: question field → Options toggle → (when expanded) fidelity cards → Debaters → Evaluator → POV tag controls → Ask.
- **Fidelity radiogroup:** while moving it, add arrow-key navigation (Left/Right and Up/Down change the selection) and a roving `tabIndex` (only the checked card has `tabIndex={0}`), so Tab passes the group in one stop. Enter and Space keep working.

## Phone width

Same disclosure. The fidelity cards stack in one column, and the model selects go full width. The summary line wraps under "Options" rather than truncating harder.

## Accessibility checklist

- Toggle: `aria-expanded` and `aria-controls` = the body id. Its visible text is the accessible name.
- Blocked-tag reason is visible on the toggle and linked to Ask.
- Contrast at least 4.5:1 in light, dark, bkc and harvard for the summary (`--text-secondary` on the strip and card backgrounds) and the blocked reason (`--warning`). Design measures this in the review.
- No `--focus-ring` as a text colour. Use it only for the `:focus-visible` outline.

## Acceptance criteria

1. Outside Options: back button, heading, question field, Ask with the budget line, error line. Inside: fidelity cards, both model pickers, POV tag, the note.
2. Options is collapsed by default, using the t/4639 accordion pattern. The toggle shows `Options · {fidelity} · {model} · {tag}` in both states.
3. Changes apply immediately. The summary and the budget line update live.
4. A blocked tag auto-expands Options, shows its reason on the toggle and disables Ask with that reason described.
5. Keyboard: native toggle, the Tab order above, and arrow keys with a roving tabIndex on the fidelity cards.
6. Tests: summary text for the default, overridden-model, differing-evaluator and tagged states; toggle `aria-expanded` and `hidden`; blocked-tag auto-expand; arrow keys on the fidelity group.
7. Design `/design-review-workflow` pass, including contrast in all four themes, before Done.
