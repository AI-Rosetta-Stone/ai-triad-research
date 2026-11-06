# Token Reduction: Per-Agent Instructions and Model Assignments

**Status:** Draft for PI decision. **Author:** Main (Claude), 2026-11-06. **Companion to:** `docs/token-reduction-plan.md`.

Model choice and spending are PI decisions under `docs/change-tiers.md`. Nothing here changes a config until the PI approves section 2. The per-agent instructions in section 3 are role-file edits (overlay repo, `ogit`) and go through the Tech Lead as T1.

## 1. Models available and what they cost

Prices are Anthropic first-party API list prices per million tokens, cached 2026-10-06. Ratios are what matter here.

| Model | ID | Input | Output | Fit |
|---|---|---|---|---|
| Fable 5.1 | `claude-fable-5-1` | $10.00 | $50.00 | Rare, irreversible, high-stakes judgment. Thinking always on. |
| Opus 5.5 | `claude-opus-5-5` | $4.00 | $20.00 | Design, security, core engine logic, reviews that gate merges. Default effort is `medium`, so set it explicitly. |
| Sonnet 5.5 | `claude-sonnet-5-5` | $2.00 | $10.00 | Everyday implementation, UI components, refactors, triage. |
| Haiku 5.5 | `claude-haiku-5-5` | $0.10 | $0.50 | Status, dispatch, monitoring, pattern audits. Price holds up to a 100K-token prompt, then $0.50 / $2.50. |

Models the workspace runs today that are now more expensive than their successors:

| In use today | Price | Successor | Price | Saving per token |
|---|---|---|---|---|
| `claude-sonnet-4-6` (workspace default) | $3 / $15 | `claude-sonnet-5-5` | $2 / $10 | 33% |
| `claude-opus-4-8` (17 instances) | $5 / $25 | `claude-opus-5-5` | $4 / $20 | 20% |
| `claude-haiku-4-5` (Rosetta Stone 2) | $1 / $5 | `claude-haiku-5-5` | $0.10 / $0.50 | 90% |
| `claude-fable-5` (Tech Lead, Orca Support) | $10 / $50 | see section 2 | | |
| `claude-sonnet-5` (PowerShell 2, taxonomy-editor default) | $2 / $10 | `claude-sonnet-5-5` | $2 / $10 | 0%, newer model |

Three rules shape the assignments below.

1. **Tier by cost of error, not by title.** A role that can delete production data, change auth, or approve a merge gets Opus 5.5. A role whose mistakes are caught by tests and review gets Sonnet 5.5. A role that reads and summarizes gets Haiku 5.5.
2. **Effort is the token lever.** Lower effort means fewer tool calls, shorter preambles, and less thinking. `medium` is the default for implementation. `high` is for design and review. `low` is for clerical roles. Raise it only when a measured failure says so.
3. **Clones match their parent.** Temporary and numbered instances inherit the parent role's model unless they exist to run cheaper.

## 2. Model assignment per agent (PI decision)

| Role / instance | Today | Proposed model | Effort | Why |
|---|---|---|---|---|
| Main (root coordinator) | opus-4-8 | `claude-opus-5-5` | high | User-facing, arbitrates across roles. |
| Second Opinion | sonnet-4-6 (default) | `claude-fable-5-1` | xhigh | The one place the top model earns its price: stateless, rare, irreversible decisions. Today it runs on the cheapest default, which inverts the intent. |
| Tech Lead (Main) | fable-5 | `claude-opus-5-5` | high | Routes and reviews. Fable's extra cost buys nothing on routing. |
| Tech Lead (Quality) | fable-5 (inherited) | `claude-opus-5-5` | high | Merge-gating reviews. |
| DebateTool (lib/debate) and Debate Tool 2 | opus-4-8 / default | `claude-opus-5-5` | medium | Core engine, QBAF, prompt templates. Errors are subtle and reach the product. |
| Shared Lib and Debate Engine (lib) | opus-4-8 | `claude-opus-5-5` | medium | Shared types ripple into every app. |
| Computational Linguist (Main, Debate Engine) | opus-4-8 | `claude-opus-5-5` | high | Research claims and judge calibration need the judgment. |
| CL.Investigate1 | opus-5-5 | `claude-sonnet-5-5` | medium | Investigation clone. Data gathering, not verdicts. |
| ServerAPI and Server Auth | sonnet-5 (default) | `claude-opus-5-5` | medium | Auth and public REST surface. Cost of error is high. |
| Azure (Main, Infrastructure) | Main sonnet-4-6 (default), clone opus-4-8 | `claude-opus-5-5` | medium | Production infra, identity, secrets. |
| PowerShell (Main) | opus-4-8 | `claude-sonnet-5-5` | medium | Large module but well tested by Pester. Escalate to Opus for module-wide refactors by ticket. |
| PowerShell 2 | sonnet-5 | `claude-sonnet-5-5` | medium | Parallel worker. |
| DevOps Lead (Main, Infrastructure) | opus-4-8 | `claude-opus-5-5` | medium | Gate design and CI architecture. |
| DevOps Worker | sonnet-4-6 (default) | `claude-sonnet-5-5` | medium | Implements what the Lead designs. |
| Docker (Main, Infrastructure) | Main sonnet-4-6 (default), clone opus-4-8 | `claude-sonnet-5-5` | medium | Dockerfiles and build pipelines are testable in CI. |
| Diagnostics (Main, Infrastructure) | opus-4-8 | `claude-sonnet-5-5` | medium | Log triage and pattern matching. |
| Risk Assessor (Main, Quality) | Main sonnet-4-6 (default), Quality opus-4-8 | `claude-sonnet-5-5` | high | Reads proposals and rates risk. High effort, cheaper model. |
| Sage (Main, Quality) | Main sonnet-4-6 (default), Quality opus-4-8 | `claude-sonnet-5-5` | medium | Writes lessons. Pattern recognition, not design. |
| Design | opus-4-8 | `claude-sonnet-5-5` | medium | UI/UX review. Design approval stays with the human gate. |
| Rosetta Stone (Main) | sonnet-5 | `claude-sonnet-5-5` | medium | Electron app owner. |
| Rosetta Stone 2 | haiku-4-5 | `claude-haiku-5-5` | medium | Already the cheap clone. Successor is 10x cheaper and has 1M context. |
| Rosetta Stone 3 | opus-5-5 | `claude-sonnet-5-5` | medium | A clone should not outrank its parent. |
| ElectronMain, Server Storage, Server Community | sonnet-5 (default) | `claude-sonnet-5-5` | medium | Bounded modules with tests. |
| Renderer components (Analysis, Chat, Conflict, DebateDiagnostics, DebateUI, DebateWorkspace, EdgeBrowser, Settings, Sync) | sonnet-5 (default) | `claude-sonnet-5-5` | medium | Component work, caught by vitest and design review. |
| SummaryViewer | sonnet-4-6 (default) | `claude-sonnet-5-5` | medium | Sibling app, merging into Rosetta Stone. |
| Refactorer | sonnet-4-6 (default) | `claude-sonnet-5-5` | high | Behavior-preserving decomposition. High effort so it runs the tests before and after. |
| Project Manager | sonnet-4-6, low | `claude-haiku-5-5` | medium | Dispatch, status, dependencies. Decomposition judgment belongs to the TL. Measure for two weeks and revert if tickets get mis-routed. |
| Historian | sonnet-4-6, low | `claude-sonnet-5-5` | low | Narrative prose. Haiku's prose is not up to the voice-tell bar. |
| Documentation | sonnet-4-6, low | `claude-sonnet-5-5` | low | Same reason as Historian. Owns the LessonsLearned split. |
| Collaborator | sonnet-4-6, low | `claude-haiku-5-5` | low | Monitors research feeds and summarizes. |
| Orca Support | fable-5, low | `claude-haiku-5-5` | low | Setup help. The largest single mispricing in the workspace. |
| Temporary team instances (Infrastructure x4, Debate Engine x3, Gemini Canary) | mixed | parent's model | parent's | Rule 3. |
| Subagents: `code-reviewer`, `test-writer` | `sonnet` | `sonnet` (resolves to 5.5) | n/a | Keep. |
| Subagent: `error-handling-auditor` | `sonnet` | `haiku` | n/a | Checks for `ActionableError` and bare throws. A pattern audit. |

One cleanup item surfaced on the way. The instance `main.deploy-azure` has no role behind it, so archive it or give it a role.

Before any token reduction from the plan, the same traffic costs roughly 40 to 50 percent less. The version bumps alone account for part of that, and moving 11 Opus-4.8 mains to Sonnet 5.5 accounts for the rest. Combined with the 35 percent token target in the plan, the per-PR cost target is a 60 to 65 percent reduction.

## 3. Instructions per agent

Every role adds the four lines below to its `AGENTS.md` under `## Conventions`, replacing any longer wording that says the same thing. The budget ratchet in workstream A counts them.

> **Tokens.** Read files in ranges. Pipe long output through `head`, `tail` or `grep`. Quote test summaries, not runs. Reference `t/KEY` and `p/N#M` instead of inlining them. After any session boundary, read your `LAST_SESSION.md` and run `gh pr list --state all --search t/KEY` before touching code.

The role-specific instructions follow. "Owns" names the plan workstream the role lands.

### Main (root coordinator)

- Owns: nothing directly. Arbitrates when two workstreams collide.
- Delegate reading. When an answer needs more than three files, spawn one `Explore` subagent and keep only its conclusion.
- Do not re-read role instruction files for other roles. Ask the role.

### Tech Lead (Main and Quality)

- Owns: workstreams A (always-on context diet), C for TypeScript (`test:agent` script), and F (tiered review fan-out).
- Review fan-out by tier. T0: one language reviewer. T1: add `error-handling-auditor`, and `security-reviewer` when auth or input handling changes. T2: full parallel set plus Second Opinion.
- Reviewer subagents get the diff and the named playbook only. Never pass `REPO_MAP.md` or a role's `AGENTS.md` into a reviewer prompt.
- Cut `engineering/tech-lead/AGENTS.md` from 1,792 words to under 1,250. Move the GitHub issue sync rule, the transport-with-storage rule and the gate-signal rules into `docs/` and link them.
- Seed and enforce `docs/agent-instruction-budgets.json` for every overlay `AGENTS.md`.

### Second Opinion

- Owns: nothing. Consulted only on T2.
- Accept a consultation only with a written question, the decision options, and the irreversibility claim. Decline a consultation that arrives as a ticket link alone and ask for the brief.
- Answer in under 400 words. The value is the verdict and the one risk the asker missed.

### Project Manager

- Owns: workstream E (ticket and ping payload discipline).
- Ticket comments carry a decision, a link and a commit hash. Diffs and logs go in attachments.
- Prefer `search_tickets` with filters over `get_ticket` when only status or owner is needed.
- Create the feedback rule that warns on a ping body over 120 words, through `create_feedback_rule`, never by hand.
- Status pings reference the ticket. Do not restate the ticket body.

### DevOps Lead, DevOps Worker, Azure, Docker

- Owns: workstream B (filesystem and search hygiene) and the measurement baseline in plan section 2.
- Week 1: turn on Claude Code's OpenTelemetry token export. Record input, output and cache-read tokens per role and per ticket for one week with no other change.
- Prune merged worktrees weekly. Add the job to `docs/maintenance-schedule.md`.
- Add a root `.rgignore` covering `node_modules`, `build`, `tmp`, `citeonly-logs`, `taxonomy-snapshot`, `.worktrees`, `.claude/worktrees`.
- Move the root `taxonomy-proposal-pass-*.json`, the experiment files and the `.pptx` decks out of the repo root.
- Read CI with `gh run view --log-failed`. Never `--log`.
- Azure: run `az` queries with `--query` and `--output tsv`. Never dump a full resource JSON into context.

### PowerShell (Main and PowerShell 2)

- Owns: workstream C for PowerShell.
- Default `Invoke-BoundedTestRun.ps1` to `-Output Minimal` and print the failure list only.
- Run one test file by path during iteration. Run the suite once before the PR.
- `Get-Help` on a cmdlet, not the source file, when you need the signature.

### Documentation and Historian

- Owns: workstream D (reference docs on demand) and the `tokens_per_merged_pr` metric.
- Documentation: split `docs/LessonsLearned.md` into `docs/lessons/NNN-slug.md` with a generated `INDEX.md`, one line per entry. Leave a redirect paragraph at the old path.
- Documentation: add a ten-line summary block at the top of `agent-rules-reference.md` and `shared-tree-divergence.md`.
- Historian: add `tokens_per_merged_pr` to the weekly metrics once DevOps has the export running. Report it next to PR count.
- Both: grep the lessons index, never open the monolith.

### Sage and Risk Assessor

- Sage: a new lesson is one file in `docs/lessons/`, under 400 words, with a one-line index entry. Search the index before writing to avoid a duplicate genus.
- Risk Assessor: rate from the PR description, the diff stat and the tier line. Open a file only when the description does not say what changed.

### Refactorer

- Run the complexity baseline script and act on its list. Do not scan the tree yourself.
- One function per PR. Quote the before and after complexity number and the test summary line, nothing else.

### Rosetta Stone, ElectronMain, ServerAPI, Server Auth, Server Storage, Server Community, renderer components, SummaryViewer

- Use `npm run test:agent` once the TL lands it. Until then, `vitest run --reporter=dot <file>`.
- Type-check with `npx tsc --noEmit -p <tsconfig>` and read only the error lines.
- Self-certify against a playbook (`/add-rest-endpoint`, `/add-bridge-method`, `/add-test`, `/trivial-change`) in one ticket comment. Do not request a design review that the playbook exempts.
- Server Auth: every PR is at least T1. Request `security-reviewer`. Do not request the full fan-out.
- Renderer components: `smoke-ui` only for PRs that change a visible surface. A store or hook change is covered by vitest.

### DebateTool, Shared Lib

- Prompt template changes: run the calibration harness on the named fixture set, not a full debate. Quote the judge score delta.
- Shared type changes: run `resolve_owners_batch` once and file one ticket per owner. Do not open each consumer file to find them.

### Computational Linguist (Main, Debate Engine, CL.Investigate1)

- Keep calibration transcripts in the data repo and attach a path. Do not paste transcripts into tickets or pings.
- CL.Investigate1 gathers and tabulates. The verdict and the write-up go to Main.
- Research reviews end with a 150-word summary at the top. Readers rarely need the body.

### Design

- Review from screenshots and the component diff. Do not launch the app for a CSS-only change.
- `Approved (Design):` is one line with the PR number. Rationale goes in the ticket, once.

### Diagnostics

- Triage with `/triage-flight-recorder`. It reads the JSONL in ranges.
- Report the matched failure pattern number and the one log line that proves it.

### Collaborator

- One digest per week, under 300 words, with links. No per-article pings.

### Orca Support

- Owns: applying the approved model and effort changes in section 2 through `ogit`, after the PI approves, one PR per role group.
- Confirm each change with `list_instances`, not by reading the YAML back.

## 4. Verification

- Model and effort: `list_instances` shows the new values for every row in section 2. Orca Support posts the listing to the tracking ticket.
- Instructions: each role's `AGENTS.md` carries the four-line Tokens block, and the budget check passes on the overlay pre-commit hook.
- Outcome: the Historian's `tokens_per_merged_pr` for week 4 against week 1. The plan's gate at week 2 still applies.
