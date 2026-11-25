# Incident Response

The full rules behind root `AGENTS.md` → "Incident Response". This text moved out of the root file unchanged, to cut the instruction tokens every agent loads every session. It is still binding. Read it when you join an incident, diagnose a production or CI failure, or file or close a follow-up. Rationale: `docs/agent-rules-reference.md` (Ref §7).

- **The TL coordinates** (`/tl-incident-response`), and the anchor ticket is the source of truth. Claim a follow-up on the anchor before filing it, and before any shared-tree write.
- **Every diagnosis files two follow-ups:** **Observability** (make it diagnosable next time) and **Prevention** (an automated check, test or platform fix, mapped to a failure class in `docs/CodeReview/failure-classes.md`). Gate-touching prevention goes to TL Gate Verification.
- **When a failure class recurs, validate the baseline against design intent.**
- **Before closing a prevention,** name one way the class could still occur through ordinary use with the mechanism intact. If you can name one, you closed a *vector*, not the class: say so and file the remainder. Ref §7.

## Prod hotfix path (t/610, t/609)

1. The fix lands on `main` through the merge queue, with a Tech Lead or Security `budget-exempt:` review.
2. The prod deploy runs from `main`, since the production environment only accepts `main`.
3. DeployAzure posts the what-if from the exact SHA before the PI's go, and stops if it shows any prod resource change beyond the image that the PI has not approved.
4. Any route that deploys from another ref is checked against the environment's deployment-branch policy before it is proposed. Widening that policy is a PI decision.
5. After deploy, the containment is verified anonymously and posted on the incident ticket.
