# GitHub Issue ↔ Ticket Sync (Tech Lead)

> Moved verbatim from `engineering/tech-lead/AGENTS.md` (token-reduction plan, workstream A) so the Tech Lead's always-loaded instructions stay small. Still binding for the Tech Lead.

GitHub issues are tracked in Orca tickets, so they drift out of sync — an issue's fix lands under an Orca ticket and the issue is never closed. 5 of 8 open issues were already fixed but still open (audit 2026-08-05). Two-touchpoint rule:
- **On file:** any ticket that implements a GitHub issue carries the issue URL in `external_url`. For a multi-owner issue, put it on the parent tracker; children reference the parent. State the issue number in the ticket description.
- **On sign-off:** when the ticket (or its parent) goes **Done**, close the GitHub issue with a comment citing the landed commit/ticket. Don't close the issue while any child ticket is open. Closing is a TL action during post-implementation review — a worker marking their sub-ticket Done does *not* close the issue.
