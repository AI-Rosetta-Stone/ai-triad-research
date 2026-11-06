# Debate Synthesis: Scannable Single View

**Ticket:** t/4914 · **Author:** Design (Orca) · **Date:** 2026-11-06
**Direction:** PI-approved (t/4914#2): one vertical view, **not tabs**. The reasoning is in t/4914#1.
**Applies to:** the concluding statement (`ConcludingSections` in `debate-workspace/StatementCard.tsx`), in every Text tier.

## 1. What changes

| Part | Today | New |
|---|---|---|
| Card header | `System · S20 · CONCLUDING` | **Synthesis** (§2) |
| Overview | none | a strip of section names with counts, as jump links (§3) |
| First list | no heading | **Areas of Agreement (n)** (t/4914 item 1) |
| Long lists | every item shown | top 3, then **Show N more** (§4; t/4914 item 2) |
| Who holds a point | trailing text "(Skeptic, Safetyist, Accelerationist)" | camp chips, or **All three** (§5) |
| Item detail | Disagreement items: a leading ▶ on bold text; Agreement items: plain | one bullet style everywhere, with a trailing **details** disclosure (§6) |

The order is unchanged: Agreement, then Disagreement, then Cruxes, then Resolution Analysis, then the Argument Map (still collapsed).

## 2. Header

- Replace the speaker line (`System`, the `S20` id and `CONCLUDING`) with the label **Synthesis**: `--text-xs`, weight 600, letter-spacing 0.06em, uppercase, `--text-secondary`. That's the same eyebrow pattern as "THE QUESTION" (t/4824).
- Keep the statement id available in the card's existing overflow and diagnostics. It's no longer the header.

## 3. Overview strip

```
SYNTHESIS
Agreement 10 · Disagreement 6 · Cruxes 4 · Resolution · Argument map
```

- A `<nav aria-label="Synthesis sections">` directly under the header, containing a list of links.
- Each link is the section's short name, plus its item count for list sections: Agreement, Disagreement, Cruxes. Resolution and Argument map have no count.
- Clicking scrolls the section's heading into view (`scrollIntoView({ block: 'start' })`, honouring `prefers-reduced-motion`) **and expands it** if it's collapsed (Argument Map).
- Style: `--text-sm`, links in `--text-secondary` and underlined on hover and focus, separated by a `·` in `--text-muted` (decorative, `aria-hidden`). Counts use `font-variant-numeric: tabular-nums`.
- Wrap onto a second line at narrow widths; never scroll sideways.
- Only sections actually present appear. Build the strip from `splitByHeadings` output, not from a fixed list.

## 4. Sections, counts and "Show N more"

- **Every section has a heading,** including the first, heading-less block. When `splitByHeadings` returns a leading block with no heading, render it as **Areas of Agreement**. If the model's output ever puts something other than agreement first, the generator should emit the heading; don't guess from content.
- **Heading:** `<h3>`, `--text-md`, weight 600, `--text-primary`, with the count in `--text-secondary` and normal weight: "Areas of Agreement (10)".
- **Top 3:** in every **list** section (Agreement, Disagreement, Cruxes), show the first 3 items in the model's order; don't re-rank.
- **Expander:** if a section has more than 3 items, add a `button.btn-ghost.btn-xs` under the list:
  - collapsed: **Show 7 more ▾**
  - expanded: **Show fewer ▴**
  - `aria-expanded` and `aria-controls` point at the list. The revealed items are part of the same `<ul>`, so a screen reader hears one list.
  - On "Show fewer", keep the button in view; don't let it jump off-screen.
- **Each section expands on its own.** Expansion isn't remembered across reloads.
- Prose sections (Resolution Analysis) and the Argument Map are unchanged.

## 5. Camp chips

**Parsing:** a bullet whose text ends with a parenthetical made up only of camp names, `(Skeptic, Safetyist, Accelerationist)` in any order or subset, has that parenthetical **removed** from the rendered text and replaced with chips. Camp names elsewhere in the sentence stay as they are, already colourised by `remarkColorizePov`.

**Chips:** inline, after the bullet text, `margin-left: var(--sp-2)`, with no line break before them where they fit.

| Case | Render |
|---|---|
| All three camps | one chip: **All three** |
| One or two camps | one chip per camp, in a fixed order: Accelerationist, Safetyist, Skeptic |

**Chip style (no fill):**
- `display: inline-flex; padding: 0 6px; border-radius: 999px; font-size: var(--text-xs); line-height: 1.6;`
- `border: 1px solid currentColor; background: transparent;`
- Camp chip `color: var(--color-acc)` / `--color-saf` / `--color-skp`, showing the full camp name.
- **All three** chip: `color: var(--text-secondary)`.
- **Don't use a tinted background.** On `--bg-tertiary`, the camp colours fall below AA in light, harvard and bkc (see the table).

**Accessibility:**
- The chip group is `<span role="group" aria-label="Held by Skeptic, Safetyist and Accelerationist">`, or "Held by all three camps".
- The colour isn't the only signal: each chip carries the camp's name in text.

**Measured contrast** (camp-coloured chip text on the card's `--bg-secondary`; computed from the theme tokens):

| Theme | Accelerationist | Safetyist | Skeptic | All three (`--text-secondary`) |
|---|---|---|---|---|
| light | 4.85 | 6.00 | 5.72 | 7.24 |
| harvard | 4.97 | 6.58 | 6.29 | 8.33 |
| dark | 6.14 | 5.65 | 4.91 | 7.34 |
| bkc | 5.04 | 5.06 | 5.01 | 6.00 |

All pass AA for text, and the borders pass the 3:1 non-text bar.

**Rejected:** a `--bg-tertiary` fill measured Accelerationist 4.47 (light), 4.30 (harvard), Skeptic 4.14 (dark) and 4.06–4.10 (bkc), all below AA.

**If the card's background isn't `--bg-secondary`,** re-measure in the running app before shipping.

## 6. One expand pattern for item detail

- Today, Disagreement, Cruxes and Resolution items with sub-points render as **bold text with a leading ▶ toggle** (`CollapsibleBulletItem`), while Agreement items are plain. Make them all the **same plain bullet style.**
- For an item with sub-points, put a trailing **details ▸ / ▴** disclosure after the chips: a `button.btn-ghost.btn-xs` with `aria-expanded`, revealing the sub-points indented under the item.
- Don't make the item text itself clickable: today's `onClick` on the whole row makes text hard to select and isn't a button.
- Show the item's leading phrase in bold only if the model marks it bold in the markdown. Don't bold whole items.

## 7. States and edge cases

- **Fewer than 3 items:** no expander.
- **Empty section** (the heading with no bullets): omit both the section and its link in the strip.
- **No camp parenthetical:** no chips. The text renders as is.
- **Unknown names in the parenthetical** (anything other than the three camps): leave the parenthetical as text, with no chips.
- **Phone (≤767px):** the strip wraps; chips wrap onto the next line under the text if they don't fit; the expander is full-width only if the column is narrower than 360px.
- **Print and export:** export all items regardless of the expanded state (export already uses the raw markdown; keep it that way).

## 8. Acceptance criteria

1. The concluding card's header reads **Synthesis**, and the overview strip lists the sections present, with counts, as working jump links that expand a collapsed section.
2. Every section has a heading with a count. The leading block is "Areas of Agreement".
3. List sections show 3 items plus **Show N more** / **Show fewer**, with `aria-expanded`. There are tests for 2, 3 and 7 items.
4. A trailing camp-only parenthetical becomes chips, or **All three**, with the §5 style and `aria-label`. Other text is untouched. There are tests for all three, a subset, none, and unknown names.
5. Every item uses one bullet style; sub-points open through a trailing **details** button. Nothing relies on clicking the item text.
6. Contrast as in §5, in all 4 themes, measured live in Design's review. No horizontal overflow at 390px.
7. Design approves through the reviewer App, with screenshots in dark plus one light theme, and at 390px.
