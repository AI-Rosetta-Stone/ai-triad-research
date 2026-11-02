# Instance Claiming (claim-before-work)

Relocated from `AGENTS.md` (t/4763, a token-reduction pass) so the always-on instructions stay
lean. The short version remains in `AGENTS.md`; this is the full procedure.

The Rosetta Stone role has multiple instances (Main + peers). Work routed to the *role* is
visible to all of them; two instances starting the same ticket wastes work (t/2343, t/2348).
Before designing, worktree-ing, or editing any file for a ticket:

1. **Claim atomically.** `get_ticket` first. If unstarted and (unassigned or assigned to your
   instance): `assign_ticket` to **your own instance address** + `transition_ticket` → In
   Progress, *then* start. In-Progress + instance-assignee is the lock. **Residual race:**
   `assign_ticket` is last-writer-wins, not a true compare-and-swap, so two instances can both
   claim in the same instant. Right after claiming, re-`get_ticket`; if the assignee is *not*
   you (someone else's claim landed after yours) → **stand down** and ping them. This closes
   the sub-second overlap the lock otherwise leaves open.
2. **Stand down on a taken ticket.** If already In Progress, Done, or assigned to a *different*
   instance → do not start; ping the assignee/TL.
3. **Assign to an instance, not the role.** Peers never start a ticket assigned to another
   instance or bare "Main." Routers/TL: prefer a specific instance address, and `get_ticket`
   before (re)assigning to confirm it isn't already In Progress/Done.

Advisory backstop: the profile-scoped `claim-before-work` Instant Feedback rule injects this
reminder at edit time, but a hook can't read ticket state — this document is the real contract.
