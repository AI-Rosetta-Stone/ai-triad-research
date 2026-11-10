# Semantic Tint Tokens

**Author:** Design · **Status:** Tokens landed (#4853 `94da26140`; bkc Skeptic in #4864); per-owner migration in progress under t/123 · **Ticket:** t/124 (parent t/123; folds in t/48 and t/66)
**Last updated:** 2026-11-10

## Problem

About 620 of the 850 contrast findings on main come from coloured text sitting on a tint of its own hue. The tints are hand-rolled, as `rgba(239,68,68,0.12)` or `color-mix(in srgb, var(--danger) 15%, transparent)`. By family, from `check-contrast.mjs --json` at `4e847af56`:

| Family | Findings |
|---|---|
| danger (red) | 278 |
| warning (amber) | 116 |
| success (green) | 89 |
| info (blue) | 76 |
| camp colour on its own tint | 35 |
| violet badges | 30 |
| other or mixed (handled per owner) | ~190 |

Each component picks its own hex and alpha, so no single value works across four themes. A translucent tint over a variable surface also can't be checked.

## Rule

A tinted badge, pill, banner or row uses **one token pair**: `background: var(--{tone}-bg)` and `color: var(--{tone}-text)`.

- `-bg` values are **solid hex**, never `rgba` or `color-mix`, so the checker can measure them.
- `-text` values pass **≥ 4.5:1 on their own `-bg`, on `--bg-primary` and on `--bg-secondary`** in all four themes. The same token therefore also works for coloured text with no tint behind it.
- Don't dim `-text` with opacity, and don't put a `-text` on a different tone's `-bg`.
- Borders on tinted elements use the tone's existing `-border` token where one exists. Otherwise use the `-text` colour only for a 1px edge.

## Tokens

Existing tokens are reused where they already pass. **New** marks a token to add; **changed** marks a new value.

### Tones

| Tone | Token | light | dark | bkc | harvard |
|---|---|---|---|---|---|
| danger | `--error-bg` (existing) | `#FDECEC` | `#2A1616` | `#2E1A1C` | `#F5E2E2` |
| | `--error-text` (existing) | `#B42318` | `#FCA5A5` | `#FF9B9B` | `#A5182A` |
| warning | `--warning-bg` (existing) | `#FEF9EC` | `#2A2113` | `#2E2717` | `#F3EAD3` |
| | `--warning-text` **new** | `#a16207` | `#f59e0b` | `#d9a441` | `#876208` |
| success | `--success-bg` **new** | `#eff6f1` | `#143430` | `#1a4326` | `#e8ebe6` |
| | `--success-text` (existing) | `#15803d` | `#22c55e` | `#00ff4c` | `#2D6A4F` |
| info | `--info-bg` **new** | `#edf1fc` | `#1e2f49` | `#2b3239` | `#e7e9ed` |
| | `--info-text` **new** | `#1d4ed8` | `#60a5fa` | `#799dc7` | `#275498` |
| accent | `--accent-bg` (existing) | `#E8F0FE` | `#1C2A44` | `#223442` | `#F3E3E5` |
| | `--accent-text` (existing) | `#1A56DB` | `#93C5FD` | `#8FB8C8` | `#A51C30` |
| violet | `--violet-bg` **new** | `#f3edfd` | `#292a49` | `#37333e` | `#ece7ec` |
| | `--violet-text` **new** | `#7c3aed` | `#a78bfa` | `#b79be0` | `#5e3a8c` |

**Measured** (text on its own bg / on primary / on secondary; lowest per tone across themes):

| Tone | Text on its bg | On primary | On secondary |
|---|---|---|---|
| danger | 5.76 | 6.57 | 6.28 |
| warning | 4.63 | 4.92 | 4.71 |
| success | 4.57 | 5.21 | 4.79 |
| info | 4.61 | 5.86 | 5.66 |
| accent | 5.39 | 6.18 | 5.91 |
| violet | 4.98 | 5.70 | 5.39 |

`violet` covers the non-semantic purple badges (phase commit, model badge, policymaker audience, DOLCE kind). It isn't a camp colour; Skeptic keeps `--color-skp`.

### Camp tints

Camp text keeps its identity colour (`--color-acc/saf/skp`). Only the tint behind it is tokenised, at one strength per theme, so the three camps read as a set.

| Token **new** | light (7%) | dark (16%) | bkc (8%) | harvard (10%) |
|---|---|---|---|---|
| `--color-acc-bg` | `#faf3ee` | `#332c2e` | `#2d2722` | `#f1e7de` |
| `--color-saf-bg` | `#f0f4f9` | `#222e43` | `#25282c` | `#e5e8ec` |
| `--color-skp-bg` | `#f6f3f9` | `#292a41` | `#2a272c` | `#ece6eb` |

Each camp colour on its own tint is ≥ 4.62:1 in every theme.

### t/48: dark Skeptic

The dark `--color-skp` value changes from `#a888c8` to **`#b69bd1`**. Before, it was 4.37:1 on the ambiguous block and 4.06:1 on hover. After, it's 4.62 on `--bg-hover`, 5.35 on the ambiguous block, 7.26 on primary and 5.73 on `--color-skp-bg`.

It's a light lift of the same hue, so it still reads as Skeptic purple next to Safetyist blue, which differs in hue.

**bkc addendum** (Quality, t/48#4): bkc `--color-skp` had the same gap (4.13 on hover, 4.06 on tertiary). It changes from `#a882be` to **`#b18fc5`**: 5.97 on primary, 5.77 on secondary, 4.68 on tertiary, 4.76 on hover, 5.34 on `--color-skp-bg`. Light and harvard are unchanged. The login page's own copy of the dark value was synced in #4859.

### t/66: input boundaries

**New token: `--input-border`.** Text inputs, selects and textareas use it for their 1px border. `--border-color` stays as it is for dividers and card edges, where WCAG 1.4.11 doesn't require 3:1. Changing it globally would darken every divider in the app.

| | light | dark | bkc | harvard |
|---|---|---|---|---|
| `--input-border` **new** | `#85909f` | `#6a7381` | `#78677c` | `#8d8780` |
| vs primary / secondary | 3.24 / 3.09 | 3.70 / 3.06 | 3.16 / 3.06 | 3.35 / 3.13 |
| `--border-color` today, vs primary | 1.23 | 1.72 | 1.59 | 1.46 |

All four themes failed, not only dark. `--lib-border-control` should point at `--input-border`.

## Migration map

Owners replace the hand-rolled pair with the token pair. The common patterns:

| Today (any alpha or %) | Becomes |
|---|---|
| `var(--danger)`, `#ef4444`, `#dc2626` on `rgba(239,68,68,a)`, `rgba(220,38,38,a)` or `color-mix(var(--danger) n%)` | `var(--error-text)` on `var(--error-bg)` |
| `var(--warning)`, `#f59e0b`, `#d97706`, `#b45309` on an amber or yellow tint | `var(--warning-text)` on `var(--warning-bg)` |
| `var(--success)`, `#16a34a`, `#15803d`, `#22c55e` on a green tint | `var(--success-text)` on `var(--success-bg)` |
| `var(--info)`, `#2563eb`, `#3b82f6`, `var(--focus-ring)` on a blue tint (not a solid ring fill) | `var(--info-text)` on `var(--info-bg)` |
| `#8b5cf6`, `#7c3aed`, `#a78bfa` on a violet tint | `var(--violet-text)` on `var(--violet-bg)` |
| `var(--color-acc/saf/skp)` on `color-mix(that colour n%)` | the same colour on `var(--color-acc/saf/skp-bg)` |
| input or select border `var(--border-color)` / `--lib-border-control` | `var(--input-border)` |

A solid `--focus-ring` fill stays on `--text-on-focus-ring` (t/123). It isn't a tint.

Anything that doesn't fit a row or a standing rule below goes back to Design on the owner's ticket. Don't invent a new pair.

## Standing rules for off-map cases

These come from the first round of migration questions (t/188, t/189, t/191, t/192, t/193, t/194). Apply them without asking. A PR that applies only map rows plus these rules is still a quick approval from the diff.

| # | Case | Rule | Measured (lowest across themes) |
|---|---|---|---|
| S1 | **Neutral chip or tint**: muted text on a muted tint, or a grey badge (closed, retired, unverifiable, cross-tier) | `color: var(--text-secondary); background: var(--bg-tertiary)` | 4.87 (bkc) |
| S2 | **`--focus-ring` used as a tint** behind a label | the info pair. The selection colour isn't a label colour (t/189). | per the info row |
| S3 | **`--focus-ring` or a hue used as plain text, with no tint** | the matching tone's `-text` (`--info-text`, `--success-text`, …). Every `-text` passes on primary and secondary. | per the tone row |
| S4 | **Selected or active state on a solid fill** (an active tab or pill) | `background: var(--focus-ring); color: var(--text-on-focus-ring, #fff)` (t/123). Not `--info` as a solid fill. | 4.70 (bkc) |
| S5 | **Solid destructive fill with text** (danger button, danger count badge) | `background: var(--danger-fill); color: #fff`. **New token, below.** Not `--danger`, which is 3.76:1 with white. | 4.83 |
| S6 | **Solid warning fill with text** (an active warning toggle) | the warning pair, tinted. There's no solid warning fill with legible text in every theme. | per the warning row |
| S7 | **Highlight mark** (search hit, matched span) | `color: var(--text-primary); background: var(--warning-bg)` | 11.46 (bkc) |
| S8 | **Hover on a tinted element** | keep the same `-bg` (they're solid, so there's no alpha to lift). On hover, strengthen the border to the tone's `-text`. Base border: the tone's `-border` where it exists (error, warning), otherwise transparent. Don't use `filter: brightness()`, which also changes the text contrast. | — |
| S9 | **Identity hues that aren't status** (chat modes, one-off method or DOLCE hues) | the tone pair with the **same hue**: orange/amber → warning, green → success, blue/cyan/teal → info, indigo/purple → violet. **Exception:** if the warning pair would make a neutral item read as a problem next to green siblings, use info instead. | per the tone row |
| S10 | **A camp colour as a generic action fill** (Accept, Apply) | the solid accent pairing: `background: var(--accent-text); color: var(--bg-primary)` (t/104). Camp colours mean camps, not actions. | 6.18 |
| S11 | **`var(--bg, …)`**: `--bg` is defined in no theme, so it falls back to the hard-coded value (often `#fff`) | `var(--bg-primary)`, or `var(--bg-input)` for an input, select or textarea background. It's a bug fix, not a tint. | — |
| S12 | **Icon-only button on a solid fill** (glyph, no text) | the 3:1 non-text bar applies, not 4.5. White on `--danger` (≥ 3.76) passes. The checker may still count it; note it in the PR. | 3.76 |

**New token for S5:** `--danger-fill`, used as the background with white text.

| | light | dark | bkc | harvard |
|---|---|---|---|---|
| value | `#dc2626` | `#dc2626` | `#dc2626` | `#A5182A` |
| white on it | 4.83 | 4.83 | 4.83 | 7.60 |
| vs page (non-text) | 4.83 | 3.67 | 3.41 | 7.17 |

The global `.btn-danger` (`styles.css`, `background: var(--danger)` with white text) should move to it too.

## Rollout

1. **Token PR** (Rosetta Stone):
   - add the **new** tokens and the dark `--color-skp` change to the four theme blocks in `styles.css` (value-only and additive, so the freeze doesn't apply);
   - point `--lib-border-control` at `--input-border`;
   - no component changes.

   Design reviews it with harvard and dark screenshots of one badge per tone and a focused input. It ratchets the ceiling.
2. **Per-owner children** under t/123: each migrates its files via the map, lowers the ceiling, and gets Design approval from the diff when it only applies map rows.
3. Once step 1 merges, Design records the tokens in `design-system.md`. (Done in the same PR that set this spec's status to landed.)
