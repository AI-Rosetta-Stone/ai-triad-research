# POV Tag Chip — Camp Tint

**Author:** Design (Orca)
**Status:** Spec — ready for implementation
**Origin:** p/351 (Jeffrey). Follows the POV-tag UI audit; addresses the finding that POV tag chips in the node editor render as generic neutral chips, visually indistinguishable from any other chip and giving no cue that they are camp-scoped POV tags.
**Surface:** `PovTagEditor` chips on the Content tab of `NodeDetail` (`src/renderer/components/taxonomy/PovTagEditor.tsx` / `.css`).

---

## 1. Problem

On a Skeptic node, applied tags render via `.pov-tag-chip` as rounded pills with `background: var(--bg-secondary)`, `border: 1px solid var(--border-color)`, `color: var(--text-primary)` — i.e. the neutral chip look. Two consequences:

1. **No camp signal.** Nothing marks these as *POV* tags belonging to the Skeptic camp. They read the same as any incidental UI chip.
2. **Low scanability.** On a node with other grey UI around it, the tags don't pop as a distinct, meaningful class of metadata.

(Today only the Skeptic camp has registry tags — Critical, Institutional — so in practice these are the only tag chips that appear. The spec is written camp-generically so it applies unchanged if acc/saf/cc gain tags later.)

## 2. Design decision — what color encodes

**Color encodes the *camp*, not the individual tag.** Both Skeptic tags (Critical, Institutional) get the **same** Skeptic-purple tint. They are disambiguated from each other by their **text label**, exactly as today.

Rationale — this is the load-bearing call, so it's explicit:

- The camp is a real, bounded semantic axis with an established color system (`--color-acc/-saf/-skp/-sit/-conflicts`). Tinting by camp reuses a meaning the user already knows.
- Giving Critical vs Institutional each their *own* color would invent a second color axis with no inherent meaning, and would collide with / dilute the 5 camp colors. **Do not do this.**
- The tag label text already distinguishes the two tags and is not a color-only signal, so colorblind users lose nothing (satisfies "never encode meaning by color alone").

If distinguishing the two tags *at a glance* (beyond reading the word) ever becomes a goal, the right lever is a small per-tag **glyph/letter** mark, not a second color — tracked as a possible future pass in §7, explicitly **out of scope here**.

## 3. Visual spec

The chip keeps its current geometry (pill, `padding: 1px 8px`, `border-radius: 999px`, `gap: 4px`, `font-size: var(--text-sm)`). Only the three color properties change, and only for valid camp-tagged chips:

| Property | Today | New (camp-tinted) |
|---|---|---|
| `background` | `var(--bg-secondary)` | `color-mix(in srgb, var(--chip-camp) 12%, var(--bg-secondary))` |
| `border` | `1px solid var(--border-color)` | `1px solid var(--chip-camp)` |
| `color` (text) | `var(--text-primary)` | **unchanged** — `var(--text-primary)` |

`--chip-camp` is a custom property the component sets to the chip's camp token (for Skeptic: `var(--color-skp)`). See §4.

Why these values:

- **12% tint** keeps the chip background luminance very close to `--bg-secondary`, so `--text-primary` keeps its existing AA contrast in every theme (the text is reading against essentially the same surface it does today). The tint is a *wash*, not a fill.
- **Full-strength camp border** carries the identity crisply without touching text contrast. This is where the chip reads as "Skeptic."
- Text stays `--text-primary` — deliberately **not** the camp color — so legibility never depends on the camp token's contrast.

### States

- **Hover (chip):** no change required; the chip is not itself clickable.
- **Remove button (`.pov-tag-chip-remove`):** keep `color: var(--text-secondary)`, hover `var(--text-primary)`. Both must stay ≥4.5:1 against the *tinted* background — verify in §6 (the 12% wash makes this near-certain, but it's on the checklist).
- **Focus (remove button):** existing focus ring (`box-shadow: 0 0 0 2px var(--focus-ring)`) unchanged.

### Orphan chip — unchanged, do not tint

`.pov-tag-chip-orphan` (a tag no longer in the registry) **keeps** its current treatment: dashed `var(--warning)` border, `var(--text-muted)` text, no camp tint. An orphan is an invalid/unknown tag — it must read as a *problem*, not as a valid camp tag. Make sure the camp-tint rule does **not** cascade onto `.pov-tag-chip-orphan` (scope the tint to `.pov-tag-chip:not(.pov-tag-chip-orphan)`, or don't set `--chip-camp` on orphan chips).

### "Untagged" empty state — unchanged

`.pov-tag-editor-empty` ("Untagged", italic muted) is not a chip and is unaffected.

## 4. Component wiring

The chip's camp is derivable from the editor's POV (`povToCamp(pov)` already exists). On each valid tag chip, set:

- `data-camp={camp}` — a styling/test hook, mirroring the existing `.ndd-debater-chip[data-camp]` pattern in `NewDebateDialog` (keep the two consistent).
- inline style `--chip-camp: var(--color-${camp})` — the single source the CSS reads.

CSS then references `var(--chip-camp)` only; no per-camp CSS branches needed (DRY, and new camps work with zero CSS changes). Example shape (illustrative, not prescriptive about JSX):

```css
.pov-tag-chip:not(.pov-tag-chip-orphan) {
  background: color-mix(in srgb, var(--chip-camp) 12%, var(--bg-secondary));
  border-color: var(--chip-camp);
}
```

`color-mix` is fully supported in the app's Electron/Chromium runtime. If for any reason a non-mix fallback is wanted, define per-theme `--chip-skp-bg` tokens in `styles.css` instead and verify each theme by hand — but `color-mix` off `--bg-secondary` is preferred because it auto-adapts to every theme and to any future camp-token change.

## 5. Scope note — other surfaces

This spec covers the **node-editor chips** (`PovTagEditor`). It deliberately does **not** change:

- The **debate-setup chip** (`NewDebateDialog`), which is already a solid camp-colored pill ("Skeptic · Critical") — that's a different, heavier treatment appropriate to its context and stays as is.
- The **Skeptic-tab list filter** dropdown (`PovTagFilterSelect`) — a native `<select>`; leave neutral.
- The **public inquiry scope line** — prose, not a chip.

Keeping the node-editor chip a *tinted* (not solid) pill is intentional: a node can carry several, inline with editing controls, so a light wash reads as metadata, whereas a solid fill would shout.

## 6. Accessibility checklist (implementer must verify live, all 5 themes)

Themes: light, dark, bkc, harvard, system. For each:

1. `--text-primary` on the tinted chip background ≥ **4.5:1** (body text AA).
2. `.pov-tag-chip-remove` default + hover on the tinted background ≥ **4.5:1**.
3. Chip border (`--chip-camp`) vs the chip's own tinted background ≥ **3:1** (UI-component AA). If a camp token ever fails this in a theme, bump the border mix (e.g. `color-mix(... --chip-camp 70%, var(--text-primary))`) rather than lowering the tint — the tint must stay ≤~12% to protect rule 1.
4. Tag meaning is conveyed by text, not color alone (inherent — confirm no label was dropped).
5. Orphan chip still reads as warning (dashed `--warning`), visually distinct from the tinted valid chips.

Skeptic-purple values for reference: light `#7b4fa6`, dark `#b69bd1`, bkc `#b18fc5`, harvard `#6d4595` (`--color-skp`; dark and bkc lifted in t/48; see `design-system.md` §POV Colors). For a new tinted camp chip, prefer `--color-{camp}-bg` from `semantic-tint-tokens.md` (t/124) over a `color-mix` tint.

## 7. Out of scope / future

- **Per-tag glyph** to distinguish Critical vs Institutional at a glance (letter mark or small icon). Not needed now; the label carries it. If requested, spec separately.
- **Leading camp glyph** (the `CampGlyph` "?") inside each chip — redundant on a node you already know is Skeptic, and costs horizontal space on multi-tag rows. Omit.
- Tinting the list-filter `<select>` options.

## 8. Design-system follow-up

If the `color-mix` tint pattern is adopted, add a one-line note to `design-system.md` under Component Patterns (a "camp-tinted chip" entry: 12% camp wash on `--bg-secondary`, full camp border, primary text) so the pattern is reusable and consistent if other camps gain tags.
