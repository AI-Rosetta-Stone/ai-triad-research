# Incident Response

The full rules behind root `AGENTS.md` → "Incident Response". This text moved out of the root file unchanged, to cut the instruction tokens every agent loads every session. It is still binding. Read it when you join an incident, diagnose a production or CI failure, or file or close a follow-up. Rationale: `docs/agent-rules-reference.md` (Ref §7).

- **The TL coordinates** (`/tl-incident-response`), and the anchor ticket is the source of truth. Claim a follow-up on the anchor before filing it, and before any shared-tree write.
- **Every diagnosis files two follow-ups:** **Observability** (make it diagnosable next time) and **Prevention** (an automated check, test or platform fix, mapped to a failure class in `docs/CodeReview/failure-classes.md`). Gate-touching prevention goes to TL Gate Verification.
- **When a failure class recurs, validate the baseline against design intent.**
- **Before closing a prevention,** name one way the class could still occur through ordinary use with the mechanism intact. If you can name one, you closed a *vector*, not the class: say so and file the remainder. Ref §7.
