# Incident Response

The full rules behind root `AGENTS.md` → "Incident Response". This text moved out of the root file unchanged, to cut the instruction tokens every agent loads every session. It is still binding. Read it when you join an incident, diagnose a production or CI failure, or file or close a follow-up. Rationale: `docs/agent-rules-reference.md` (Ref §7).

- **The TL coordinates** (`/tl-incident-response`), and the anchor ticket is the source of truth. Claim a follow-up on the anchor before filing it, and before any shared-tree write.
- **Every diagnosis files two follow-ups:** **Observability** (make it diagnosable next time) and **Prevention** (an automated check, test or platform fix, mapped to a failure class in `docs/CodeReview/failure-classes.md`). Gate-touching prevention goes to TL Gate Verification.
- **When a failure class recurs, validate the baseline against design intent.**
- **Before closing a prevention,** name one way the class could still occur through ordinary use with the mechanism intact. If you can name one, you closed a *vector*, not the class: say so and file the remainder. Ref §7.
- **Suspected staging compromise:** rotate the GitHub, Google and Entra OAuth client secrets (staging shares prod's, by PI accepted risk t/92, review 2027-02-25) as an immediate step.

## Incident fast lane: make room in the CI line (t/705)

One CI run creates 44 to 59 jobs against a limit of about 60, so an incident fix's checks can wait behind every other PR's run. `node operations/devops/ci-make-room.mjs` lists the queued and in-progress `pull_request` runs of `ci.yml` whose head branch is not `incident/*` (PR, branch, age, job count). It lists only, and cancels nothing, unless the **Tech Lead** says go: `--cancel --incident=t/N --by=<the TL's collaborator id>`. It never touches `merge_group`, push, schedule or dispatch runs, any other workflow (the guards), or an `incident/*` run, and it prints each run it cancelled with the command that re-runs it (`gh run rerun <id> --repo <repo>`), so re-run them when the incident PR has landed. The script cannot check that `t/N` is an open INCIDENT ticket or that `--by` is the TL: those are the TL's go, recorded in the printed line. If the run list cannot be read, it lists and cancels nothing.

## Prod hotfix path (t/610, t/609)

1. The fix lands on `main` through the merge queue, as an incident PR (`incident/t<N>-<slug>`) for an open ticket titled INCIDENT. `enqueue-pr` accepts it with no budget exemption. A Tech Lead or Security `budget-exempt:` review is only the fallback when the ticket can't be read (t/656).
2. The prod deploy runs from `main`, since the production environment only accepts `main`.
3. DeployAzure posts the what-if from the exact SHA before the PI's go, and stops if it shows any prod resource change beyond the image that the PI has not approved.
4. Any route that deploys from another ref is checked against the environment's deployment-branch policy before it is proposed. Widening that policy is a PI decision.
5. After deploy, the containment is verified anonymously and posted on the incident ticket.
