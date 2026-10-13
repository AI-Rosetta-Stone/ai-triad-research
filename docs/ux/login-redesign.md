# Login Redesign — "The Specimen" Front Door

**Author:** Design (Orca)
**Status:** Ready for implementation
**Replaces:** the current centered dark card (screenshot 2026-07-08): generic title, three provider buttons, anonymous link. Functional, anonymous-looking, communicates "internal tool."
**Relationship to DESIGN-ELEVATION.md:** implements and supersedes the §6.4 sketch. Uses elevation tokens where they exist; degrades gracefully where they don't yet (noted inline).

---

## 1. Concept

The login's job is to get a researcher through the door while telling them in one glance what this instrument is. The most characteristic thing in this product's world is three voices disagreeing about one question. So the front door shows exactly that: a **specimen** of the product itself. One question, three one-line answers, one per camp.

The page reads as a book: a dark **jacket** panel carrying the product statement and the specimen, and a light **paper** panel carrying the sign-in card. Content lives on the jacket in serif; controls live on the paper in sans. That is the scholarly-instrument thesis (prose inside instrument) enacted at the first pixel.

**The one aesthetic risk:** real argumentative content on a login page. No template produces it, and it demonstrates the product before a single click. The risk is contained by using owner-approved static copy, not live data (§4).

## 2. Layout

Desktop (≥1024px), split 55 / 45:

```
┌──────────────────────────────────────────────┬────────────────────────────┐
│  JACKET (ink)                                │  PAPER (warm white)        │
│                                              │                            │
│  AI TRIAD RESEARCH · BERKMAN KLEIN CENTER    │                            │
│                                              │   Sign in                  │
│  AI Rosetta Stone          (serif display)   │                            │
│                                              │  [◫ Continue with GitHub ] │
│  Three schools of thought.                   │  [G Continue with Google ] │
│  One map of the argument.   (serif tagline)  │  [▦ Continue with Microsoft]│
│                                              │                            │
│  ────────────────────────────               │                            │
│                                              │                            │
│  "Should frontier AI development             │  ───────── or ─────────    │
│   slow down?"                (serif italic)  │                            │
│                                              │  Browse without an account │
│   ◆ Accelerationist                          │                            │
│     Slowing down surrenders the benefits     │  Read-only: explore the    │
│     to whoever doesn't.                      │  full taxonomy and debate  │
│   ◆ Safetyist                                │  archive. Sign in to run   │
│     Speed without verification is how        │  debates and edit.         │
│     we lose control.                         │                            │
│   ◆ Skeptic                                  │                            │
│     First show me evidence the               │  Trouble signing in?       │
│     premise holds.                           │  Clear session and retry   │
│                                              │                            │
│  A research instrument of the Berkman        │                            │
│  Klein Center, 2026                          │                            │
└──────────────────────────────────────────────┴────────────────────────────┘
```

Tablet (768–1023px): same split at 50/50, specimen tightens (question + voices only, no footer line).

Phone (<768px): the jacket collapses to a compact header band (eyebrow + project title, tagline and specimen hidden), and the paper panel fills the rest of the viewport. The specimen is a desktop/tablet moment; on phone the door just opens.

## 3. The two surfaces

**Jacket (left).** Fixed identity, independent of the app theme. The login is the cover, not the book; it does not re-theme. Background: the current login ink (#131c2b family) deepened slightly toward blue-black (#111a28). No gradient, no texture. The restraint IS the texture.

**Paper (right).** Warm white (#FBF9F4, the Harvard-family paper tone), `--text-primary` dark text. This panel is deliberately light even for dark-theme users: one bright page against a dark jacket is the book metaphor, and it makes the sign-in card impossible to miss. State this in a code comment so a future dark-mode sweep doesn't "fix" it.

## 4. The specimen (signature element)

- **Question:** serif italic, quotation marks, `--text-lg` equivalent (17–18px), `rgba(255,255,255,0.92)`.
- **Voices:** three rows. Each row: camp glyph (or 8px camp-color dot until CampGlyph ships), camp name in the camp color at `--text-xs` weight 600, then the one-liner in serif, 15–16px, `rgba(255,255,255,0.78)`, max 2 lines.
- **Copy is static and owner-approved.** Ship with the placeholder set below; the owner may swap in a real specimen from the corpus later. Do not wire live data; the front door must never surprise.

Placeholder copy (illustrative, replaceable):
> "Should frontier AI development slow down?"
> **Accelerationist** — Slowing down surrenders the benefits to whoever doesn't.
> **Safetyist** — Speed without verification is how we lose control.
> **Skeptic** — First show me evidence the premise holds.

- **Camp colors on ink:** use the dark-theme camp tokens (they are already lightness-raised for dark surfaces). Verify each camp name hits 4.5:1 against #111a28; if a token falls short, lighten the login instance and note it.

## 5. Type and copy

| Element | Face | Size / weight |
|---|---|---|
| Eyebrow | UI sans, uppercase, `letter-spacing: 0.08em` | 11px / 600, `rgba(255,255,255,0.55)` |
| Project title — "AI Rosetta Stone" | Serif (`--font-prose` when it exists; `Georgia, serif` until then) | 36–40px / 700, one line, `#FFFFFF` |
| Tagline — "The goal is NOT to PROVIDE ANSWERS. The goal is to PROVOKE THINKING." (t/4183; was "Three schools of thought. One map of the argument.") | Serif | 18–20px / 400, `rgba(255,255,255,0.72)`, one or two lines |
| Question | Serif italic | 17–18px / 400 |
| Voice lines | Serif | 15–16px / 400 |
| "Sign in" heading | UI sans | 20px / 600 |
| Buttons | UI sans | 14px / 500 |
| Support text | UI sans | 12–13px / 400, muted |

Copy rules (all strings above are final unless the owner edits):
- Buttons say **"Continue with GitHub / Google / Microsoft"** (what happens, not "Sign in with" three times under a "Sign in" heading).
- Anonymous entry is a full-width **text button**, not a boxed peer of the providers: "Browse without an account".
- The caveat is an offer, not a warning: "Read-only: explore the full taxonomy and debate archive. Sign in to run debates and edit."
- Trouble link keeps its current behavior, drops to 12px muted at the card's bottom: "Trouble signing in? Clear session and retry".

## 6. The sign-in card

- Paper panel content column: max-width 360px, centered vertically.
- Provider buttons: 44px height, full column width, `--radius-md` (8px), 1px `rgba(17,26,40,0.15)` border, white background, brand icon 18px left-aligned with 12px gap, label centered-left. Hover: border darkens, `--shadow-1` equivalent. Focus: 2px focus ring, visible on paper.
- Order stays GitHub / Google / Microsoft (current analytics say GitHub leads for this audience; owner may reorder).
- Divider: hairline with centered "or", 12px muted.
- No card-within-card: the paper panel IS the surface; the buttons sit directly on it.

## 7. Motion (one orchestrated moment)

Page load only, 600ms total, then everything is still:
1. Eyebrow, project title, and tagline fade in together (150ms).
2. Question fades in (150ms, +100ms delay).
3. The three voices fade in **staggered 120ms apart**, in speaking order (Accelerationist, Safetyist, Skeptic). The stagger is the point: the specimen *takes turns*, the way the product does.
4. Paper panel fades in alongside step 1 (the door is never gated by the ornament).

`prefers-reduced-motion: reduce`: everything renders instantly. No hover animation beyond the button border/shadow change. Nothing loops.

## 8. Accessibility and quality floor

- All interactive elements ≥44px hit area; visible focus ring on paper and jacket surfaces.
- Jacket text contrast: headline 15.5:1, voice lines ≥8:1 at the specified opacities on #111a28; camp names verified per §4.
- The specimen is presentational: `aria-hidden` is NOT used (it is real content), but it sits after the sign-in landmark in DOM order so keyboard and screen-reader users reach the door first. Visual order differs from DOM order via the flex layout; test with a screen reader that the experience is "sign in options, then the product statement."
- The page works with images/fonts blocked: system serif fallback, no image assets at all (glyphs/dots are CSS or inline SVG).

## 9. What NOT to do

- No background photography, gradients, particles, or animated network graphs.
- No live data on the login. The specimen is static copy.
- No logo lockups beyond the text eyebrow (there is no approved logo asset).
- No theme switcher on the login; it inherits nothing and offers nothing but the door.
- Do not gate login actions on the load animation; buttons are interactive from first paint.

## 10. Integration points

| File | Change |
|---|---|
| Login page component (web build) | Split layout, jacket + paper panels, specimen block, revised card |
| `styles.css` (or `login.css` split) | `.login-jacket`, `.login-paper`, `.login-specimen`, `.login-voice` rules; tokens where available |
| No new assets | Brand icons already exist; camp dots are CSS until CampGlyph (elevation §4) ships, then swap in glyphs |
| Auth logic | **Unchanged.** Same providers, same anonymous flow, same trouble/clear-session behavior |
