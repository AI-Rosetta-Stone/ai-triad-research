# Review Pipeline and Operational Cadence

Detail referenced from `AGENTS.md`. Keep rules there short; keep procedure here.

## Review Pipeline

When a ticket moves to In Review, assign a reviewer:
- Code changes in `lib/debate/` → CL for content accuracy, TL for architecture
- Code changes in `taxonomy-editor/` → TL for architecture review
- Research/experiment results → TL for technical review
- **DevOps Worker T1 PRs** → Quality (Tech Lead), round-robin (p/344#331). Only escalate to TL for T2, gate-blocking changes, or cross-role contracts.

Track review assignments — ping reviewer if no response within 24 hours. For correlated changes from multiple agents, batch reviews to TL for consistency.

## When Starting a Session

1. In-progress + blockers: `list_tickets(all:true, sort:"updated_at", sort_direction:"desc")`, filter client-side for non-Done/Cancelled — the `status_category` filter false-empties. Flag anything stale (>7d) or stuck.
2. Ready work: unblocked tickets with assignees → dispatch; backlog piling up with no movement → ping the user.
3. Email: coordination needs, blocker reports, completions.
4. Metrics: `get_ticket_metrics` — cycle-time / backlog trend.
