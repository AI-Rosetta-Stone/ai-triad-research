# Maintenance Schedule

Codified list of recurring maintenance tasks. Each task has a cadence, owner, and command or procedure. Agents should check this schedule at session start and execute any overdue tasks for their scope.

## Per-Session (Every Agent Start)

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Check ticket queue | Each agent | `list_tickets` — work unblocked items |
| Read inbox | Each agent | Check pings and email for action items |
| Scan recent commits | Tech Lead | `git log --oneline -20` — spot regressions, verify merged PRs |

## Per-Task Completion

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Run verify gate | Taxonomy Editor agent | `cd taxonomy-editor && npm run verify` |
| Run Pester tests | PowerShell agent | `Invoke-Pester ./tests/` |
| Type-check server | Taxonomy Editor agent | `cd taxonomy-editor && npx tsc -p tsconfig.server.json --noEmit` |

## Weekly

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Dependency audit (npm) | Tech Lead → route to Taxonomy Editor | `cd taxonomy-editor && npm audit` — triage per `docs/security/dependency-policy.md` CVE SLA. Verify per-package counts via `gh api .../dependabot/alerts --jq` — never derive counts by subtraction from UI totals |
| Dependency audit (pip) | Tech Lead → route to PowerShell agent | `pip-audit -r scripts/requirements.txt` — triage per dependency policy CVE SLA. Verify per-package counts via API — never derive by subtraction |
| Review Dependabot PRs | Tech Lead | Check GitHub PR queue for Dependabot updates, review + merge or close |
| Source SAST triage (CodeQL) | Tech Lead | `gh api repos/.../code-scanning/alerts?state=open --jq '.[] \| select(.tool.name=="CodeQL")'` — every alert gets a verdict (fix / false positive / won't fix), none stays untriaged. Dismiss with a written justification per `docs/security/dependency-policy.md`. Do **not** read the Security-tab total: it is >98% Trivy |
| Container CVE triage (Trivy) | DevOps | Same endpoint filtered to `.tool.name=="Trivy"`. Count **unique CVE IDs**, not alerts — the same CVE is re-filed on every image build and prior alerts do not auto-close. Drive remediation via base-image bump / `v*` release, not per-alert |
| Flight recorder spot check | Tech Lead | Pull a recent flight recorder dump, scan for recurring `system.error` patterns |
| Calibration drift report | DebateTool | `npx tsx lib/debate/calibrationDriftReport.ts` or `computeDriftReport(readCalibrationLog(dataRoot))` — check 5 quality metrics for sustained degradation (t/1330) |
| SBOM currency check | Taxonomy Editor agent | `cd taxonomy-editor && npm run licenses && git diff THIRD-PARTY-NOTICES.txt` — commit if changed |
| Prune merged worktrees | DevOps | `git worktree prune`, then for each `.worktrees/<name>` inside the repo whose branch is merged into `origin/main` and whose `git -C <path> status --porcelain` is empty, run `git worktree remove <path>` (never `--force`). Branches are not deleted. Skip detached-HEAD worktrees, worktrees outside the repo and `.claude/worktrees/` (token-reduction plan 3.B) |

## Monthly

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Security review | Tech Lead (spawn `security-reviewer`) | Review changes touching auth, secrets, user input from past month |
| Performance review | Tech Lead | Check flight recorders for latency trends; review `adminReviewStats` for >10s operations |
| Dead code scan | Tech Lead (spawn reviewer) | `depgraph --orphans` + grep for unused exports across `lib/` |
| Coverage trend check | Tech Lead | Compare current coverage thresholds vs actuals — raise thresholds if actuals are 10%+ above |
| CLAUDE.md accuracy audit | Tech Lead | Read CLAUDE.md end-to-end, verify paths/versions/conventions match reality |
| ESLint warning review | Taxonomy Editor agent | `cd taxonomy-editor && npx eslint src/ 2>&1 \| grep "warning"` — ticket any new categories |
| Azure cost review | DevOps | Check Azure portal for cost anomalies (Container Apps, Storage, Key Vault) |

## Quarterly

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Architecture review | Tech Lead | Full system review: are patterns holding? New tech debt? Document in ADR if decisions change |
| ADR review | Tech Lead | Read `docs/design/adr/` — any decisions to revisit or supersede? |
| Major dependency evaluation | Tech Lead | Check for major version bumps in core deps (React, Electron, Vite, Zustand, Zod). Evaluate breaking changes, ticket upgrades |
| Code review guide refresh | Tech Lead | Review `docs/CodeReview/` guides — add patterns learned from recent reviews |
| LessonsLearned consolidation | Sage | Review `docs/LessonsLearned.md` — archive resolved items, extract patterns into CLAUDE.md or AGENTS.md |
| Test suite health | Tech Lead | Are tests meaningful? Any flaky tests? Any areas with zero coverage that should have some? |
| Key material rotation | ServerAPI | Local store: `POST /api/admin/rotate-keys` (admin) re-encrypts all API keys under fresh `.aitriad-key-material`. Azure: rotate the Key Vault CMK instead. See threat-model AS-1 (t/809) |

## Per-Release

| Task | Owner | Command / Procedure |
|------|-------|---------------------|
| Regenerate SBOM | Taxonomy Editor agent | `cd taxonomy-editor && npm run licenses` — commit updated THIRD-PARTY-NOTICES.txt |
| Validate module manifest | PowerShell agent | `Test-ModuleManifest -Path ./build/AITriad/AITriad.psd1` |
| Version consistency check | Tech Lead | Verify version matches across: `AITriad.psd1` (source + build), `package.json`, CLAUDE.md |
| Container smoke test | DevOps | Build container locally, run health check: `curl http://localhost:7862/health` |
| Security checklist | Tech Lead | No secrets in code/config/images, CORS configured, CSP headers set, rate limits active |

## Ad-Hoc (Triggered by Events)

| Trigger | Task | Owner |
|---------|------|-------|
| UAT bug found | Triage: why didn't tests catch it? What test to add? Cross-feature interaction? | Tech Lead |
| CI failure on main | Root-cause analysis, fix, regression test | Tech Lead → route to owning agent |
| New agent/role created | Review scope boundaries, update CODEOWNERS, verify AGENTS.md | Tech Lead |
| Post-incident | Write postmortem, update LessonsLearned.md, ticket preventive measures | Tech Lead + Sage |
| Flight recorder shows recurring error (3+ occurrences) | Investigate root cause, ticket fix | Tech Lead |

## How to Use This Schedule

**For agents:** Check overdue tasks for your scope at session start. Compare against the Execution Log below — if a weekly task hasn't run in 7+ days, or a monthly task in 30+ days, it's overdue. After completing a scheduled task, append a row to the log.

**For Tech Lead:** Use this as a checklist during weekly planning. Create tickets for findings. Route execution to owning agents.

**For humans:** Review monthly and quarterly tasks during planning. Adjust cadences based on project phase (faster during active development, slower during maintenance).

**Tracking:** When a scheduled task surfaces a finding, create a ticket. Reference this schedule in the ticket description so the pattern is traceable.

## Execution Log

Append a row after completing any weekly, monthly, quarterly, or per-release task. Keep the log trimmed to the last 90 days — archive older rows by deleting them.

| Date | Task | Agent | Result / Notes |
|------|------|-------|----------------|
| 2026-06-25 | Dead code scan | Taxonomy Editor | 163 orphans via depgraph. 3 dead files removed (debateTopics.ts, lineageL2Clusters.ts+JSON, useClientConfig.ts). 1 false positive (clustering.ts — dynamic import). Rest are test files, entry points, and lib/ scope. |
| 2026-06-25 | ESLint warning review | Taxonomy Editor | No new warning categories found. |
| 2026-06-25 | SBOM currency check | Taxonomy Editor | Pending — check in next session. |
| 2026-07-04 | Dependency audit (npm+pip) | DevOps | t/1311: 89→66 alerts. 13 high→0 high. Python lock file re-pinned (pdfminer.six, GitPython, requests). Merged sigstore Dependabot PRs (#87-89). pypdf 5→6 deferred to t/1313. |
| 2026-08-03 | Source SAST triage (CodeQL) | Tech Lead | First execution of this row. 19 open CodeQL alerts, all medium, oldest 2026-05-23 (10+ weeks, vs 30-day verdict SLA). 3 real → t/2098 (no-op `.git` replace), t/2099 (prototype pollution + missing SRI). 8 by-design pending owner confirmation → t/2100 (Server Storage), t/2101 (DebateTool). 8 proposed for dismissal, blocked on code-scanning write permission. Also found the Trivy queue at 1,066 alerts / 263 unique CVEs — split into its own DevOps-owned row. |
| 2026-07-06 | Azure cost review | DevOps | Anomaly found: budget cap $30/mo, spend $25.68 (~86%) by day 6 of July — vs AGENTS.md's stale "$0-5/month" target. Likely driver: prod minReplicas:1 (intentional per t/683, not drift). Filed t/1354, owner decision pending. |
