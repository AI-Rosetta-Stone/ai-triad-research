# Ask a Question: move run settings into an Options dialog

**Status:** Spec, ready to implement
**Owner:** Design
**Requested by:** PI, p/351#51 (2026-10-30), with a marked-up screenshot of the New question screen
**Component:** `taxonomy-editor/src/renderer/components/inquiry/InquiryAskPanel.tsx` (+ `InquiryTab.css`)

## Why

The New question screen shows every run setting at once: three fidelity cards, two model pickers, the POV tag picker and a note about model defaults. Most people only type a question and press Ask, and the defaults (Quick, with the models that come with it) are right for them. The settings push the Ask button down and make a one-field task look like a configuration form. The PI asked for these controls to move into a separate Options experience.

## What moves, what stays

| Stays on the New question screen | Moves into the Options dialog |
|---|---|
| "← My Questions" back button | Fidelity cards (Quick / Standard / Deep) |
| "New question" heading | Debaters model picker |
| Research question field (still focused on open, cursor at end, per t/4562) | Evaluator model picker |
| **New:** the Options summary row (below) | POV tag picker (`InquiryTagPicker`) |
| Ask button and the budget note | The "Both default from the fidelity you picked…" note |
| Error line (`role="alert"`) | |

No behaviour changes. The store, the defaults and what gets recorded with the answer all stay the same. This is a layout and interaction change only.

## New question screen

```
New question
Research question
┌──────────────────────────────────────────────────────────┐
│ What counts as an AI harm, and what would prove one?     │
└──────────────────────────────────────────────────────────┘

Quick · gemini-3.5-flash-lite · Untagged        [ Options… ]

[ Ask ]  Budget for this run: 120 API calls. You'll see it deplete as it goes.
```

### Options summary row

One line between the question field and Ask, showing the settings that will run:

- **Text:** `{Fidelity} · {model} · {tag}`, in `--text-secondary` at the body size.
  - `{model}` is the debater model. When the evaluator differs from the debater model, show both: `Debaters {a} · Evaluator {b}`.
  - `{tag}` is the selected tag's label, plus `(prioritize)` in prioritize mode. With no tag, show `Untagged`.
  - When the user has overridden a model, append nothing extra. The summary just shows the model that will run, and the dialog shows where it came from.
- **Button:** `Options…`, styled `.btn-ghost`, right-aligned on desktop. It sits on the same line as the summary and wraps under it on narrow widths.
  - `aria-haspopup="dialog"`, and `aria-describedby` pointing at the summary text so a screen reader hears "Options…, Quick, gemini-3.5-flash-lite, Untagged".
- **Blocked tag:** when `inquiryTagBlocked(tagSelection)` returns a reason, Ask is disabled. The reason must be visible **on this screen**, not only inside the dialog. Show it under the summary in `--warning` text, as `POV tag: {reason}. Change it in Options.`, and add it to Ask's `aria-describedby`.

The budget note stays next to Ask and keeps updating with the fidelity, because it describes the cost of pressing Ask.

## Options dialog

Uses the design system's **Modal Dialog** pattern (`.dialog-overlay` + `.dialog`, as in SettingsDialog). On phone widths it becomes the **bottom sheet** pattern.

```
┌ Options ─────────────────────────────────────────── × ┐
│ Fidelity                                               │
│ ( Quick )  ( Standard )  ( Deep )      ← existing cards │
│                                                        │
│ Models                                                 │
│ Debaters   [ gemini-3.5-flash-lite — from Quick   ▾ ]  │
│ Evaluator  [ gemini-3.5-flash-lite — from Quick   ▾ ]  │
│ Both default from the fidelity you picked. Change them │
│ when the model is the variable you're testing — the    │
│ answer records what actually ran.                      │
│                                                        │
│ POV tag                                                │
│ [ existing InquiryTagPicker ]                          │
│                                                        │
│                     [ Reset to defaults ]   [ Done ]   │
└────────────────────────────────────────────────────────┘
```

- **Title:** "Options", as an `<h2>` that is the dialog's `aria-labelledby`. Section labels (Fidelity, Models, POV tag) use the existing small-caps label style (`.inquiry-mlab`).
- **Content:** move the existing markup as-is: the `inquiry-fid` radiogroup, both `inquiry-mrow` selects, `InquiryTagPicker` and `inquiry-mnote`. Don't restyle the cards. Reflow the three cards to one column in the bottom sheet.
- **Changes apply immediately.** Every change writes to the store as it does today, so the summary row and budget note are already correct when the dialog closes. There is no Cancel, because nothing here is destructive and every value is visible and changeable afterwards.
- **Done** (primary) closes the dialog. **×**, **Esc** and a click on the overlay also close it, keeping the changes.
- **Reset to defaults** (`.btn-ghost`) sets fidelity to Quick, clears both model overrides and clears the tag. It's disabled when everything is already at its default.

## Focus and keyboard

- Opening moves focus to the **selected fidelity card**.
- Focus is trapped inside the dialog while it's open, per the design system's modal rule.
- Closing returns focus to the **Options…** button.
- The fidelity cards already act as a radiogroup. While moving them, add **arrow-key navigation** (Left/Right and Up/Down move the selection) and a roving `tabIndex` (only the checked card has `tabIndex={0}`), so Tab moves past the group in one stop. Enter and Space keep working.

## Edge cases

- **First visit:** nothing changes for someone who never opens Options. The defaults run, and the summary tells them what those are.
- **Question prefilled from a chip:** the question field still gets focus on mount. Opening the dialog doesn't change the question.
- **Long model ids:** the summary truncates each value with an ellipsis at about 32 characters, with the full value in a `title`. The dialog shows the full names.
- **Error from a previous run:** the error line stays on the main screen, below Ask.

## Accessibility checklist

- Dialog: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` = the title. Focus trap, Esc closes, focus returns to the trigger.
- Options… button: `aria-haspopup="dialog"`, described by the summary text.
- Blocked-tag reason shown on the main screen and linked to Ask with `aria-describedby`.
- Contrast: the summary text (`--text-secondary` on the page background) and the blocked reason (`--warning`, which is already ≥4.5:1 on `--bg-secondary` in all four themes) must measure at least 4.5:1 in light, dark, bkc and harvard. Design measures this in the review pass.
- No `--focus-ring` as a text colour anywhere in this change.

## Acceptance criteria

1. The New question screen shows only the back button, heading, question field, the Options summary row, Ask with its budget note, and the error line.
2. Options… opens a modal (a bottom sheet on phone) containing the fidelity cards, both model pickers with their note, and the POV tag picker, unchanged in behaviour.
3. Changes apply immediately. The summary and budget note match the dialog after it closes. Reset to defaults restores Quick, the derived models and no tag.
4. A blocked tag disables Ask and shows its reason on the main screen.
5. Focus: it opens on the selected fidelity card, is trapped, Esc closes, and it returns to Options…. The fidelity cards support arrow keys with a roving tabIndex.
6. Tests cover: the summary text for default, overridden-model and tagged states; open/close and focus return; reset; the blocked-tag reason on the main screen.
7. Design `/design-review-workflow` pass (including contrast in all four themes) before Done.
