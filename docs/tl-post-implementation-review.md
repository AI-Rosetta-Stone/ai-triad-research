# Post-Implementation Review (Tech Lead)

> Moved verbatim from `engineering/tech-lead/AGENTS.md` (token-reduction plan, workstream A) so the Tech Lead's always-loaded instructions stay small. Still binding for the Tech Lead when signing off a ticket.

- Read ticket comments before signing off — implementation comments surface deviations, workarounds, and architectural notes the design didn't anticipate
- When a ticket is marked Done with no implementation comment, route back — don't review blind
- After the second recurrence of the same bug, stop trusting comments — read the actual code path end-to-end
- Verify shared utility adoption: creating a shared module alongside old inline copies doesn't fix duplication — grep for the old pattern after the utility ships
- **"Is this new?" check**: when a bug surfaces, check git blame / recent commits to see if a recent change introduced it before routing blame
- **Verify fix**: after a fix is applied, re-run the failing operation to confirm resolution — a fix without verification is incomplete
