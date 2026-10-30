# Navigation location bar (Back / Forward / Recent / breadcrumb)

**Status:** approved by the PI (option B of the mockup), 2026-10-30. **Ticket:** t/4640 (AC4 and AC8).
**Supersedes:** the "Electron (no browser chrome)" controls section of the t/4640 spec, which put Back/Forward at the top of the left rail. The navigation *model* in t/4640 (places push, views replace, `NavHistory`, routes) is unchanged.
**Mockup:** [`mockups/navigation-location-bar.html`](mockups/navigation-location-bar.html). It's clickable, with options A/B/C and the as-built version for comparison. It uses hard-coded sample colours; this spec's tokens win.

## Why

As built (#4196), Back/Forward are two faint chevrons in their own empty column, about 99px wide, to the left of the rail (PI screenshot, 2026-10-30). The design has four problems:

- it wastes width on every screen;
- chevrons in a rail read as collapse/expand, not history;
- nothing says where you are, so Back has no visible meaning;
- you can only move one step at a time.

The location bar fixes all four, using the pattern people already know from browsers, VS Code, Finder and Explorer.

## Layout

```
┌──────┬──────────────────────────────────────────────────────────────┐
│ rail │ [←] [→] [▾]  ⊞ Taxonomy  ›  ● Safetyist  ›  AI must not erode… │  ← .nav-locbar (one row)
│      ├──────────────────────────────────────────────────────────────┤
│      │  tool content (unchanged)                                    │
```

- **Remove** `<NavController />` from its own column (`App.tsx`) and from the rail (PR #4215's approach). The rail goes back to what it was before #4196.
- **Add** one bar, `.nav-locbar`, as the **first child of the main content column**, to the right of the rail. It spans the content width and doesn't scroll with the content.
- **Main window only.** Don't render it in `#debate-window` / `#chat-window` / `#diagnostics-window`, or on the public pages (`/inquiries/:id`, `/share/*`). This matches t/4640#3 R8/R9.
- It shows on **every place**, including the Rosetta Stone landing, where Back is disabled at the start of a session. The bar never appears and disappears between tools, because a moving bar shifts content.

### Sizes and tokens

Root font is 18px, so use rem and em values.

| Part | Value |
|---|---|
| Bar height | `2.25rem` (desktop/tablet), `2.75rem` (`phone` breakpoint) |
| Bar padding | `0 0.5rem` |
| Bar background / border | `var(--bg-secondary)`, `border-bottom: 1px solid var(--border-color)` |
| Buttons (← → ▾) | `.btn-ghost` style: transparent, `color: var(--text-primary)`, `1.75rem` square (`2.75rem` at `phone` or `pointer: coarse`), radius 6px, hover `var(--bg-hover)`; ▾ is `1.25rem` wide |
| Icons | lucide `ArrowLeft`, `ArrowRight`, `ChevronDown`; `size="var(--icon-md)"` (▾ uses `--icon-sm`). **Not** chevrons for ← → |
| Gap | `0.125rem` between the buttons; `0.75rem` before the breadcrumb |
| Disabled | the design-system disabled style (`opacity: 0.35; filter: grayscale(40%)`), plus `disabled` and `aria-disabled="true"` |
| Breadcrumb text | `0.8rem`; ancestors `var(--text-secondary)`; the current (last) crumb `var(--text-primary)`, weight 600 |
| Separator | lucide `ChevronRight`, `--icon-sm`, `var(--text-secondary)`, `aria-hidden` |
| Tool icon (before the first crumb) | the same lucide icon as the rail item, `--icon-sm`, `var(--text-secondary)`, `aria-hidden` |
| Camp dot | `0.5rem` circle in `--color-acc` / `--color-saf` / `--color-skp`, before the camp name, `aria-hidden` (the name carries the meaning) |
| Focus | the global `button:focus-visible` rule. Don't override it |

Contrast: `--text-secondary` and `--text-primary` on `--bg-secondary` are AA in all four themes. **Don't** use `--text-muted` (fails in harvard and bkc) or `--focus-ring` for any text.

## Contents by build and breakpoint

| | Electron | Web | `phone` (<480px, either build) |
|---|---|---|---|
| ← Back | yes | yes | yes |
| → Forward | yes | **no** (the browser owns Forward) | no |
| ▾ Recent | yes | yes | no |
| Breadcrumb | full | full | **the current crumb only** |

A narrow Electron window follows the same breakpoint rule as the web build.

## Breadcrumb

The breadcrumb is derived from the current place. Extend `placeOf()`'s result with `crumbs: { text: string; camp?: 'acc' | 'saf' | 'skp' }[]` and `tool` (for the icon). The existing `label` stays: it's the short form used in tooltips and the Recent menu, which is the last crumb, prefixed with the tool name when they differ.

| Place | Crumbs |
|---|---|
| `/` | Rosetta Stone |
| `/chat`, `/chat/:id` | Chat · *chat title* |
| `/opeds`, `/opeds/:setId?pov=` | Op-Ed Studies · *set topic* · ● *Camp* |
| `/inquiry`, `/inquiry/:id` | Ask a Question · *question text* |
| `/debate`, `/debate/:id` | Debate · *debate topic* |
| `/taxonomy/:pov` | Taxonomy · ● *Camp* (or "Situations") |
| `/taxonomy/:pov?node=` | Taxonomy · ● *Camp* · *node label* |
| `/conflicts`, `?claim=` | Conflicts · *claim label* |
| `/cruxes`, `/summaries`, `/validation`, `/organizations` | the tab's name |

- **Human titles only.** Never show an id (`acc-desires-010`, a UUID). While an item's title is still loading, show just the tool crumb. When the title arrives, update the entry's label **without** adding a history step. A same-path label change is a `replace`, not a no-op, so the Recent menu and tooltips pick it up.
- **Truncation:** crumbs don't wrap.
  - The last crumb shrinks first (`min-width: 0; text-overflow: ellipsis`).
  - Middle crumbs cap at `12rem` with an ellipsis.
  - Every truncated crumb has its full text in `title`.
- **Crumbs are text, not links, in v1.** The in-page "‹ Op-Ed Studies" parent links stay as the way "up". Clickable crumbs are a later option; see Out of scope.
- **Markup:** `<nav aria-label="Breadcrumb"><ol>…</ol></nav>`, with `aria-current="location"` on the last `<li>`.

## Back / Forward

- They are wired to `NavHistory` (`back()`, `forward()`, `canGoBack()`, `canGoForward()`, `peekBack()`, `peekForward()`), exactly as #4196 is now.
- **Tooltip** (`title`) and **`aria-label`**:
  - with a destination: `Back to {peekBack().label}` / `Forward to {peekForward().label}`, with the label truncated at 60 characters and an ellipsis. The tooltip also gets the shortcut: ` (Alt+←)` / ` (Alt+→)`, or ` (⌘[)` / ` (⌘])` on macOS. The `aria-label` omits the shortcut and instead sets `aria-keyshortcuts="Alt+ArrowLeft"` etc.
  - with no destination, or a missing label: plain **"Back"** / **"Forward"**. Never "Back to Back".
- The buttons sit in `<div role="group" aria-label="History">` with ▾.

## ▾ Recent locations menu

- It's a button with `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Recent locations"`, and tooltip "Recent locations".
- It opens a popover anchored under the button, about `22rem` wide (capped at the viewport less 1rem), using the existing popover surface tokens (`--bg-primary`, `--border-color`, shadow).
- **Contents:** the history stack, **newest first**, at most 15 entries. Each row is:
  - the tool icon (`--icon-sm`, `--text-secondary`);
  - the entry's label, truncated with an ellipsis;
  - the tool name, right-aligned in `--text-secondary` at 0.75rem, when the label isn't already the tool name.
- **The current entry** is bold, has the suffix "· you are here" in `--text-secondary`, and carries `aria-current="page"`. Activating it just closes the menu.
- **Activating an entry** jumps straight there: `NavHistory` needs **`go(delta)`** (web: `history.go(delta)`; memory: a clamped index move plus restore). One jump is one navigation. It does not replay the steps in between.
- **Web:** list only the entries that have a label in the `sessionStorage` shadow array. If no other entry has a label, ▾ is disabled.
- **Keyboard:**
  - opening the menu focuses the current entry;
  - ↑/↓ move, Home/End jump to the ends, Enter/Space activate;
  - Esc closes and returns focus to ▾;
  - Tab closes the menu.
- **Mouse:** a click outside closes the menu.
- `role="menu"` on the list and `role="menuitem"` on the rows.

## Announcements

After a Back, Forward or Recent jump, focus stays on the control the user pressed, so the new page isn't otherwise announced. Add one visually hidden `aria-live="polite"` region in the bar, and set it to **"{label}"** after each history navigation. Don't set it for ordinary pushes.

## Phone

- The bar is `2.75rem` high, with ← and the current crumb only (single line, ellipsis).
- The touch target is `2.75rem` square.
- On the web build at phone width the browser's own Back is also available, which is fine.
- There's no Recent menu on phone in v1.

## Unchanged from t/4640

- **Push and replace:** push on a tool switch, opening an item, a cross-link, or a **user** node selection. Replace on an automatic node selection, a POV/camp tab switch, sort, filter, search or My/Community. The t/4640#12 items 4–6 still apply.
- **Shortcuts:** Alt+←/→ (⌘[ / ⌘] on macOS) and mouse buttons 4/5 are Electron-only; the browser handles them on the web. They're ignored in text fields.
- **No back-trapping;** the `beforeunload` guards stay.

## Acceptance criteria (replace t/4640 AC4; AC8 reviews against these)

1. There's no NavController column or rail block. The bar is the first row of the main content column, in the main window only, on every place.
2. Electron shows ← → ▾ and the breadcrumb. The web shows ← ▾ and the breadcrumb (no →). At `phone` width either build shows ← and the current crumb only.
3. The breadcrumb matches the table for every place, shows **no ids**, gets its title without adding a history step, and truncates with the full text in `title`.
4. Tooltips and `aria-label`s name the destination. With no destination they read plain "Back"/"Forward".
5. ▾ lists up to 15 entries, newest first, with the current one marked. Activating an entry is a single `go(delta)`. The menu's keyboard behaviour is as specified.
6. The live region announces the label after Back, Forward or a Recent jump.
7. Contrast meets AA for text and 3:1 for the icons in light, dark, bkc and harvard, measured after theme transitions settle. The focus ring is visible on all three buttons.
8. Tests:
   - `go(delta)` for both backends;
   - the Recent menu's ordering and current marker;
   - the breadcrumb for each route;
   - the tooltip with and without a destination;
   - the bar is absent in popout windows and on public pages.

## Out of scope (later)

- Clickable breadcrumb ancestors, which would retire the in-page "‹ Parent" links.
- Opening Recent by right-clicking or long-pressing ←.
- A Recent sheet on phone.
- Folding the toolbar-panel `previousView` into `NavHistory`.
