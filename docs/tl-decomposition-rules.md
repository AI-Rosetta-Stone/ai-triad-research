# Work Decomposition Rules (Tech Lead)

> Moved verbatim from `engineering/tech-lead/AGENTS.md` (token-reduction plan, workstream A) so the Tech Lead's always-loaded instructions stay small. Still binding for the Tech Lead when breaking work into tickets.

## Shared utility rule

Shared utility rule: when 2+ agents need the same operation, create a shared utility as a prerequisite ticket that blocks per-agent work. Never let N agents independently implement the same logic

## Transport-with-storage rule

**Transport-with-storage rule:** when a renderer/UI consumes a new server-side read or write, decompose the full transport trio — bridge method + REST route + Electron IPC/preload — not just the storage read path. `resolve_owners_batch` the transport files (`renderer/bridge/*`, `server/routes/*`, `main/ipc/*` + `preload`), not only the store — the renderer cannot reach storage directly. (Phase-2 mention read path missed this: the storage read landed alone, stranding the render node until the `getEntity`-style trio was back-filled — t/1901/1902/1903.) Owner: TL. Review-by: 2027-01-31.

## One PR per feature (t/397, PI-approved 2026-11-11)

**Tickets stay granular; PRs don't.** Tickets still carry ownership, tracking and assignment. But a feature (a parent ticket) lands as **one PR** on one branch, not one PR per child ticket.
- **Landing owner:** when the TL breaks a feature into tickets, the parent ticket names one **landing owner**. That owner opens the feature PR, takes the other owners' commits, and lands it. Other owners push their slices to that branch, or send patches to the landing owner if they can't push.
- **Owners approve their files on the feature PR.** Each owner whose files the PR touches signs off with an `Approved (<Owner>):` review on that same PR, which the t1-approval-guard already reads per role. "Work in another owner's folder is theirs" means **the owner must author or approve it**, not that it needs its own PR.
- **Large features:** a feature over ~600 changed lines may split into 2 PRs, each with its own owners' approvals.

## Interface-First Decomposition

When a shared utility or type is needed by multiple downstream tickets, decide the **types/interfaces first**, before any implementation. Record that decision as a **reviewed design comment on the parent ticket**, not as a separate PR (t/397). Consumers then work in parallel against that contract on the feature branch, rather than waiting on each other. Example: post the `FaultHarness` types as a design comment and get them reviewed. Then the harness implementation and the consumer tests start at once, all landing in the one feature PR.
