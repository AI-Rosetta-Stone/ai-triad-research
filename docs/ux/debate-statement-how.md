# Per-statement HOW: Layout A

Status: approved layout (human, 2026-11-23), amended 2026-11-24: Planned moves show their text; Convergence is removed. Amended 2026-11-25: the Convergence pill leaves the pill row (human, p/109#5). Owner: Design. Build: DebateWorkspace.
Reference: the Openings How → Plan claim map (t/331, #5073; fixes #5127 and t/421).
Data source: DebateWorkspace measurements over 327 debate sessions, 2,779 statements (t/469, p/14#40 to #44).

## Goal

The per-statement HOW uses the same card vocabulary as the Openings HOW: an eyebrow, a counts line,
a claim-and-attack grid, assumption cards and a More disclosure. The data differs, so the layout
adapts to it.

## Data this layout relies on

| Element | Source | Coverage |
|---|---|---|
| Claims | argument-network nodes filtered by `source_entry_id` | 96% of statements have at least one node. Median 3 per statement, max 6 |
| Attacks and supports | incoming `attacks` and `supports` edges on a claim node | Attacks median 1 per statement, max 21. Supports median 0, max 14 |
| Focus | `metadata.focus_point` | 2,772 statements |
| Planned moves | `metadata.move_types`, `[{move, target?, detail}]` | 2,771 statements |
| Assumptions | `metadata.key_assumptions`, `[{assumption, if_wrong}]` | 1,641 statements (59%) |
| Anticipated responses | `metadata.anticipated_responses`, sentences | 158 statements (6%) |
| Vocabulary | vocabulary resolutions | Hidden when empty. Lineage is not measured and stays out until it is |

Not used: `summaries.brief` (generated, not the speaker's plan), and the response fields
`directive_response`, `challenge_response`, `probe_response`, `pin_response`, `check_response`. Those
answer moderator and check prompts, not anticipated objections.

Convergence is not part of this layout. The convergence signals are not shown in the HOW body.

No statement has a plan stage, a thesis or a `work_product`. The Openings PLAN, Planned Moves, Argument
Sketch and Anticipated Responses sections therefore do not exist per statement. The statement equivalents
are shown under their own names, below.

## Layout

```
┌ SPEAKER · STATEMENT ──────────────── 4 claims · 2 attacks · 3 supports ┐
│ Focus: what the speaker must answer                    (if present)    │
│ Planned moves                                          (if present)    │
│  DISTINGUISH → AN-12   Differentiate passive protocols from …          │
│  BURDEN SHIFT          Demand that opponents …                         │
└────────────────────────────────────────────────────────────────────────┘
┌ AN-34 ──────────────────────┐ ┌ AN-34 ATTACKED by Safetyist AN-42 ─────┐
│ Claim point                 │ │ Attack text                            │
│ Evidence · …                │ │ [Unverified]                           │
└─────────────────────────────┘ └────────────────────────────────────────┘
┌ AN-35 ──────────────────────┐ ┌ AN-35 SUPPORTED by Skeptic AN-39 ──────┐
│ …                           │ │ …                                      │
└─────────────────────────────┘ └────────────────────────────────────────┘
┌ ASSUMPTIONS ──────────────────────────────────────────────────────────┐
│ assumption                                                             │
│ If wrong: …                                  (one card per item)       │
└───────────────────────────────────────────────────────────────────────┘
┌ ANTICIPATED RESPONSES ────────────────────────────────────────────────┐
│ "Safetyist will argue X. I counter Y."                                 │
└───────────────────────────────────────────────────────────────────────┘
┌ VOCABULARY ───────────────────────────────────────────────────────────┐
│ term card · term card                                                  │
└───────────────────────────────────────────────────────────────────────┘
```

### Header card

- Eyebrow: `SPEAKER · STATEMENT`, uppercase, `--text-2xs`, as on Openings.
- Counts line: `n claims · n attacks · n supports`. Zero terms are omitted.
- No headline. Statements have no thesis.
- Focus: one line under the header, labelled `Focus`. It states what the speaker must answer. It is not
  labelled "Argument sketch".
- Planned moves: a heading line, `Planned moves`, then one block per move. Each block has two lines, at every
  width: the move name as a chip on its own line, then the move's full `detail` text underneath, at body size.
  The text is never truncated and never hidden behind hover or focus. It is not placed beside the chip, at
  any width. If the move has a `target` that is an argument-network id, the chip links to that claim. Move
  names are free text, so style every chip the same.
- Each element is hidden when its field is absent.

### Claim grid

- The Openings two-column pattern: claim card left, its attacks and supports right.
- Claim labels are the argument-graph node ids, such as `AN-34`, not positions (`C1`, `C2`). A claim keeps its
  id across statements and matches the ids the planned moves refer to. Claim card: the id badge, claim text,
  `Evidence ·` line when present, and the anchor chip as on Openings.
- **Fallback id:** not every claim node is `AN-n`. About 2% are `D-n` or `user-seed-n`. Show such an id as it
  is. Do not reformat or renumber it.
- **Speaker:** the attacking or supporting node's own speaker, read from its `source_entry_id` entry. Only
  about half of attacks come from a POV speaker (Accelerationist, Safetyist, Skeptic). The rest come from
  other speaker values, or from a `system` entry. The label shows the speaker only for POV speakers. For any
  other value, omit the speaker: `AN-34 ATTACKED by AN-42`. This keeps the label from naming a non-debater.
- Each attack and support card leads with its pair: `AN-34 ATTACKED by Safetyist AN-42` or
  `AN-34 SUPPORTED by Skeptic AN-39`. The first id is the claim it targets. The second is the attacking or
  supporting node. The eyebrow stays in capitals so the verb scans.
- Attack card: warning tint, that eyebrow, attack text, and a status pill. The status reads `Unverified`
  until a verdict exists. Never colour alone.
- Support card: neutral surface, `AN-{claim} SUPPORTED by {speaker} AN-{source}` eyebrow, with the speaker
  rule above.
- A claim with no attacks shows the dashed `No attack mapped to AN-{claim}` slot, as on Openings.
- Open: whether the attack and support cards sit to the right of the claim, as now, or to its left. The
  request asks for the attacker's label to the left of the claim number. This spec keeps claim left, as on
  Openings, until the human says otherwise.
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

### Vocabulary

- Card list at the bottom, in the assumption-card pattern.
- Hidden when empty. No empty heading.

### Pills

- The Reasoning, Claims and Vocabulary pills keep their meaning and remain the switch.
- The HOW body is one scroll under the pills.
- The Convergence pill is removed from the pill row (human, 2026-11-25, p/109#5). The row is Reasoning,
  Claims and Vocabulary, in that order. A pill with no body is a dead control.

## Shared rules

- Reuse the Openings tokens. No hard-coded font sizes or colours. The t/331 headline and legend fixes
  apply.
- Status and attack type are text, never colour alone.
- Contrast: check each new surface in harvard, dark, bkc and light.
- Keyboard: the `Show N more` control and each anchor chip are buttons, reachable in tab order.
- Empty states keep the existing copy: "No argument network yet", "No claims extracted for this
  statement".

## Out of scope

- The steelman link and the verified count (t/329#4; t/388 steps 3 and 4).
- The Openings view. It stays as it is.
- Lineage, until a statement in the corpus yields lineage names.
- Convergence: the section was removed 2026-11-24, and its pill 2026-11-25.
- Layout B. It is the fallback if live data turns out to resemble the calibration batches.

## Open questions

None. The Convergence pill question was answered yes on 2026-11-25 (p/109#5).

## Evidence needed before build sign-off

- Static renders of the real component, harvard and dark, 1280px and 390px, for: a typical statement
  (1 attack), a statement with a heavy claim (the collapse control), a statement with no attacks, and a
  statement with Focus, Planned moves with their detail text, Assumptions and Anticipated responses all
  present.
- Screenshots are required for `Approved (Design)` on the implementing PR.
