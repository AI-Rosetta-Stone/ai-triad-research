# Design System — Taxonomy Editor

**Author:** Design (Orca)
**Status:** Living document — update as patterns evolve

## Themes

Five themes via `[data-theme="xxx"]` on `<html>`. Default: `harvard`.

| Theme | Token | Audience |
|---|---|---|
| Light | `light` | General use, high contrast |
| Dark | `dark` | Low-light environments |
| BKC | `bkc` | Berkman Klein Center branding |
| Harvard | `harvard` | Harvard library aesthetic (default) |
| System | `system` | Follows OS preference (resolves to light or dark) |

Managed in `settingsSlice.ts`. Type: `ColorScheme = 'light' | 'dark' | 'bkc' | 'harvard' | 'system'`. Stored in `localStorage` as `taxonomy-editor-theme`.

## Color Tokens

All colors are CSS custom properties on `:root` scoped by `data-theme`.

### POV Colors

| Token | Light | Dark | BKC | Harvard | Usage |
|---|---|---|---|---|---|
| `--color-acc` | #b84e13 | #e89450 | #cc7e45 | #a35012 | Accelerationist (orange/rust) |
| `--color-saf` | #2b5fad | #7da3d6 | #6d94c2 | #275498 | Safetyist (blue) |
| `--color-skp` | #7b4fa6 | #a888c8 | #a882be | #6d4595 | Skeptic (purple) |
| `--color-sit` | #7c3aed | #9b59b6 | #09465b | #5B2C87 | Situations |
| `--color-conflicts` | #64748b | #95a5a6 | #7a6a82 | #6B705C | Conflicts |

**Source of truth:** POV values above are transcribed from `taxonomy-editor/src/renderer/styles.css` (`:root` = light, then `[data-theme="dark"|"bkc"|"harvard"]`). The POV palette was revamped from the original green/red/gold to orange/blue/purple; this table was corrected to match on 2026-08-08 (t/2293 review, verified live + against source). If you change a POV token, update this row in the same PR.

### BDI Category Colors

| Token | Usage |
|---|---|
| `--cat-desires` | Desires category accent |
| `--cat-beliefs` | Beliefs category accent |
| `--cat-intentions` | Intentions category accent |

### Surfaces

| Token | Usage |
|---|---|
| `--bg-primary` | Main content background |
| `--bg-secondary` | Alternate rows, subtle sections |
| `--bg-tertiary` | Neutral chip/inset surface, one step past `--bg-secondary` toward `--border-color` (midpoint: light #edf1f6, dark #2b3544, bkc #3b2d3c, harvard #e5e0d8; ~40 sites; defined t/2261, e/70 Finding 3) |
| `--bg-panel` | Panel backgrounds, dividers |
| `--bg-input` | Input field backgrounds |
| `--bg-hover` | Hover states |

### Text

| Token | Usage |
|---|---|
| `--text-primary` | Body text, headings |
| `--text-secondary` | Supporting text, labels |
| `--text-muted` | Deemphasized text, placeholders |
| `--border-color` | Borders, dividers |

### Semantic

| Token | Usage |
|---|---|
| `--danger` | Destructive actions, errors (#ef4444 / #C53B4A) |
| `--success` | **Fill** color — button/badge/checkmark backgrounds (#22c55e / #2D6A4F). Do NOT use as text on `--bg-primary`: ~1.8:1 in light, fails AA. Use `--success-text` for foreground green. |
| `--success-text` | **Foreground** success green — AA-safe as text on `--bg-primary` per theme (light #15803d ~5:1; dark #22c55e; bkc #00ff4c; harvard #2D6A4F). Only light needed a new value; dark/bkc reuse their bright fill (dark bg), harvard its forest green. Mirrors the `--warning` per-theme precedent. Added t/2260 (e/70 Finding 2). |
| `--warning` | Flag verdicts, mid-range score bands (light #a16207, dark #f59e0b, bkc #d9a441, harvard #8B6508 — all ≥4.5:1 vs `--bg-secondary`; added t/1386) |
| `--focus-ring` | Focus indicators (#3b82f6 / #A51C30) |

### Detail Backgrounds

Category-tinted backgrounds for detail panels: `--bg-detail-desires`, `--bg-detail-beliefs`, `--bg-detail-intentions`.

## Typography

### Font Stacks

| Use | Stack |
|---|---|
| Body | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` |
| Monospace | `'Cascadia Code', 'Fira Code', Consolas, monospace` |
| Headlines | `Georgia, 'Times New Roman', serif` (node detail headers only) |

### Font Sizes

Use `rem` units. Common sizes in order of frequency:

| Size | Typical use |
|---|---|
| `0.72rem` | Badges, fine print, secondary metadata |
| `0.75rem` | Button labels (sm), muted annotations |
| `0.78rem` | Category headers, section labels |
| `0.8rem` | Default body text, table cells, buttons |
| `0.85rem` | Help dialog text, descriptions |
| `0.9rem` | Node detail headline |
| `1.1rem` | Section headings |

### Font Weights

| Weight | Use |
|---|---|
| 400 | Body text |
| 500 | Emphasized text |
| 600 | Labels, headers, button text |
| 700 | Strong emphasis, headings |

## Spacing

No formal spacing scale — values are applied contextually. Common values:

| Range | Values | Use |
|---|---|---|
| Micro | 2px, 3px, 4px | Gaps between tightly packed elements, badge padding |
| Small | 6px, 8px | Component internal padding, icon gaps |
| Base | 10px, 12px | Standard padding, form element padding |
| Medium | 16px, 20px | Section padding, card padding |
| Large | 24px, 32px | Dialog padding, major section gaps |

## Breakpoints

Defined in `useBreakpoint.ts`. CSS media queries and JS hook.

| Name | Range | Layout |
|---|---|---|
| `phone` | 0–479px | Single column, push navigation |
| `phone-lg` | 480–767px | Single column, wider cards |
| `tablet` | 768–1023px | Two column (list + detail) |
| `tablet-lg` | 1024–1199px | Near-desktop, narrower panes |
| `desktop` | 1200px+ | Full multi-pane layout |

Set `data-breakpoint` on `<html>` (mirrors `data-theme` pattern).

Additional queries: `(pointer: coarse)` for touch devices, `(prefers-reduced-motion: reduce)` for animation.

## Buttons

| Class | Background | Color | Padding | Font Size |
|---|---|---|---|---|
| `.btn` | `var(--bg-panel)` | `var(--text-primary)` | `6px 14px` | `0.8rem` |
| `.btn-primary` | `var(--success)` | `#fff` | inherited | inherited |
| `.btn-danger` | `var(--danger)` | `#fff` | inherited | inherited |
| `.btn-ghost` | transparent | `var(--text-secondary)` | inherited | inherited |
| `.btn-sm` | inherited | inherited | `4px 10px` | `0.75rem` |
| `.btn-refine` | `#7c3aed` | `#fff` | inherited | inherited |

**States:** Hover uses `var(--bg-hover)`. Disabled: `opacity: 0.35; filter: grayscale(40%)`.

## Component Patterns

### Modal Dialog

Full-screen `.dialog-overlay` backdrop + centered `.dialog` card. Click overlay to close (with `stopPropagation` on dialog). Used by: SettingsDialog, HelpDialog, FirstRunDialog, DeleteConfirmDialog.

### Toast Notification

Fixed position, bottom-right. Auto-dismiss (typically 4–8 seconds). Max stack of 4. Slide-in animation. Used for: save confirmations, collaboration updates, precache status.

### Dismissible Banner

Full-width bar above content. Colored left border or background tint. Optional dismiss button. Used for: anonymous warning, data updates, validation errors, resilience status, background loading.

### Popover / Dropdown

Absolute-positioned relative to trigger element. Click-outside to close. Used for: toolbar menus, auth popover, search dropdown, typeahead, comment creation, feedback widget.

### Collapsible Section

Two patterns:
1. **HTML `<details>`/`<summary>`** — native, used for simple accordions
2. **Custom toggle** — button with `aria-expanded`, used for category groups, pane collapse

### Inline Confirmation

Replaces the triggering element's content with a Cancel/Confirm choice. No modal. Used for: row-level delete, destructive actions within a list. Returns to normal state on Cancel or Escape.

### Bottom Sheet (mobile)

Full-width panel sliding up from bottom of viewport. Semi-transparent backdrop. Touch-dismiss via swipe-down. Replaces popovers on phone viewports. Used for: feedback widget, confirmation dialogs on mobile.

## Icons

The app uses **[lucide-react](https://lucide.dev)** for UI/nav/toolbar glyphs, plus hand-authored inline SVGs for domain glyphs (camp glyphs, the TheoryLink book, status dots). Stroke-based: `stroke="currentColor"`, `strokeWidth="2"`, `strokeLinecap="round"`; color inherits via `currentColor`.

**Sizing is em-based so icons track adjacent text and the zoom control (t/2416).** Tokens on `:root`:

| Token | value | use (former px) |
|---|---|---|
| `--icon-sm` | `1em` | inline-with-text glyphs (~14px) |
| `--icon-md` | `1.25em` | default UI / nav / toolbar (~18–20px) |
| `--icon-lg` | `1.5em` | emphasis (~22px) |

lucide call sites pass the em value to `size` (e.g. `size="1.25em"`). Components with a numeric `size` prop (`TheoryLink`, `CampGlyph`, `OrgLogo`) keep the numeric API but render `${size/16}em` internally, so they scale too. Raster favicons (org logos, app favicon) stay fixed-px. Base root font-size is **112.5% (18px)**; the zoom control multiplies against it (see `App.tsx`).

Unicode symbols used for lightweight indicators: `▸`/`▾` (collapse arrows), `✕` (close/reject), `●` (colored dots for strength/confidence).

## Node Detail Tabs

Current tab set (from `NodeDetail.tsx`). Simple view shows only Content and Related; the rest are Advanced-only. Content is renamed **Analysis** by the node detail redesign (t/4574, pending; see `node-detail-redesign.md`).

| ID | Label | Notes |
|---|---|---|
| `content` | Content | Default. Label + description editing |
| `related` | Related | Edge browser |
| `attributes` | Attributes | Graph attributes panel |
| `conflicts` | Conflicts | Conflicts involving the node; count in the label |
| `cruxes` | Cruxes | Cruxes involving the node; count in the label |
| `phrases` | Phrases | Synthetic phrases |
| `sources` | Sources | Source documents |
| `facts` | Facts | Extracted facts with viewer |
| `research` | Research | Generated research prompt |
| `history` | History | Edit history timeline |

## Situation Detail Tabs

Current tab set (from `SituationDetail.tsx`):

| ID | Label | Color |
|---|---|---|
| `overview` | Overview | default |
| `attributes` | Attributes | default |
| `accelerationist` | Accelerationist | `--color-acc` |
| `safetyist` | Safetyist | `--color-saf` |
| `skeptic` | Skeptic | `--color-skp` |
| `debate` | Debate | `--color-sit` |
| `sources` | Sources | default |
| `research` | Research | default |

## Help Dialog Tabs

| ID | Label |
|---|---|
| `about` | About |
| `changelog` | What's New |
| `overview` | Overview |
| `documentation` | Documentation |
| `methods` | Methods |
| `shortcuts` | Shortcuts |
| `sbom` | SBOM |
| `licenses` | Licenses |
| `my-cases` | My Cases (web build only) |

The Welcome Tour tab is retired. Its content moved to the Rosetta Stone home page (see `onboarding.md`).

## LocalStorage Keys

Prefix: `taxonomy-editor-`. Common keys:

| Key | Purpose |
|---|---|
| `taxonomy-editor-theme` | Color scheme |
| `taxonomy-editor-ai-backend` | Selected AI backend |
| `taxonomy-editor-gemini-model` | Selected model |
| `taxonomy-editor-pane-spacing` | Normal / Concise |
| `taxonomy-editor-qbaf` | QBAF toggle |
| `taxonomy-editor-onboarding-dismissed` | Onboarding tour seen |
| `taxonomy-editor-last-debate-model` | Last debate model |
| `debate-panel-width` | Resizable panel state |

## Accessibility Minimums

- Touch targets: 44x44px minimum on `(pointer: coarse)` devices
- Focus indicators: `box-shadow: 0 0 0 2px var(--focus-ring)`
- Modals: focus trap, Escape to close
- Collapsible sections: `aria-expanded` on trigger button
- Decorative icons: `aria-hidden="true"`
- Animations: honor `prefers-reduced-motion`
- Color contrast: all theme combinations meet WCAG AA (4.5:1 text, 3:1 UI)
