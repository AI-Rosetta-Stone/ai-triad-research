# Work Decomposition Rules (Tech Lead)

> Moved verbatim from `engineering/tech-lead/AGENTS.md` (token-reduction plan, workstream A) so the Tech Lead's always-loaded instructions stay small. Still binding for the Tech Lead when breaking work into tickets.

## Shared utility rule

Shared utility rule: when 2+ agents need the same operation, create a shared utility as a prerequisite ticket that blocks per-agent work. Never let N agents independently implement the same logic

## Transport-with-storage rule

**Transport-with-storage rule:** when a renderer/UI consumes a new server-side read or write, decompose the full transport trio — bridge method + REST route + Electron IPC/preload — not just the storage read path. `resolve_owners_batch` the transport files (`renderer/bridge/*`, `server/routes/*`, `main/ipc/*` + `preload`), not only the store — the renderer cannot reach storage directly. (Phase-2 mention read path missed this: the storage read landed alone, stranding the render node until the `getEntity`-style trio was back-filled — t/1901/1902/1903.) Owner: TL. Review-by: 2027-01-31.

## Interface-First Decomposition

When a shared utility or type is needed by multiple downstream tickets, always create a standalone prerequisite ticket for the **types/interfaces only** (not the full implementation). This unblocks all consumers to work in parallel against the interface contract, rather than forcing sequential execution. Example: ship `FaultHarness` types as ticket A, then harness implementation (ticket B) and consumer tests (tickets C, D) can all start immediately after A.
