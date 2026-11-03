# Ask a Question: New question dialog with a collapsed Options area

**Status:** Spec, ready to implement (t/4666; folds in t/4667)
**Owner:** Design. **Builds it:** Rosetta Stone. **Reviews before Done:** Design.
**Requested by:** PI. t/4666 (via the PM): make "New question" a dialog, like New Chat and New Op-Ed. p/351#51: move the run settings into a separate Options area. TL direction on t/4667 and t/4666 (p/376#118, p/376#119).
**Components:** `components/inquiry/InquiryAskPanel.tsx` (becomes the dialog), `InquiryTab.tsx` (opens it), `InquiryTab.css`.

**Build order:** phase 1 is the dialog shell, with the current fields moved in unchanged. Phase 2 collapses the run settings into Options. Each phase ships and is reviewed on its own.

## Why

New question is the only create flow in the app that takes over the whole page. New Chat, New Op-Ed and New Debate all open a dialog over their library list. The page also shows every run setting at once (three fidelity cards, two model pickers, a POV tag picker and a note), although most people only type a question and press Ask with the defaults. The dialog makes Ask consistent with the other tools, and Options keeps the dialog to one field and one button for the common case.

## Phase 1: the dialog shell

### Entry points

| Trigger | Opens the dialog |
|---|---|
| "+ New Question" on the library page | Blank: the store is reset, as `onNew: reset` does today |
| A starter chip (`InquiryGettingStarted`) | Prefilled with the chip's question |

Mirror Chat's `useNewChatDialog` hook (`ChatTab.tsx`): local `show` and `prefill` state, so a stale prefill never leaks into a blank open. The library page stays rendered behind the dialog. **The full-page `ask` screen goes away:** remove it from `InquiryTab`'s screen switch, along with the "← My Questions" back button, since closing the dialog does that job now.

### Structure

Reuse the shell New Op-Ed and New Debate use:
- `.dialog-overlay` wrapping `.dialog .new-question-dialog`, with `role="dialog"`, `aria-modal`, and `aria-labelledby` pointing at the `<h2>` "New question".
- The focus trap from `NewDebateDialog.hooks.ts` (`useFocusTrap`), which New Op-Ed already mirrors. Don't write a fourth copy.
- Width and phone behaviour the same as `NewChatDialog`. The body scrolls; the heading and footer stay put.

```
┌ New question ─────────────────────────────────────────────┐
│ Research question                                          │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ What counts as an AI harm, and what would prove one?   │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ [phase 1: the fidelity cards, model pickers, POV tag and   │
│  note, moved in unchanged]                                 │
│ [phase 2: the collapsed Options area, below]               │
│                                                            │
│ ⚠ error line, when there is one (role="alert")             │
├────────────────────────────────────────────────────────────┤
│ Budget: 120 API calls              [ Cancel ]  [ Ask ]     │
└────────────────────────────────────────────────────────────┘
```

- **Question field:** focused on open, with the cursor at the end (the t/4562 rule moves with it). The label stays "Research question".
- **Footer (`.dialog-actions`):** the budget on the left in `--text-secondary` (`Budget: {n} API calls`; the "You'll see it deplete as it goes" clause moves to the Running screen, where the depletion actually shows), then Cancel (`.btn`) and Ask (`.btn btn-primary`) on the right. The primary label is **"Ask"** (verb-first like "Start Chat"), and it reads "Starting…" while starting.

### Behaviour

- **Ask:** starts the inquiry. Once it has a job id, the dialog closes and the Running screen shows, as today.
- **Start failure:** the dialog **stays open** with the error in its own `role="alert"` line, and the question and settings stay as entered, so the user can retry. Don't drop them back on the list with the error outside the dialog.
- **Cancel, Esc and overlay click** close the dialog, except while starting. Then all three are inert, as New Op-Ed does while `creating`.
- **Focus on close** returns to the trigger: the "+ New Question" button, or the chip that opened it.
- **Disabled Ask:** disabled while the question is empty or a tag blocks the run. The reason is shown (phase 2 covers the tag case), never only implied.

## Phase 2: the collapsed Options area

### Pattern, and how it lines up with New Debate

Inside the dialog body, under the question, the run settings collapse into **one inline disclosure using the t/4639 accordion** (`LibraryGettingStarted`): a full-width toggle `<button aria-expanded aria-controls>` with a chevron, and a body that uses `hidden`.

**Aligned with New Debate's settings pattern:**
- The defaults run without opening anything, and the extra settings sit behind one control. That's New Debate's "Advanced settings".
- When any setting differs from its default, the toggle shows a **change badge** like New Debate's, with `aria-label="{n} setting(s) changed"`. The defaults are **the store's default fidelity (`'standard'`, `useInquiryStore`)**, both models derived from the fidelity, and no tag. Compare against the store's exported default, not a hard-coded value. (Corrected in t/4666#13: this line first said Quick.)
- **Badge colours:** an inverse pill, `background: var(--text-primary); color: var(--bg-primary)` (12.76:1 or better in all four themes). Don't copy `.ndd-change-badge`'s white on `--focus-ring`, which fails AA in light (3.68) and dark (2.54).

**Where Ask differs, and why:** New Debate opens a second modal (`DebateSettingsDialog`, with five sections, Apply and presets). Ask keeps its settings inline because:
1. **That would put a modal on top of a modal.** Ask is now a dialog itself.
2. **Ask has four controls and no presets.** Sections, Apply and presets would outweigh the content.
3. **The budget in the footer has to follow the fidelity live.** Inline, the user changes a card and sees the budget change beside Ask.

### The toggle

```
┌──────────────────────────────────────────────────────────┐
│ Options ②  · Standard · claude-sonnet-5 · Untagged    ▾  │
└──────────────────────────────────────────────────────────┘
```

- `Options` uses the t/4639 title style (600, `--text-primary`). It's followed by the badge when something has changed, then the summary in `--text-secondary`: `· {Fidelity} · {model} · {tag}`.
  - `{model}` is the debater model. When the evaluator differs, show `Debaters {a} · Evaluator {b}`.
  - `{tag}` is the tag's label, plus `(prioritize)` in prioritize mode, or `Untagged`.
  - Each value truncates with an ellipsis at about 32 characters, with the full text in `title`.
- **The summary stays when expanded,** and the chevron flips. The whole button text is the accessible name, so screen-reader users hear the settings without opening it.
- `font: inherit`; `min-height: 44px` collapsed and at least 24px expanded (both from t/4639#4).

### The body

Move in unchanged: the `inquiry-fid` radiogroup, both `inquiry-mrow` selects, `InquiryTagPicker` and `inquiry-mnote`. Changes write to the store immediately; there's no Apply, unlike New Debate. The summary, the badge and the footer budget update live.

- **Collapsed by default** every time the dialog opens. Don't persist the open state.
- **Fidelity radiogroup:** add arrow-key navigation (Left/Right and Up/Down change the selection) and a roving `tabIndex`, so Tab passes the group in one stop.

### Blocked tag

When `inquiryTagBlocked(tagSelection)` returns a reason:
- Options **expands automatically**;
- the summary's tag segment becomes `POV tag: {reason}` in `--warning`;
- Ask is disabled with that reason in its `aria-describedby`.

## Accessibility checklist (both phases)

- Dialog: `role="dialog"`, `aria-modal`, `aria-labelledby`; focus trapped; Esc closes unless starting; focus returns to the trigger.
- Initial focus goes to the question field. Tab order: question → Options toggle → (expanded) fidelity → Debaters → Evaluator → tag → Cancel → Ask.
- Errors and the blocked reason are announced (`role="alert"` or `aria-describedby`), never colour-only.
- Contrast at least 4.5:1 in light, dark, bkc and harvard for the footer budget, the summary, the badge text and the `--warning` reason. Design measures these in review.
- No `--focus-ring` as a text colour. Use it only for `:focus-visible` outlines.

## Acceptance criteria

**Phase 1, dialog shell**
1. "+ New Question" opens a blank New question dialog over the library page. A starter chip opens it prefilled. The full-page Ask screen and its back button are gone.
2. The shell matches New Op-Ed and New Debate: overlay, `role="dialog"`, `aria-modal`, `aria-labelledby`, and the shared `useFocusTrap`. Initial focus goes to the question with the cursor at the end.
3. Footer: the budget on the left; Cancel and Ask on the right; "Starting…" while starting.
4. Ask closes the dialog and shows Running once a job id arrives. A start failure keeps the dialog open with the error and the inputs intact.
5. Esc, overlay and Cancel close the dialog except while starting, and focus returns to the trigger.
6. Tests: blank vs prefilled open; close paths, including inert while starting; failure keeps the dialog open; focus return.

**Phase 2, Options**
7. The settings sit in a collapsed t/4639 disclosure inside the dialog. The toggle shows `Options · {fidelity} · {model} · {tag}` in both states, plus the change badge when anything differs from the defaults.
8. Changes apply live to the summary, the badge and the footer budget.
9. A blocked tag auto-expands Options, shows its reason on the toggle and disables Ask with that reason described.
10. Arrow keys and a roving tabIndex on the fidelity cards.
11. Tests: summary text (default, overridden model, differing evaluator, tagged); badge count; toggle `aria-expanded` and `hidden`; blocked-tag auto-expand; arrow keys.

**Both phases:** a Design `/design-review-workflow` pass, including contrast in all four themes, before each phase is Done.
