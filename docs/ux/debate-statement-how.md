# Per-statement HOW: Layout A

Status: approved layout (human, 2026-11-23). Owner: Design. Build: DebateWorkspace.
Reference: the Openings How → Plan claim map (t/331, #5073; fixes #5127 and t/421).
Data source: DebateWorkspace measurements over 327 debate sessions, 2,779 statements (t/469, p/14#40 to #44).

## Goal

The per-statement HOW uses the same card vocabulary as the Openings HOW: an eyebrow, a counts line,
a claim-and-attack grid, lens cards, assumption cards and a More disclosure. The data differs, so the
layout adapts to it.

## Data this layout relies on

| Element | Source | Coverage |
|---|---|---|
| Claims | argument-network nodes filtered by `source_entry_id` | 96% of statements have at least one node. Median 3 per statement, max 6 |
| Attacks and supports | incoming `attacks` and `supports` edges on a claim node | Attacks median 1 per statement, max 21. Supports median 0, max 14 |
| Convergence | convergence row, seven signals | 60% of statements. All seven present as fields on every row. `dominant_counterargument` is null when there is none |
| Focus | `metadata.focus_point` | 2,772 statements |
| Planned moves | `metadata.move_types`, `[{move, target?, detail}]` | 2,771 statements |
| Assumptions | `metadata.key_assumptions`, `[{assumption, if_wrong}]` | 1,641 statements (59%) |
| Anticipated responses | `metadata.anticipated_responses`, sentences | 158 statements (6%) |
| Vocabulary and lineage | vocabulary resolutions and lineage terms | Not measured. Hidden when empty |

Not used: `summaries.brief` (generated, not the speaker's plan), and the response fields
`directive_response`, `challenge_response`, `probe_response`, `pin_response`, `check_response`. Those
answer moderator and check prompts, not anticipated objections.

No statement has a plan stage, a thesis or a `work_product`. The Openings PLAN, Planned Moves, Argument
Sketch and Anticipated Responses sections therefore do not exist per statement. The statement equivalents
are shown under their own names, below.

## Layout

```
┌ SPEAKER · STATEMENT ──────────────── 4 claims · 2 attacks · 3 supports ┐
│ Focus: what the speaker must answer                    (if present)    │
│ Planned moves: [DISTINGUISH → AN-12] [BURDEN SHIFT]    (if present)    │
└────────────────────────────────────────────────────────────────────────┘
┌ C1 ─────────────────────────┐ ┌ ← ATTACK ON C1 ────────────────────────┐
│ Claim point                 │ │ Attack text                            │
│ Evidence · …                │ │ [Unverified]                           │
└─────────────────────────────┘ └────────────────────────────────────────┘
┌ C2 ─────────────────────────┐ ┌ SUPPORTS C2 ───────────────────────────┐
│ …                           │ │ …                                      │
└─────────────────────────────┘ └────────────────────────────────────────┘
┌ ASSUMPTIONS ──────────────────────────────────────────────────────────┐
│ assumption                                                             │
│ If wrong: …                                  (one card per item)       │
└───────────────────────────────────────────────────────────────────────┘
┌ ANTICIPATED RESPONSES ────────────────────────────────────────────────┐
│ "Safetyist will argue X. I counter Y."                                 │
└───────────────────────────────────────────────────────────────────────┘
┌ CONVERGENCE ──────────────────────────────────────────────────────────┐
│ [polarity] [engagement] [redundancy] [counterargument] [concession]    │
│ [drift] [crux]                              (lens-card grid)          │
└───────────────────────────────────────────────────────────────────────┘
┌ VOCABULARY · LINEAGE ─────────────────────────────────────────────────┐
│ term card · term card                                                  │
└───────────────────────────────────────────────────────────────────────┘
```

### Header card

- Eyebrow: `SPEAKER · STATEMENT`, uppercase, `--text-2xs`, as on Openings.
- Counts line: `n claims · n attacks · n supports`. Zero terms are omitted.
- No headline. Statements have no thesis.
- Focus: one line under the header, labelled `Focus`. It states what the speaker must answer. It is not
  labelled "Argument sketch".
- Planned moves: chips, one per move, each showing the move name and its detail on hover or focus. Move
  names are free text, so style every chip the same. A `target` that is an argument-network id is linked to
  its claim.
- Each element is hidden when its field is absent.

### Claim grid

- The Openings two-column pattern: claim card left, its attacks and supports right.
- Claim card: `C{n}` badge, claim text, `Evidence ·` line when present, and the anchor chip as on Openings.
- Attack card: warning tint, `← ATTACK ON C{n}` eyebrow, attack text, and a status pill. The status reads
  `Unverified` until a verdict exists. Never colour alone.
- Support card: neutral surface, `SUPPORTS C{n}` eyebrow.
- A claim with no attacks shows the dashed `No attack mapped to C{n}` slot, as on Openings.
- **Collapse rule:** a claim shows its first three attacks or supports. A `Show N more` control reveals the
  rest. The collapse is per claim, so one heavy claim does not push the rest down. Most claims stay whole;
  DebateWorkspace measured attacks at 0 or 1 per claim in most cases.
- At under 767px the claim card and its attacks stack vertically, as on Openings.

### Assumption cards

- One card per `key_assumptions` item, in the Openings assumption-card pattern.
- Eyebrow: `ASSUMPTION`. Body: the assumption. A second line: `If wrong: …`, from `if_wrong`.
- Every item has `if_wrong`, so both lines always render.

### Anticipated responses

- A disclosure, `Anticipated responses (n)`, open by default, listing each sentence as a bullet. Each
  sentence is the speaker's own anticipated objection, of the form "X will argue Y. I counter Z."
- Use the disclosure pattern rather than a card, because the list is text and can be long. Do not style
  these as attacks; they are not attached to a claim node.

### Convergence

- Seven labelled cells in a lens-card grid: two columns at desktop, one under 767px. Label above, value below.
- When the row is absent, show the existing copy: "No convergence data for this turn."
- A null `dominant_counterargument` shows as "None" in its cell. It is not an error.

### Vocabulary and lineage

- Card list at the bottom, in the assumption-card pattern.
- Hidden when empty. No empty heading.

### Pills

- The existing Reasoning, Claims, Convergence and Vocabulary pills keep their meaning and remain the switch.
- The HOW body is one scroll under the pills.

## Shared rules

- Reuse the Openings tokens. No hard-coded font sizes or colours. The t/331 headline and legend fixes
  apply.
- Status and attack type are text, never colour alone.
- Contrast: check each new surface in harvard, dark, bkc and light.
- Keyboard: the `Show N more` control and each anchor chip are buttons, reachable in tab order.
- Empty states keep the existing copy: "No argument network yet", "No claims extracted for this
  statement", "No convergence data for this turn."

## Out of scope

- The steelman link and the verified count (t/329#4; t/388 steps 3 and 4).
- The Openings view. It stays as it is.
- Layout B. It is the fallback if live data turns out to resemble the calibration batches.

## Evidence needed before build sign-off

- Static renders of the real component, harvard and dark, 1280px and 390px, for: a typical statement
  (1 attack), a statement with a heavy claim (the collapse control), a statement with no attacks, a
  statement with convergence absent, and a statement with Focus, Planned moves, Assumptions and
  Anticipated responses all present.
- Screenshots are required for `Approved (Design)` on the implementing PR.
