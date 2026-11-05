# Public Chat Share: Provenance Label

**Ticket:** t/4787 (PI decision on SO K7, t/4787#9) · **Author:** Design (Orca) · **Date:** 2026-11-05
**Applies to:** `PublicChatView` at `/share/chat/:shareId`, plus the share's link-preview metadata.

## Why

The PI accepted client-supplied share content on one condition (K7): every public chat share view carries a **mandatory provenance label**. It says the content came from the person who shared it and **wasn't verified by the site**, including messages shown as a camp or as the assistant. A reader has to see it before reading a single message.

## 1. Wording (final)

**Heading** (bold, one line on desktop):

> **Shared by a user, not verified by AI Rosetta Stone.**

**Body:**

> The person who shared this link supplied every message on this page, including the ones shown as the Accelerationist, Safetyist or Skeptic. This site hasn't checked that they match a real conversation.

- If the projection ever carries an `assistant` speaker, the body says "…including the ones shown as AI Rosetta Stone or as the Accelerationist, Safetyist or Skeptic." Build the list from the speakers actually present, in that order. Never name a camp that isn't in the share.
- No hedging words ("may", "possibly"). The statement is simply true for every share.
- Don't show the sharer's name, email or id. The projection doesn't carry them (R2 and C4), and the label must not imply a verified identity.

**Closing line** (repeated after the last message, small, same tokens):

> Shared by a user, not verified by AI Rosetta Stone.

## 2. Placement

- **First thing in the page content,** above the chat title and mode, full width of the reading column. On first load it's above the fold at every width: at 390px the heading and body together are about 5 lines, well inside an 844px viewport.
- **Static, not sticky.** Sticky would cost a third of a phone screen for the whole read. The closing line after the last message covers a reader who scrolls straight to the end.
- **Not dismissible, not collapsible.** No ×, no "Got it". It's a statement of fact about the page, not a hint.
- **It prints,** with no `@media print` hiding.
- **Never inside a message bubble.** It's page chrome, visually distinct from conversation content, so a crop of one message can't make the label look like part of what someone "said".

```
┌───────────────────────────────────────────────────────┐
│ ▍ⓘ  Shared by a user, not verified by AI Rosetta Stone. │  ← --warning-bg, 4px --warning left border
│ ▍   The person who shared this link supplied every     │
│ ▍   message on this page, including the ones shown as  │
│ ▍   the Accelerationist, Safetyist or Skeptic. This    │
│ ▍   site hasn't checked that they match a real         │
│ ▍   conversation.                                      │
└───────────────────────────────────────────────────────┘
  Should we grant legal personhood to AI agents?     (chat title)
  DECIDE · Accelerationist                            (mode · camp)
  … messages …
  ───────────────────────────────────────────────────
  Shared by a user, not verified by AI Rosetta Stone.   (closing line)
```

## 3. Visual spec

| Property | Value |
|---|---|
| Container | `role="note"`, `aria-label="About this shared conversation"` |
| Background | `--warning-bg` |
| Left border | 4px solid `--warning` |
| Radius and padding | `--radius-md`; `var(--sp-3) var(--sp-4)` |
| Icon | lucide `Info`, 1.1em, `--warning`, `aria-hidden="true"`, top-aligned with the heading |
| Heading | `--text-primary`, weight 600, `--text-sm` |
| Body | `--text-primary`, weight 400, `--text-sm`, line-height 1.5 |
| Closing line | `--text-secondary`, `--text-xs`, centred, `margin-top: var(--sp-6)` above it, after a 1px `--border-color` rule |

**Use `--warning` only for the border and icon, never for text.** It's 4.42:1 on `--warning-bg` in harvard, below text AA.

**Measured contrast** (computed from the theme tokens):

| Theme | Text (`--text-primary` on `--warning-bg`) | Border and icon (`--warning` on `--warning-bg`, 3:1 bar) |
|---|---|---|
| light | 13.92 | 4.68 |
| harvard | 14.22 | 4.42 |
| dark | 14.40 | 7.38 |
| bkc | 11.46 | 6.58 |

## 4. Link previews and metadata

Social cards show content without the page, so the label travels into the metadata too:
- `<title>`: `"<chat title>" (shared conversation, unverified)`.
- `og:description` / `twitter:description` start with: `Shared by a user, not verified by AI Rosetta Stone. `, followed by the existing excerpt, if any.
- `noindex` is already required (SO K2); this doesn't change it.

## 5. Acceptance criteria

1. The label renders on every `/share/chat/:shareId` view, with exactly the §1 wording, as the first element of the content, in `role="note"`.
2. At 1280px and at 390px, the heading **and** body are fully visible on first load without scrolling (a screenshot of each).
3. No control dismisses, collapses or hides it, including in print.
4. The closing line appears after the last message.
5. The camp list in the body matches the speakers present in the share (a test with a one-camp share and one with `assistant`).
6. `<title>` and `og:description` carry the §4 prefixes (a test).
7. Contrast as in §3 in all 4 themes; Design verifies live via `/design-review-workflow`.
