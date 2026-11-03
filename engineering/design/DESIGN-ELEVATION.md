# Taxonomy Editor — Design Elevation Guide

**Audience:** Claude (Code), implementing against `taxonomy-editor/` in `ai-triad-research`.
**Scope:** Visual design and UX only. Do not change application logic, data models, routes, the server, or the theme-switching mechanism. All work is CSS, tokens, markup structure, microcopy, and small presentational component changes.
**Evidence base for this guide:** live login page; `test-baselines/smoke/*.png` and `test-screenshots/*.png`; `src/renderer/styles.css` (17,754 lines); `Toolbar.tsx`, `TabBar` styles, chat/debate/taxonomy component CSS.

---

## 1. Diagnosis — why it currently reads as "designed by an engineer"

These are measured facts about the codebase, not impressions. Every recommendation later in this doc traces back to one of them.

1. **No design tokens beyond color.** The CSS variable system covers colors and themes well (light/dark/BKC/Harvard — genuinely good architecture), but there are **zero** spacing, typography, radius, or shadow tokens. One lonely `var(--radius-sm, 4px)` exists at line 5599 with no definition.
2. **Typographic anarchy.** 1,073 `font-size` declarations across **30+ distinct values** (0.5rem–3rem, mixing `rem` and `em`). The modal body-text sizes are 0.75/0.7/0.8/0.65rem — i.e., most of the UI is set at **10.4–12.8px**. Dense-tool users tolerate 13px; they do not enjoy 10px. There is no type scale, so nothing looks deliberately sized relative to anything else.
3. **No typographic identity.** `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` — the system default. For a discourse-analysis platform whose content *is prose and argument*, everything renders in the same voice as the chrome.
4. **Radius/shadow drift.** 15 distinct `border-radius` values (4px ×136, 6px ×82, 3px ×80, 8px ×39, 2px ×33, plus 5/10/11/12/16/18/20px). 54 ad-hoc `box-shadow`s. Corners and elevation are the fastest tell of an untended UI.
5. **3,718 inline `style={{}}` blocks** in components (436 in chat + debate-workspace alone). These bypass the theme system and make consistency mechanically impossible.
6. **Semantic color collision.** Camp colors are green (Accelerationist), red (Safetyist), yellow (Skeptic) — a traffic light. Red-as-identity collides with red-as-danger (`--danger: #ef4444` is nearly the same hue as `--color-saf: #dc2626`), green-as-identity collides with `--success`. A user cannot tell "Safetyist" from "error" at a glance. Red/green is also the worst possible pair for deuteranopia.
7. **Navigation without words.** The 44px left rail is icon-only with hand-rolled inline SVGs (30 in `Toolbar.tsx`) and `data-tooltip` reveals. The three *key scenarios* — Taxonomy, Debate, Chat — are visually identical, unlabeled 36px squares mixed in with Search, Reload, and Settings. First-run users must hover-hunt.
8. **Accessibility floor missing.** 37 `aria-label`s total; exactly one `:focus-visible` rule; `user-scalable=no, maximum-scale=1.0` in the viewport meta (blocks pinch-zoom — a WCAG 1.4.4 failure and an App Store review flag).
9. **Density without hierarchy.** Screenshots show every panel bordered, every section boxed, chips everywhere, near-uniform 11–13px text. When everything is emphasized with a border, nothing is.
10. **The front door is bare.** The login page is an unstyled column of provider buttons. It is the first impression of a research platform and it currently communicates "internal tool."

---

## 2. Design direction

**Thesis: a scholarly instrument.** AITriad is epistemic infrastructure — it stages arguments among three ideological camps. The design should express exactly that split:

- **Content is prose.** Node descriptions, debate statements, chat messages, and rationales are set in a readable serif at genuinely readable sizes. The material under analysis gets the typographic dignity of a journal.
- **Chrome is instrument.** Toolbars, trees, chips, tables, labels stay in a compact, neutral sans. Precise, quiet, dense.

That contrast — serif reading surfaces inside a sans instrument — is the signature. It is cheap to implement (font tokens + a `.prose` class), it is grounded in what the product is, and no template produces it.

**Restraint rule for the implementer:** the serif reading surfaces and the camp glyph system (§4) are the two expressive moves. Everything else gets *quieter* than it is today: fewer borders, fewer boxes, fewer colors per screen. When in doubt, remove.

---

## 3. Token system (Phase 1 — everything else depends on this)

Add to the top of `styles.css` (or a new `tokens.css` imported first). These are theme-independent; the existing per-theme color blocks stay as they are (colors are the one thing already tokenized).

```css
:root {
  /* ── Typography ── */
  --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-prose: 'Source Serif 4', Georgia, serif;
  --font-mono: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;

  /* Type scale — 8 sizes replace 30+. Nothing below 11px, ever. */
  --text-2xs: 0.6875rem;  /* 11px — chips, badges, mono IDs only */
  --text-xs:  0.75rem;    /* 12px — labels, table meta, tree secondary */
  --text-sm:  0.8125rem;  /* 13px — default UI text: tree, buttons, inputs */
  --text-md:  0.875rem;   /* 14px — panel body, forms */
  --text-prose: 0.9375rem;/* 15px — reading surfaces (serif) */
  --text-lg:  1.0625rem;  /* 17px — panel/dialog titles */
  --text-xl:  1.375rem;   /* 22px — page/node titles */
  --text-2xl: 1.75rem;    /* 28px — login, empty-state headlines */

  --leading-ui: 1.4;
  --leading-prose: 1.65;

  /* ── Spacing — 4px grid ── */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px; --sp-12: 48px;

  /* ── Radii — exactly three ── */
  --radius-sm: 4px;   /* chips, inputs, small buttons */
  --radius-md: 8px;   /* cards, panels, message bubbles */
  --radius-lg: 12px;  /* dialogs, popovers */
  /* 50% stays for avatars only */

  /* ── Elevation — exactly three ── */
  --shadow-1: 0 1px 2px rgba(15, 23, 42, 0.06);
  --shadow-2: 0 4px 12px rgba(15, 23, 42, 0.10);
  --shadow-3: 0 12px 32px rgba(15, 23, 42, 0.18);

  --transition-fast: 120ms ease;
  --transition-base: 180ms ease;
}
```

Load fonts self-hosted (the app runs in a container; do not depend on Google Fonts at runtime). `npm i @fontsource-variable/inter @fontsource/source-serif-4 @fontsource-variable/jetbrains-mono`, import in `index.tsx`, subset latin.

**Migration rules (mechanical — apply across all 17,754 lines):**

| Existing value | Replace with |
|---|---|
| font-size 0.5–0.68rem | `--text-2xs` (and question whether the element should exist) |
| 0.7–0.76rem | `--text-xs` |
| 0.78–0.82rem | `--text-sm` |
| 0.85–0.9rem | `--text-md` |
| 0.95–1.1rem | `--text-lg` |
| 1.2–1.5rem | `--text-xl` |
| radius 2–5px | `--radius-sm` |
| radius 6–10px | `--radius-md` |
| radius 11–20px | `--radius-lg` |
| all box-shadows | nearest of `--shadow-1/2/3` |
| padding/margin/gap | snap to nearest `--sp-*` |

**Inline styles:** do not attempt a big-bang removal of all 3,718. Rule going forward: any component you touch in a later phase gets its inline styles hoisted into its CSS file using tokens. Add an ESLint rule (`react/forbid-dom-props` for `style`, warn-level) so the number only goes down. The repo already has custom eslint-rules infrastructure — use it.

---

## 4. Camp identity system (the semantic-collision fix)

Replace the traffic-light triad with a colorblind-safe **orange / blue / violet** triad, and free red/green to mean danger/success exclusively:

```css
:root, [data-theme="light"] {
  --color-acc: #d95f18;  /* Accelerationist — ember orange */
  --color-saf: #2b5fad;  /* Safetyist — guardian blue */
  --color-skp: #7b4fa6;  /* Skeptic — violet */
  --color-sit: #0f766e;  /* Situations — teal (unchanged family) */
  --color-conflicts: #64748b;
  /* per-camp tints for backgrounds/badges */
  --tint-acc: rgba(217, 95, 24, 0.10);
  --tint-saf: rgba(43, 95, 173, 0.10);
  --tint-skp: rgba(123, 79, 166, 0.10);
}
```

Derive dark, BKC, and Harvard equivalents: raise lightness ~15% (dark), desaturate toward the BKC plum palette (BKC), use muted earth-toned variants consistent with Harvard's existing library aesthetic (Harvard). Verify every camp color hits ≥4.5:1 against its theme's `--bg-secondary` when used as text in all four themes.

**Revert reference — prior camp colors (restore these values to revert to the traffic-light palette):**

| Token | Light | Dark | BKC | Harvard |
|---|---|---|---|---|
| `--color-acc` | `#16a34a` (green) | `#2ecc71` | `#4d7a8b` | `#2D6A4F` |
| `--color-saf` | `#dc2626` (red) | `#e74c3c` | `#7c101c` | `#A51C30` |
| `--color-skp` | `#ca8a04` (yellow) | `#f1c40f` | `#a349a4` | `#B8860B` |

Add a **camp glyph set**: three 16px stroke icons — flame (Accelerationist), shield (Safetyist), eye (Skeptic) — used consistently in the tab bar, tree headers, debate speaker labels, and chat participants. Color alone stops carrying camp identity; glyph + color together do. Put them in a single `CampGlyph.tsx` component; no more copy-pasted inline SVGs for these.

While in the color block: today `debate`'s active tab borrows `--focus-ring` blue. Give Debate and Chat their own neutral identity (`--text-primary` underline) so focus-ring blue means *focus* only.

---

## 5. Navigation and shell

### 5.1 Left rail → labeled primary nav
The three key scenarios must be readable, not hover-discoverable.

- Widen the rail from 44px to **64px**. Primary items (Search, **Taxonomy**, **Debate**, **Chat**) become icon-over-label stacks: 20px icon, `--text-2xs` label beneath, 56×52px hit area, `--radius-md` hover/active pill.
- Active state: filled pill in `--bg-hover` plus a 2px left indicator bar in `--text-primary` (not a camp color — the rail is chrome).
- Everything else (Other Tools, Help, Feedback, Reload, Settings) stays icon-only, grouped at the bottom, separated by one divider. Two visual tiers = instant "these three things are the product."
- Replace hand-rolled SVGs with `lucide-react` (already the ecosystem default; consistent 1.5px stroke grid). Keep the three custom camp glyphs.
- Every rail button gets `aria-label`; tooltips become supplementary, not the only affordance.

### 5.2 Tab bar
Six rainbow underlines compete. Changes:
- Tab label = camp glyph + name. Inactive tabs: `--text-secondary`, no color. Active tab: camp color text + 2px underline + `--tint-*` background wash on the tab itself. Only one colored element on screen at rest.
- Increase tab padding to `var(--sp-2) var(--sp-4)`; font `--text-sm`, weight 600 active / 500 inactive.

### 5.3 Panel rhythm (the "everything is boxed" fix)
Adopt one rule: **separate siblings with space, separate regions with a single hairline, reserve boxes for interactive cards.**
- Tree panel and detail panel: remove internal section borders; use `--sp-6` vertical gaps and `--text-xs` uppercase-tracked section labels (`letter-spacing: 0.06em; color: var(--text-muted)`) instead of bordered boxes.
- One hairline between rail/tree/detail. Panel backgrounds: rail `--bg-secondary`, tree `--bg-primary`, detail `--bg-primary`. Kill `--bg-panel` grey slabs behind content.

---

## 6. Key scenario specs

### 6.1 Taxonomy (tree + node detail)
- **Tree rows:** 28px height, `--text-sm`, 20px indent per level, chevron only when children exist. Category accent (desires/beliefs/intentions) becomes a 3px left tick on the row, not colored text — text stays `--text-primary` for scanability. Selected row: `--tint-*` of the active camp + weight 600. Hover: `--bg-hover`.
- **Node detail header:** node title in `--font-prose`, `--text-xl`, weight 600 — the first serif moment. Beneath it a single meta line: category chip + mono ID chip + status. Action buttons (Suggest with AI, New Node…) collapse into one primary button + an overflow `⋯` menu; today's row of five equal buttons gives no priority.
- **Description and rationale fields:** `.prose` class — `--font-prose`, `--text-prose`, `--leading-prose`, `max-width: 68ch`. This is where the identity lands.
- **Chips:** one chip recipe app-wide: `--text-2xs`, mono for IDs, `--radius-sm`, `--chip-bg`, 2px 8px padding. Delete all local variants.

### 6.2 Debate
- Debate statements are the product's crown jewels — set `StatementCard` content in `.prose`. Speaker header: camp glyph + name in camp color + turn number in mono `--text-2xs`. Card: `--radius-md`, `--shadow-1`, 3px left border in camp color, `--sp-4` padding. No other borders inside the card.
- Transcript column fills the available panel width (no `max-width` — debate content should use the full space); phase transitions marked by a labeled hairline ("Opening statements", "Cross-examination") instead of boxes.
- New Debate dialog: group the form into steps or labeled sections with `--sp-6` gaps; primary action bottom-right, filled; secondary as text button. Dialog: `--radius-lg`, `--shadow-3`, one title in `--text-lg`.

### 6.3 Chat
- Message content → `.prose` (currently 0.85rem sans). User messages right-aligned in `--bg-hover` at `--radius-md`; assistant/camp messages left, `--bg-secondary`, with camp glyph avatar (24px circle in `--tint-*`).
- Composer: pinned bottom, `--radius-lg` input, visible send button, `--shadow-2` when content scrolls beneath it. Taxonomy-reference pills stay `--text-2xs` but move into a collapsed "n references" toggle by default — they currently compete with the message text.

### 6.4 Login page (front door)
Rebuild as a split layout: left panel = product statement ("AITriad Taxonomy Editor — explore how three schools of AI thought see the world") on `--bg-secondary` with the three camp glyphs as a quiet motif; right panel = card with three provider buttons (real brand icons, consistent 40px height, `--radius-md`), the anonymous option as a text link beneath, and the read-only caveat as `--text-xs` muted. Serif headline at `--text-2xl`. Ten minutes of work, disproportionate first-impression payoff.

---

## 7. States, motion, accessibility (quality floor — non-negotiable)

- **Empty states:** the codebase has ~15 `*-empty` classes, mostly italic grey text. One `EmptyState` component: optional glyph, one-line headline (`--text-md`, 600), one-line direction, optional primary action. Empty screens are invitations to act, not apologies.
- **Focus:** global `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }` on all interactive elements. Delete outline suppressions.
- **Viewport:** change to `width=device-width, initial-scale=1.0, viewport-fit=cover`. Remove `maximum-scale` and `user-scalable=no`.
- **ARIA:** every icon-only button gets `aria-label`; rail becomes `<nav aria-label="Primary">`; tab bar gets `role="tablist"` semantics.
- **Motion:** transitions only on `--transition-fast/base` for hover/active; dialogs get one 150ms fade+2px rise; the existing `prefers-reduced-motion` block must zero all of it. No other animation — this is an instrument, not a landing page.
- **Contrast:** after recoloring, verify `--text-muted` on `--bg-secondary` ≥ 4.5:1 in all four custom themes — light, dark, BKC, Harvard (dark theme's `#6b7280` on `#1f2937` currently fails at ~3.9:1 — lighten to `#8b93a1`). The `system` theme resolves to light or dark at runtime via `prefers-color-scheme` — it has no separate color block and inherits automatically.

---

## 8. Implementation plan

Work in this order; each phase leaves the app shippable.

**Phase 1 — Tokens (no visual change intended).** Add token block; mechanical migration per §3 table; add ESLint warn on `style` prop; load fonts but keep `--font-ui` mapped to the system stack temporarily so this phase is a pure refactor. Acceptance: zero raw `font-size`/`border-radius`/`box-shadow` literals outside tokens.css; screenshots diff within anti-aliasing noise.

**Phase 2 — Type + camp colors.** Flip `--font-ui` to Inter, introduce `.prose`, apply the §4 palette and CampGlyph. Acceptance: no text below 11px; camp colors pass contrast in all four custom themes (light/dark/BKC/Harvard); red appears only for destructive/error.

**Phase 3 — Shell.** Rail (§5.1), tab bar (§5.2), panel rhythm (§5.3), login page (§6.4). Acceptance: Taxonomy/Debate/Chat identifiable with labels visible, no hover required; at most one hairline between adjacent regions.

**Phase 4 — Scenario surfaces.** §6.1–6.3, EmptyState rollout, dialog recipe. Hoist inline styles from every file touched. Acceptance: debate statements and chat messages render in serif ≥15px; single chip recipe; New Debate dialog uses the shared dialog recipe.

**Phase 5 — Floor.** §7 items, then regenerate `test-baselines/smoke/*` and mobile screenshots as the new visual baseline.

**Guardrails for the implementer**
- Never hardcode a color; every value routes through the four custom theme blocks (light/dark/BKC/Harvard). Test every change in all four themes before moving on. The `system` theme resolves to light or dark automatically — no separate block needed.
- Do not introduce a component framework or Tailwind; the surface area is CSS + existing React.
- Do not rename existing CSS classes used by tests; add, restyle, deprecate.
- `styles.css` may be split by concern (tokens / shell / taxonomy / debate / chat / dialogs) but keep import order deterministic.
- After each phase, capture screenshots of: main window in all four custom themes (light/dark/BKC/Harvard), debate workspace, chat, New Debate dialog, login, phone-initial — and self-critique against §2's restraint rule: if a screen has more than one expressive element, remove one.
