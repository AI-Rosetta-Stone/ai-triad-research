# Navigation location bar (Back / Forward / Recent / breadcrumb / ⧉)

**Status:**
- approved by the PI (option B of the mockup), 2026-10-30;
- **amended for t/4685 option C** (PI, 2026-10-30; t/4686).

**Tickets:**
- t/4640 (AC4 and AC8);
- t/4685, with children t/4689 (shell), t/4690 (Chat) and t/4691 (Debate).

**Supersedes:** the "Electron (no browser chrome)" controls section of the t/4640 spec, which put Back/Forward at the top of the left rail. The navigation *model* in t/4640 (places push, views replace, `NavHistory`, routes) is unchanged.

**Option C, in one line:** items in every tool open **in place** as t/4640 places. The **first breadcrumb is the one way up** to the collection. **⧉** opens an item in a separate window when the user wants side-by-side.

**Mockup:** [`mockups/navigation-location-bar.html`](mockups/navigation-location-bar.html). It's clickable, with options A/B/C and the as-built version for comparison.
- It predates option C, so its crumbs aren't links and it has no ⧉. The ASCII sketches below are the reference for those.
- It uses hard-coded sample colours; this spec's tokens win.

## Why

As built (#4196), Back/Forward are two faint chevrons in their own empty column, about 99px wide, to the left of the rail (PI screenshot, 2026-10-30). The design has four problems:

- it wastes width on every screen;
- chevrons in a rail read as collapse/expand, not history;
- nothing says where you are, so Back has no visible meaning;
- you can only move one step at a time.

The location bar fixes all four, using the pattern people already know from browsers, VS Code, Finder and Explorer.

There was a second inconsistency (t/4685):
- Chat and Debate opened items in pop-ups;
- Op-Eds and Ask a Question opened them in place, each with a different way back ("‹ Op-Ed Studies" at the top left, "My Questions" at the bottom right).

Option C gives every tool the same model as Taxonomy's single window, and makes the breadcrumb the one way up.

## Layout

```
Taxonomy (or any collection):
┌──────┬──────────────────────────────────────────────────────────────┐
│ rail │ [←] [→] [▾]  ⊞ Taxonomy  ›  ● Safetyist  ›  AI must not erode… │  ← .nav-locbar (one row)
│      ├──────────────────────────────────────────────────────────────┤
│      │  tool content (unchanged)                                    │

An item, opened in place:
┌──────┬──────────────────────────────────────────────────────────────┐
│ rail │ [←] [→] [▾]  🗨 Debate  ›  Should frontier AI development… [⧉] │
│      ├──────────────────────────────────────────────────────────────┤
│  ◉   │  debate transcript                                           │
          └─ link: up to the Debate collection        ⧉ = open in a new window or tab
  ◉ = the rail's "running" dot on another tool (see Running work)
```

- **Remove** `<NavController />` from its own column (`App.tsx`) and from the rail (PR #4215's approach). The rail goes back to what it was before #4196, apart from the running dot.
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
| Buttons (← → ▾ ⧉) | `.btn-ghost` style: transparent, `color: var(--text-primary)`, `1.75rem` square (`2.75rem` at `phone` or `pointer: coarse`), radius 6px, hover `var(--bg-hover)`; ▾ is `1.25rem` wide |
| Icons | lucide `ArrowLeft`, `ArrowRight`, `ChevronDown`, `ExternalLink` (⧉); `size="var(--icon-md)"` (▾ uses `--icon-sm`). **Not** chevrons for ← → |
| Gap | `0.125rem` between the buttons; `0.75rem` before the breadcrumb; ⧉ pushed to the right end (`margin-left: auto`) |
| Disabled | the design-system disabled style (`opacity: 0.35; filter: grayscale(40%)`), plus `disabled` and `aria-disabled="true"` |
| Breadcrumb text | `0.8rem`; ancestors `var(--text-secondary)`; the current (last) crumb `var(--text-primary)`, weight 600 |
| Separator | lucide `ChevronRight`, `--icon-sm`, `var(--text-secondary)`, `aria-hidden` |
| Tool icon (before the first crumb) | the same lucide icon as the rail item, `--icon-sm`, `var(--text-secondary)`, `aria-hidden` |
| Camp dot | `0.5rem` circle in `--color-acc` / `--color-saf` / `--color-skp`, before the camp name, `aria-hidden` (the name carries the meaning) |
| Focus | the global `:focus-visible` rule. Don't override it |

Contrast: `--text-secondary` and `--text-primary` on `--bg-secondary` are AA in all four themes. **Don't** use `--text-muted` (fails in harvard and bkc) or `--focus-ring` for any text or badge.

## Contents by build and breakpoint

| | Electron | Web | `phone` (<480px, either build) |
|---|---|---|---|
| ← Back | yes | yes | yes (and acts as up; see below) |
| → Forward | yes | **no** (the browser owns Forward) | no |
| ▾ Recent | yes | yes | no |
| Breadcrumb | full, ancestors are links | full, ancestors are links | **the current crumb only** |
| ⧉ Open in new window/tab | Chat and Debate items (the existing window types) | items in all four tools | no |

A narrow Electron window follows the same breakpoint rule as the web build.

## Breadcrumb

The breadcrumb is derived from the current place. Extend `placeOf()`'s result with:
- `crumbs: { text: string; camp?: 'acc' | 'saf' | 'skp'; href?: string }[]`;
- `tool`, for the icon.

The existing `label` stays: it's the short form used in tooltips and the Recent menu, which is the last crumb, prefixed with the tool name when they differ.

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
- **Markup:** `<nav aria-label="Breadcrumb"><ol>…</ol></nav>`, with `aria-current="location"` on the last `<li>`. Linked ancestors are `<a href>`s (next section).

## Clickable breadcrumb: the one way up

**Rule:** an ancestor crumb is a link **only when it leads to a different place**. The current crumb is never a link.

| Place | Linked ancestor → target |
|---|---|
| `/chat/:id`, `/debate/:id`, `/inquiry/:id` | the tool crumb → its collection (`/chat`, `/debate`, `/inquiry`) |
| `/opeds/:setId?pov=` | "Op-Ed Studies" → `/opeds`. The topic crumb is **not** a link, because the set is the current place and the camp is a view of it |
| `/taxonomy/:pov?node=` | the camp crumb → `/taxonomy/:pov` (same camp, no node). "Taxonomy" is **not** a link: Taxonomy has no collection |
| `/conflicts?claim=` | "Conflicts" → `/conflicts` |
| collections and single-crumb places | none |

- **Up pushes** the target place, following t/4640's rule that a parent link means up, not back. So Back afterwards returns to the item.
- **Return to the view the user left:** the collection reopens on the **My/Community tab it was last on in this session**, with search and sort as left, and scroll restored where `useRestorableScroll` covers it. The tab is a view of the collection place: keep it in the store or a query param, never as its own history step.
- **Activation:**
  - a plain click navigates in place: `preventDefault`, then a `NavHistory` push, never a full page load;
  - on web, **Ctrl/⌘-click and middle-click** keep the browser's default, a new tab;
  - in Electron they do nothing extra, because collections have no window type.
- **Style:**
  - the link is `var(--text-secondary)`;
  - hover: `var(--text-primary)` and underlined;
  - the focus ring is the global `:focus-visible` style;
  - pad the link to a hit area at least `1.5rem` high.

  Non-link ancestors have no hover or pointer cursor.
- **Name:** the link text is the tool name, exactly as on the rail, plus `title="Up to {tool}"`. No extra `aria-label` is needed, because the `Breadcrumb` landmark gives the context.

### Phone "up"
At phone width only the current crumb shows, so ← does double duty:
- When `canGoBack()` is **false** (a deep link or the first entry) **and** the current place has a linked ancestor, ← acts as **up**: it's enabled, labelled **"Up to {tool}"**, and pushes the collection place.
- Otherwise ← is plain Back.

When the user opened an item from its list, Back and up land in the same place anyway.

## ⧉ Open in new window

- **Where:** the right end of the bar, **only on an item place**: `/chat/:id`, `/debate/:id`, `/opeds/:setId` or `/inquiry/:id`. It isn't shown on collections, Taxonomy, Conflicts or the landing page.
- **Name:** `aria-label` and `title` are **"Open in new window"** (Electron) or **"Open in new tab"** (web).
- **Builds:**
  - **Electron:** shown for **Chat and Debate**, which reuse the existing `#chat-window` / `#debate-window` windows. **Hidden** for Op-Eds and Ask a Question, which have no window type (deferred).
  - **Web:** shown for all four. It opens the item's own URL in a new tab.
  - **Phone:** hidden.
- **Already open:** in Electron, if the item is already open in a separate window, ⧉ **focuses that window** instead of opening a duplicate. Web can't detect another tab, so it always opens a new one.
- **The main window:**
  - it **stays on the item**, and no history step is added;
  - separate windows have **no location bar** and aren't in `NavHistory` (t/4640#3 R8). The window title is the item's title.
- **Rows:** Ctrl/⌘-click or middle-click on a **row** in a collection list does the same as ⧉ for that item.
  - On web, rows are `<a href>`s, so this is the browser default.
  - In Electron, intercept it and call the same open-in-window helper. This applies to Chat and Debate rows only; for other tools it's a plain open.

## Running work

**Precondition (t/4687, t/4688):** a chat or debate that is still generating keeps running in its store when the user leaves its view. While it runs elsewhere, the user must be able to see that and get back to it.

A run "elsewhere" means it's in the main window and its item isn't the current place. Runs inside a ⧉ window are visible there and are ignored here.

- **Rail dot:**
  - on the tool's rail item, a `0.5rem` dot at the icon's top-right, filled `var(--text-primary)` with a `2px` ring in the rail's background colour;
  - **static**, with no pulsing;
  - the rail item's accessible name becomes **"Debate, 1 running"** / **"Chat, 2 running"**;
  - it shows only while at least one run of that tool is elsewhere.
- **▾ Recent:**
  - a running entry shows **"Running…"** in `var(--text-secondary)` in place of the tool-name column;
  - append ", running" to its accessible name.
- **Finished toast:**
  - when a run elsewhere ends, show the existing toast with one action **"Open"**, which pushes the item place;
  - success copy: **"Debate finished: {label}"** / **"Chat reply ready: {label}"**;
  - failure copy: **"Debate stopped: {label}"** / **"Chat reply failed: {label}"**;
  - it uses `role="status"`, auto-dismisses after 8s, and pauses on hover or focus;
  - it's never shown when the item is the current place.
- **Leaving the app:** the existing `beforeunload` guard for running work is unchanged.

## First-open hint

- **When:** the first time a user opens a **Chat** or **Debate** item in place after t/4690 / t/4691 ship. It's shown once per tool, per user.
  - Web: a `localStorage` flag per tool, wrapped in try/catch; if storage fails, don't show the hint.
  - Electron: user settings.
- **What:** a small non-modal callout anchored under ⧉, pointing at it. Copy:

  > **Opens here now.** Use ⧉ to open it in a separate window.

  On web the end of the copy is "…in a new tab." It has one text button, **"Got it"**.
- **Behaviour:**
  - it doesn't take focus; announce it with `role="status"`;
  - dismiss on "Got it", Esc, or the first navigation away;
  - it's never shown again for that tool;
  - it's never shown at phone width, where ⧉ is hidden and phones already open in place.
- **Op-Eds and Ask a Question:** no hint, because their open behaviour doesn't change.

## Retired controls

The up crumb replaces these per-tool return controls. Remove them:
- **Op-Ed Studies:** the "‹ Op-Ed Studies" link at the top left of an open set.
- **Ask a Question:** "My Questions" at the bottom right of an open question.
- **Chat and Debate (phone):** the item-header "back to list" buttons in the phone `has-selection` layout (`ChatTab.tsx`, `DebateTab.tsx`). The bar's ← takes over, with the phone up rule. Do this as part of t/4690 / t/4691.

Keep `PhoneToolClose`. It closes the tool, not the item.

## Interim: Chat and Debate stay pop-ups until verified (TL condition, t/4685#2)

Until t/4687 (Chat) and t/4688 (Debate) confirm that running work survives leaving the view, a desktop row click in those tools keeps opening a pop-up.

The shell work (t/4689) ships without waiting:
- the bar;
- clickable crumbs;
- ⧉ for Op-Eds and Questions on web;
- the running signals;
- the retired Op-Ed and Question controls.

The in-place switch for Chat and Debate (t/4690, t/4691) brings their ⧉ in Electron and the first-open hint.

## Back / Forward

- They are wired to `NavHistory` (`back()`, `forward()`, `canGoBack()`, `canGoForward()`, `peekBack()`, `peekForward()`), exactly as #4196 is now.
- **Tooltip** (`title`) and **`aria-label`**:
  - with a destination: `Back to {peekBack().label}` / `Forward to {peekForward().label}`, with the label truncated at 60 characters and an ellipsis. The tooltip also gets the shortcut: ` (Alt+←)` / ` (Alt+→)`, or ` (⌘[)` / ` (⌘])` on macOS. The `aria-label` omits the shortcut and instead sets `aria-keyshortcuts="Alt+ArrowLeft"` etc.
  - with no destination, or a missing label: plain **"Back"** / **"Forward"**. Never "Back to Back". The phone up case reads "Up to {tool}".
- The buttons sit in `<div role="group" aria-label="History">` with ▾.

## ▾ Recent locations menu

- It's a button with `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Recent locations"`, and tooltip "Recent locations".
- It opens a popover anchored under the button, about `22rem` wide (capped at the viewport less 1rem), using the existing popover surface tokens (`--bg-primary`, `--border-color`, shadow).
- **Contents:** the history stack, **newest first**, at most 15 entries. Each row is:
  - the tool icon (`--icon-sm`, `--text-secondary`);
  - the entry's label, truncated with an ellipsis;
  - the tool name, right-aligned in `--text-secondary` at 0.75rem, when the label isn't already the tool name. A running entry shows "Running…" here instead.
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

After a Back, Forward, Recent or up navigation, focus stays on the control the user pressed, so the new page isn't otherwise announced. Add one visually hidden `aria-live="polite"` region in the bar, and set it to **"{label}"** after each of these. Don't set it for ordinary pushes.

## Phone

- The bar is `2.75rem` high, with ← and the current crumb only (single line, ellipsis).
- The touch target is `2.75rem` square.
- ← acts as up when there's nothing to go back to (see Phone "up").
- On the web build at phone width the browser's own Back is also available, which is fine.
- There's no Recent menu, ⧉ or first-open hint on phone.

## Unchanged from t/4640

- **Push and replace:** push on a tool switch, opening an item, a cross-link, or a **user** node selection. Replace on an automatic node selection, a POV/camp tab switch, sort, filter, search or My/Community. The t/4640#12 items 4–6 still apply.
- **Shortcuts:** Alt+←/→ (⌘[ / ⌘] on macOS) and mouse buttons 4/5 are Electron-only; the browser handles them on the web. They're ignored in text fields.
- **No back-trapping;** the `beforeunload` guards stay.

## Acceptance criteria

**Location bar** (replaces t/4640 AC4; t/4640 AC8 reviews against these):

1. There's no NavController column or rail block. The bar is the first row of the main content column, in the main window only, on every place.
2. Electron shows ← → ▾ and the breadcrumb. The web shows ← ▾ and the breadcrumb (no →). At `phone` width either build shows ← and the current crumb only.
3. The breadcrumb matches the table for every place, shows **no ids**, gets its title without adding a history step, and truncates with the full text in `title`.
4. Tooltips and `aria-label`s name the destination. With no destination they read plain "Back"/"Forward".
5. ▾ lists up to 15 entries, newest first, with the current one marked. Activating an entry is a single `go(delta)`. The menu's keyboard behaviour is as specified.
6. The live region announces the label after Back, Forward, Recent or up.
7. Contrast meets AA for text and 3:1 for the icons in light, dark, bkc and harvard, measured after theme transitions settle. The focus ring is visible on every button and crumb link.
8. Tests:
   - `go(delta)` for both backends;
   - the Recent menu's ordering and current marker;
   - the breadcrumb for each route;
   - the tooltip with and without a destination;
   - the bar is absent in popout windows and on public pages.

**Option C** (t/4689 shell; t/4690 / t/4691 per tool; Design reviews each):

9. Linked ancestors match the "Clickable breadcrumb" table. Clicking one pushes the collection place and restores its last My/Community tab. Back then returns to the item. The phone up rule works from a deep link.
10. ⧉ appears only on item places, in the builds listed. In Electron it focuses an already-open window instead of duplicating it. It doesn't change the main window or its history. Ctrl/⌘-click and middle-click on rows do the same.
11. The running dot, its accessible name, the Recent "Running…" entry and the finished/stopped toast behave as specified, and are never shown for the current place or for runs in ⧉ windows.
12. The first-open hint shows once per tool for Chat and Debate only, is not modal, and never appears at phone width.
13. "‹ Op-Ed Studies" and "My Questions" are gone, along with the phone back-to-list buttons for Chat and Debate once t/4690 and t/4691 land. No tool has a second way up.

## Out of scope (later)

- Electron windows for Op-Ed and Ask a Question items (⧉ is hidden there in Electron until then).
- Opening Recent by right-clicking or long-pressing ←.
- A Recent sheet on phone.
- Folding the toolbar-panel `previousView` into `NavHistory`.
