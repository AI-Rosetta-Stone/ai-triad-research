# Review Routing & Queue Mechanics

**Status:** Canonical (shared)
**Owner:** Technical Lead
**Last updated:** 2026-10-15

Full mechanics for how implementation reviews are routed, queued, and handled in the multi-agent fleet. The Tech Lead AGENTS.md keeps only the one-line load-bearing routing rule inline and points here for the detail.

## Review Routing — Quality (TL) vs Main (TL)

To reduce review queue bottleneck, **Quality (Tech Lead)** (`quality.engineering-tech-lead@ai-triad-research.orca.local`) handles routine implementation reviews. Route directly to Main (TL) only when escalation criteria are met.

As of 2026-10-15 it is the **only** Quality instance; check `list_instances` (role `engineering/tech-lead`) for the current set. The name "Quality (Technical Lead)" does not resolve, so use the name or address above. If more Quality instances are added, assign round-robin or pick the one with the shortest queue; they share the same scope and escalation rules.

**Route to Quality (Tech Lead):**
- Single-role implementation ticket (all changes within one scope)
- Follows an existing pattern (CRUD endpoint, bridge method, PS cmdlet, test addition, UI-only renderer change)
- No new cross-role interfaces introduced
- No data model changes (taxonomy schema, debate output shape, organization model)
- No auth/security surface changes

**Route to Main (TL) — or Quality reviewer escalates here:**
- Novel architecture (no existing pattern playbook covers it)
- New cross-role interface or shared type changes
- Data model or schema changes
- Auth gate or security surface changes
- ADR creation or amendment
- Conflict between agents requiring arbitration
- Quality reviewer pings Main (TL) when a review exceeds their scope

## Meta-Doc Accuracy Skim — LessonsLearned / AGENTS.md PRs (t/3362, audit G4)

Meta-role output (Sage LessonsLearned batches, Documentation AGENTS.md edits) previously landed
with no second reader — and a wrong "lesson" propagates into every future session's context.

**Rule:** any PR that changes `LessonsLearned.md` or any `AGENTS.md` gets a **Quality-instance
skim before merge**, scoped to **accuracy of the recorded pattern** — does the entry correctly
describe the incident/behavior it cites, and is the prescribed rule the right generalization?
Style, tone, and formatting are explicitly out of scope.

- Route to Quality (Tech Lead), the same as routine reviews.
- The skim is a fast gate (target: same working session), sized to a read-and-confirm, not a
  design review. A finding routes back to the author; Main (TL) arbitrates disputes.
- **Sage batch flow:** to avoid stalling batch landings, Sage may open the batch PR and request
  the skim in parallel with CI — the skim must land as an approving comment before merge, but
  nothing blocks batch *preparation*. Batches with only previously-skimmed, re-worded entries
  may note that and take an expedited confirm.

## Async Review (implement-then-review)

For **low-risk tickets** — single-scope, no new public API, no data model changes, follows a known pattern — agents MAY implement first without waiting for design approval, then submit to a Quality reviewer after the verify gate passes. This lets the agent pick up their next ticket while review is in flight.

**Low-risk qualify criteria (all must be true):**
- All changes within agent's own scope
- No new exports, bridge methods, cmdlets, or REST endpoints
- No schema or data model changes
- No auth surface changes
- Verify gate passes on committed code

**How to use async review:**
1. Begin implementation, noting in the ticket: "Using async review — low-risk criteria met."
2. Commit code, run verify gate, note SHA.
3. Ping a Quality reviewer with the ticket key.
4. Pick up next ticket. If reviewer requests changes, fix before that ticket's Done transition.

Agents must NOT use async review for novel architecture, cross-scope work, or anything a self-cert playbook explicitly excludes.

## Review Queue Mechanics (required for all design reviews)

When a worker posts a design and routes it for Quality review, they must do **three things** — not just ping:

1. **Transition the ticket to "In Review"** status.
2. **Reassign the ticket to the Quality instance receiving the review** (`Quality (Tech Lead)`, or round-robin if more Quality instances exist). This is the queue: `list_tickets(all: false)` on a Quality instance returns only tickets assigned to it.
3. **Ping** Quality with the ticket ref.

Quality instance on receiving a review:
- Picks it up via `list_tickets(all: false)` at session start (standard queue check).
- Posts review comment on the ticket.
- **Reassigns the ticket back to the worker** and pings them.

**Why this matters:** without reassignment, Quality instances have an invisible queue and no mechanism to notice stalled reviews. A ping can be missed when a session context expires; a ticket assigned to you cannot.
