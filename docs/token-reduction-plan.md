# Token Reduction Plan for Code Development

**Status:** Draft for PI review. **Author:** Main (Claude), 2026-11-06. **Scope:** tokens spent by development agents working in this repo. Runtime LLM spend by the product (debates, summaries) is out of scope.

## 1. Where the tokens go today

Measured on the shared checkout and the Orca activity log for 2026-10-23 to 2026-11-06. No token telemetry exists yet, so the sizes below are inputs, not spend.

| Source | Measured | Why it costs |
|---|---|---|
| Per-role `AGENTS.md` (35 files, overlay repo) | 14,951 words total; Tech Lead alone 1,792 | Loaded every turn for that role. Not covered by the CI size ratchet, which only sees the two main-repo files. |
| Root `AGENTS.md` | 769 words, budget 1,727 | Already ratcheted. Fine. |
| Binding docs chain from root `AGENTS.md` | ~21,000 words across 13 docs | `agent-rules-reference.md` 4,219, `shared-tree-divergence.md` 3,782, `git-and-session-workflow.md` 2,480. A landing cycle that obeys "read the doc first" reads 8k to 12k words of procedure per PR. |
| `docs/LessonsLearned.md` | 1.1 MB, 414 entries, one file, no index | Any agent that opens it instead of grepping it burns roughly 280k tokens. |
| Skill descriptions in the system prompt | ~50 skills | The two drift-check skills alone carry multi-sentence descriptions that every agent pays for on every turn, though only a daily reminder invokes them. |
| MCP tool surface | Orca ~150 tools, electron-mcp ~60, Chrome ~20, debate 5 | Deferred, so only names load, but electron-mcp is enabled workspace-wide when only the taxonomy-editor roles drive the app. |
| Orca MCP calls | 33,929 in 14 days | `send_ping` 4,614, `add_comment` 2,871, `update_status` 2,598, `get_ticket` 2,570. Ticket bodies and comment threads are the largest per-call payloads. |
| Stale worktrees | 10 in `.worktrees/`, 2 in `.claude/worktrees/`, each a full tree with `node_modules` | Repo-wide Glob and Grep time out at 20 s. Every timeout is a wasted call plus a retry, and `find` runs drift into the background. |
| Test output | `vitest run` default reporter; Pester default output | Prints every passing test name. A full suite dumps thousands of lines into context to report zero failures. |
| Review fan-out | TL instructions spawn up to 7 review subagents per PR | Each subagent reloads instructions and the diff. Applied regardless of tier. |
| Rework after context loss | Lessons #69, #162 | Duplicate PRs and re-driven commits are the largest hidden cost. Rules exist, enforcement is manual. |
| Root directory clutter | 20 `taxonomy-proposal-pass-*.json`, 3 `.pptx`, misc experiment files | Inflates every `ls` and every `git status` an agent runs. |

Unverified: `.claude/settings.json` (12 KB) is permission-denied to agents, so its hooks and their per-call output are not accounted for here. Feedback-rule injection sizes could not be listed because the Orca server was restarting.

## 2. Measure first

1. Turn on Claude Code's OpenTelemetry token export for one week with no other changes. Record input, output and cache-read tokens per role and per ticket. Owner: DevOps. Tier T0.
2. Add `tokens_per_merged_pr` to the weekly metrics the Historian already records. This is the headline number for the plan.
3. Re-run the same export after each workstream lands. A workstream that does not move the number gets reverted or dropped.

## 3. Workstreams

Ordered by expected return per hour of work. Each item names an owner role and a change tier.

### A. Always-on context diet (TL, T1)

- The overlay-repo `AGENTS.md` files already have a budget file (`.orca/agent-instruction-budgets.json`, t/4329) and a checker (`operations/devops/worker/agents-md-overlay-budget.mjs`). Re-seed it after each cut and run it from an overlay post-commit hook. The hook added on 2026-11-06 lives in the unversioned `.orca-git/hooks/`, so DevOps should version it. Cut the five largest files by 30 percent.
- Factor the 18 `## Scope`, 17 `## Conventions` and 9 `## Testing` sections. Anything repeated across role files moves to one shared doc that roles reference by path.
- Shorten the `feedback-rule-drift-check` and `skill-drift-check` skill descriptions to one line each. Their bodies carry the detail and load only when invoked.
- Scope `electron-mcp` to the taxonomy-editor roles in the overlay config instead of the workspace root.
- Audit every enabled feedback rule's injected text length. A rule that fires on every `PreToolUse` must inject under 40 words.

### B. Filesystem and search hygiene (DevOps, T0)

- Remove merged worktrees weekly: `git worktree prune` plus deletion of any clean `.worktrees/<name>` whose branch has a merged PR. Squash merges defeat `git branch --merged`, so check `gh pr list --state merged --head <branch>` instead. The first run on 2026-11-06 removed 2 of 89 for this reason. Recorded in `docs/maintenance-schedule.md`.
- Confirm `.worktrees/` and `.claude/worktrees/` are in `.gitignore` so ripgrep skips them, and add a `.rgignore` at the root covering `node_modules`, `build`, `tmp`, `citeonly-logs`, `taxonomy-snapshot`.
- Move the root `taxonomy-proposal-pass-*.json`, `taxonomy-proposal-session.json` and experiment files into `tmp/` or `docs/archive/`, and the `.pptx` decks into `docs/`.

### C. Output-size discipline (TL for TS, scripts owner for PS, T0)

- Add `test:agent` scripts: `vitest run --reporter=dot` in `taxonomy-editor` and `lib`, and a `-Output Minimal` default in `Invoke-BoundedTestRun.ps1`. Update `docs/dev-commands-and-testing.md` so the agent-facing command prints failures only.
- Add a rule to root `AGENTS.md` under Tokens. Read CI logs with `gh run view --log-failed`, never `--log`. Pipe long command output through `head`, `tail` or `grep` before it reaches context.
- Agents reporting test results quote the summary line, not the run.

### D. Reference docs on demand (Documentation role, T1)

- Split `LessonsLearned.md` into `docs/lessons/NNN-slug.md` with a generated `docs/lessons/INDEX.md` holding one line per entry: number, category, title. Agents grep the index and read one file. Keep the old path as a one-paragraph redirect so existing links resolve.
- Replace the "read the doc first" chain for landing with a one-screen checklist embedded in the `/land-from-worktree` skill. `pr-landing.md`, `change-tiers.md` and `review-routing.md` stay as the authority but are read only on an exception.
- Add a 10-line summary block at the top of `agent-rules-reference.md` and `shared-tree-divergence.md`. Most readers need the rule, not the incident history.

### E. Ticket and ping payload discipline (PM, T0)

- Ticket comments carry a decision, a link and a hash. Diffs, logs and transcripts go in attachments, never in the comment body.
- Prefer `search_tickets` with a field filter over `get_ticket` when only status or owner is needed. Check whether `get_ticket` can limit comment depth and document the parameter if so.
- Pings reference `t/KEY` and `p/N#M`, never inline the entity. This is already a rule in root `AGENTS.md`. Add a feedback rule that warns on a ping body over 120 words.

### F. Tier the review fan-out (TL, T1)

- T0 changes get one reviewer subagent, the language-specific one.
- T1 changes add `error-handling-auditor` and, when auth or input handling changes, `security-reviewer`.
- T2 keeps the full parallel set plus Second Opinion.
- Reviewer subagents receive the diff and the relevant playbook, not the whole repo map or role instructions.

### G. Cheap session resume (all roles, T0)

- Generalize the `scripts/LAST_SESSION.md` pattern. Every role keeps a `LAST_SESSION.md` of under 300 words in its role directory, tracked in the overlay repo. On resume the agent reads it, then `gh pr list --state all --search t/KEY`, before anything else.
- This is the direct fix for Lessons #69 and #162, which are the single largest avoidable spend.

## 4. Sequencing

| Week | Work |
|---|---|
| 1 | Measure (section 2). Land B and C, which are T0 and need no design. |
| 2 | Land A and E. Re-measure. |
| 3 | Land D and F. These touch process, so they go through TL design review. |
| 4 | Land G. Final measurement against the week-1 baseline. Write the outcome to `docs/LessonsLearned.md` or its successor. |

The target is a 35 percent reduction in tokens per merged PR by the end of week 4. If week-2 measurement shows under 10 percent from A to C and E, stop and re-examine the baseline before spending on D and F.

## 5. Status as of 2026-11-06

Landed the same day the plan was written, by Main subagents on the models the instructions doc assigns.

| Item | Where |
|---|---|
| Plan and per-agent instructions | PR #4625 |
| B: search ignore list, root clutter, prune schedule, telemetry setup doc | PR #4626 |
| D: lessons index generator, `docs/lessons/INDEX.md`, summary blocks | PR #4627 |
| F: Tech Lead rules moved to `docs/tl-*.md`, file cut 1,792 to 1,247 words, tiered fan-out | PR #4629 and overlay commit `f813cfe` |
| C: `test:agent`, Pester minimal output, `--log-failed` rule | PR #4631 |
| A and G: Tokens block in all 35 role files, 35 `LAST_SESSION.md` files, overlay budgets re-seeded | overlay commits `dec819a` through `e1a09bf` |

Still open, each blocked on an Orca-launched agent or the PI:

- Model and effort changes (instructions doc section 2). Ready as Orca MCP calls and a YAML patch in the authoring session's scratchpad. Orca write tools refuse a plain Claude Code session.
- E: the ping-length feedback rule, same blocker.
- Skill description trims for the two drift-check skills, same blocker.
- OpenTelemetry token export, which needs `.claude/settings.json` (`docs/token-telemetry-setup.md`).
- Physical split of `docs/LessonsLearned.md`, deferred to Sage.

## 6. Decisions reserved for the PI

- Model routing by role is a spending decision. The workspace default is `claude-sonnet-4-6`, Main runs `claude-opus-4-8`. This plan does not change either.
- Deleting or archiving anything in `docs/archive/` or the data repo is out of scope.
- Any item above that turns out to need a feedback-rule change in a role the PI owns.
