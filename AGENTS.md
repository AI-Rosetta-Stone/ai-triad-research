# AGENTS.md

Guidance for agents working in this repository. The rules here are kept short. The rationale and incident history behind each one live in **`docs/agent-rules-reference.md`** (cited below as Ref §N). A new rule needs a second occurrence, an owner and a review-by date (see Change Tiers).

## Project Overview

AI Triad Research — multi-perspective research platform for AI policy/safety literature. Berkman Klein Center, 2026. Two sibling repos: this one (code) and `../ai-triad-data` (structured JSON data, ~410 MB).

## Build & Test Commands

Role-specific — see the owning subtree's `AGENTS.md` (auto-loads in scope):

- PowerShell module / Pester / manifest → `scripts/AGENTS.md`
- Taxonomy Editor / poviewer / summary-viewer (npm, vitest, tsc) → `taxonomy-editor/AGENTS.md`
- Debate engine (vitest) → `lib/debate/AGENTS.md`
- CI pipeline (`ci.yml`) → `operations/devops/AGENTS.md`

## Architecture

### Two-Repo Split

Code here; data in `../ai-triad-data`. `.aitriad.json` maps relative paths to data dirs. Override with `$env:AI_TRIAD_DATA_ROOT`. Priority: env var > `.aitriad.json` > monorepo fallback.

### Orca Overlay Repo

Orca config (`.orca.yaml`, nested `AGENTS.md`, `.orca/`) lives in a **separate overlay repo** at `.orca-git/`, so Orca infra stays private while the main repo stays public.

- `git` → main repo. `ogit` (`git --git-dir=.orca-git --work-tree=.`, run from the repo root) → overlay.
- **Never `git add`/`commit`** overlay-tracked files: `.orca.yaml`, `.orca/`, `.orca-gitignore`, every **nested** `AGENTS.md`. Unsure which repo owns an `AGENTS.md`? Run `sh .githooks/agent-file-owner.sh --path <file>`. Only this root file and `operations/devops/azure/AGENTS.md` are main-repo tracked.
- **New role or instance:** `ogit add -f <role>/AGENTS.md`, then `sh .githooks/agent-file-owner.sh --audit` before your next commit. Never `--no-verify` past the audit. Don't ogit-add a `.worktrees/<name>/AGENTS.md`.

### Feedback Rules

- **Author and repair rules only through the MCP tools** (`create_feedback_rule`), never by editing `.orca/feedback-rules/*.yaml`; a hand-written rule loads as dead. `update_feedback_rule` refuses an invalid stored rule, so repair it by backing up, deleting and re-creating, keeping its `scope`.
- **Only an observed injection proves a rule works.** Being listed only shows the rule loaded; `fire_count_24h` only shows its matcher fired. Ref §1.

### Workflow Mode and the Shared Checkout

- **Mode** is line 1 of the overlay file `.orca/workflow-mode` (`sh .githooks/read-workflow-mode.sh`): `worktree` (strict; also the fail-safe for any other value) or `direct`. Change it only deliberately, and record who, when and why in the file.
- **In both modes the shared checkout stays on `main`.** Anything that moves HEAD or rewrites the tree (`checkout`, `reset`, `rebase`, `merge`, `pull --rebase`, `stash`) happens only in a worktree. On the shared checkout:
  - never `git commit -a` or `git add -A`;
  - commit with a pathspec and push immediately;
  - if a push is rejected, land it from a worktree.

  Only DevOps cleans up a diverged shared tree (`docs/shared-tree-divergence.md`). Ref §2.
- **In `worktree` mode:**
  - work on a branch: `git worktree add -b <branch>`, or `/land-from-worktree`;
  - be in the worktree before your first edit;
  - `cd` into it **in the same command**, because the shell cwd resets between calls.

  The pre-commit hook (`git config core.hooksPath .githooks`) refuses commits on `main`, and in both modes refuses commits on a detached HEAD in a worktree.

### Pre-Self-Merge Verification

- **Land code through a PR to `main`.** The required contexts are `ci-gate`, `CodeQL`, `joint-gv-guard` and `consult-hold-guard`, with `enforce_admins` on.
- **Before a manual merge,** confirm all of:
  - the base is `main`;
  - CI is green on the exact head;
  - no hold is still open.

  Then merge with `gh pr merge <N> --squash --match-head-commit <headRefOid>`; never do a bare manual merge. Ref §3.

### PR-Flow Practice Rules

- **Batch sequential same-feature work** into one PR, unless the diff is over ~400 lines or mixes concerns. Merge promptly on green, or record why not.
- **Arm auto-merge at PR creation** (`gh pr merge <N> --auto --squash --match-head-commit <headRefOid>`) for **T0** PRs. For **T1**, arm only after the reviewer's `Approved (<role>):` approval (App review or comment) is on the PR for the current head (t/4247: #3343 and #3364 merged before review). Arming means "done", so disarm before pushing more.
  - Never arm consult-hold, joint-gv or draft PRs, or PRs whose base isn't `main`.
- **Holds:** the `consult-hold` label (T2 only) is the only hold. Draft state, hold comments and condition checklists are optional.
  - It clears with the Second Opinion's clearing comment, which checks each of its own conditions against the head;
  - or with the "SO did not review" note plus the human approval.
- **Co-landing PRs** carry `joint-gv` and are merged manually after their joint review.
- **Approve via the reviewer App:** `Invoke-AsAgentApp -Role reviewer`, with the review body `Approved (<role>): …`. Never approve your own role's PR. It fails closed; procedure in `docs/agent-pr-approval.md`. The approval is a record, not a merge requirement.
- **Where this section differs from Change Tiers below, Change Tiers wins.** Ref §4.

### Claim Before Implement

Claim before implementing (assign yourself or comment). First check for a peer's claim, a PR on any base, or a recent landed commit.

### Epic Branches

- **Epics:**
  - child PRs target `epic/<name>`, never `main`;
  - there is one shared epic → `main` PR;
  - review each child when it merges into the epic. Ref §5.

### Subsystem Map

Detailed conventions live in each subtree's `AGENTS.md`. Orientation only:

- **PowerShell module** (`scripts/AITriad/`) — 40+ cmdlets (Public/Private), prompts in `Prompts/`, `AIEnrich.psm1` (multi-backend AI) + `DocConverters.psm1`. → `scripts/AGENTS.md`
- **Electron apps** — 3 independent Vite + React 19 + Electron 35 + TS apps: **taxonomy-editor/** (Zustand + Zod), **poviewer/** (pdfjs-dist), **summary-viewer/**. → `taxonomy-editor/AGENTS.md`
- **Debate engine** (`lib/debate/`) — three-agent BDI (Accelerationist / Safetyist / Skeptic). Entry: `Show-TriadDialogue` or `npm run debate`; `aiAdapter.ts` abstracts backends. → `lib/debate/AGENTS.md`

### Taxonomy Model

Four POV camps with BDI categories. Node IDs: `{pov}-{category}-{NNN}` (pov ∈ `acc`/`saf`/`skp`/`cc`). Policy actions use `pol-*` IDs in `policy_actions.json`. Embeddings: all-MiniLM-L6-v2, 384-dim in `embeddings.json`.

**Data File Convention:** JSON files use nested structures — never assume flat schemas; inspect a sample (`head`/`jq`) first. Enriched fields live under `node.graph_attributes.*`; `embeddings.json` wraps entries under `data['nodes']`; field types vary (list vs dict) — check `type()`/`isinstance()` before use.

### AI Backends

`ai-models.json` is the single source of truth for both PowerShell and Electron. A model's backend comes from the registry, never from its id prefix (t/4087). Keys come via `Register-AIBackend` or per-backend env vars (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, …), with an `AI_API_KEY` fallback **for gemini models only** (other backends refuse it as a primary key, t/4102). **Run `npm run verify:config` before landing any edit.** Adding a backend? Follow `/add-ai-backend`.

### Dependency Security Bumps

Follow `docs/security/dependency-policy.md` ("Executing a Dependency Security Bump"). Overrides live in **`pnpm-workspace.yaml`**; `package.json` `overrides` are inert. Never remove an override without checking which advisory it closes.

## Shell Quoting Rule (and Git Hygiene)

- **Code with special shell characters:** use Edit/Write, and run scripts from a file; never use inline heredocs, `sed` or `awk` for it.
- **0-byte files named after code fragments:** confirm each is empty and untracked, then `rm --` it. Never commit one.
- **Shared index:** commit with a pathspec (`git commit -m "…" -- <paths>`). Scan `git status --short` **unscoped** before committing, and check `git show --stat HEAD` afterwards. Commits that set the executable bit go through a worktree. Ref §6.
- **Windows Bash:** MSYS mangles `git show <ref>:<path>`, so prefix the command with `MSYS_NO_PATHCONV=1`.

## Verify Against the Authoritative Source

Before asserting what a system *is* doing, read the system, not a file that describes it:
- **Merged state:** read `origin/main`, never the shared checkout.
- **Infrastructure:** query the registry or cloud API, not the workflow YAML.
- **Baselines:** check against design intent.
- **Gate behaviour:** run the failing arm.

If your evidence for "X does Y" is a file that *configures* Y, you haven't verified it.

## Error Handling Convention

Unrecoverable errors use `New-ActionableError` (PS) / `ActionableError` (TS) with **Goal / Problem / Location / Next Steps**. Never use a bare `throw "message"`. Prefer recovery over failure. **Log every fallback path with a `WARN` stating that it was taken and why**; a silent fallback is invisible degradation. In PowerShell, assert on the rendered labels (`Goal:`/`Error:`/`Location:`/`Resolve:`). See `docs/error-handling.md`.

## Token Efficiency

- Prefer ping over email for status updates and single-question exchanges.
- Reference entities (t/KEY) instead of inlining their content.

## Incident Response

- **The TL coordinates** (`/tl-incident-response`), and the anchor ticket is the source of truth. Claim a follow-up on the anchor before filing it, and before any shared-tree write.
- **Every diagnosis files two follow-ups:**
  - **Observability**: make it diagnosable next time;
  - **Prevention**: an automated check, test or platform fix, mapped to a failure class in `docs/CodeReview/failure-classes.md`.

  Gate-touching prevention goes to TL Gate Verification.
- **When a failure class recurs, validate the baseline against design intent.**
- **Before closing a prevention,** name one way the class could still occur through ordinary use with the mechanism intact. If you can name one, you closed a *vector*, not the class: say so and file the remainder. Ref §7.

## Ticket Lifecycle

- Starting work → `transition_ticket` to **In Progress** immediately.
- Done (PR merged or no-code task complete) → **Done**.
- Never leave a ticket Unstarted while actively working it.

## Change Tiers and Decision Rights (t/4092, PI-approved 2026-10-07)

**Declare the tier in the PR body's first line: `Tier: T0`, `T1` or `T2`.** A PR touching a T2 path must declare T2. That is enforced by the tier check (t/4103, advisory until promoted); until then the TL spot-checks. When the tier is otherwise unclear, choose **T1**, not a consult.

- **T0 (default):** features, fixes, refactors, tests, docs, dependency bumps, warn-only checks, and additive optional fields nothing branches on. Green CI, then auto-merge. No consult, hold or TL review.
  - An additive field is T0 only if its definition carries a point-of-use exemption note with its lapse condition. The model is `lib/ai-client/types.ts`: *"NO consumer branches on it… THE EXEMPTION LAPSES the moment a consumer branches on it."* Written-and-never-read is forensics; written-and-compared is semantic.
- **T1:** a new cross-role contract or shared type, a schema field a consumer reads, the **first branching reader of a previously exempt field**, or a new non-blocking gate. The owner plus one reviewer (Quality round-robin, `docs/review-routing.md`) approve on the PR, then auto-merge.
- **T2 (the only consult class):** making a gate blocking, a breaking schema or data-shape change, auth or secrets, writes to production or corpus data, or anything that takes more than a sprint to undo.
  - One Second Opinion round (`main.engineering-second-opinion@ai-triad-research.orca.local`), time-boxed to **2 hours**. Send the proposal, alternatives, what's at stake and the evidence; the reply is Recommendation / Key risks / Conditions / Dissent.
  - **Silence never approves.** After the time-box, the PR goes to the T2 human approver marked "SO did not review", and the approver decides knowingly. An unreachable SO backend is an infra issue for Orca Support; it neither blocks nor waives.
  - Conditions name the files they edit **and the files their logic depends on**. A new head needs re-confirmation only if it touches one of those.
  - Apply the **`consult-hold` label** (the required context `consult-hold-guard` enforces it for every merge path) and a one-line comment naming the open conditions. Human approval is required: the PI, or the TL when the SO has cleared the exact head (t/4096#58). SO dissent or no SO review → the PI. Merge pinned with `--match-head-commit`.
- **Incident remediation is an automated check, test or platform fix.** A new prose rule needs a second occurrence, an owner and a review-by date.

**Only the PI decides:**
- spending and accounts;
- credentials and secrets policy;
- product and UX direction;
- research claims and publication;
- deleting production data;
- adding or removing roles;
- repo and branch-protection settings.

Everything else is decided by the owning role, or the TL if roles disagree, and recorded on the ticket.

**Asks to the PI** go in one daily TL digest. Each ask carries a recommendation and a default that takes effect by a stated time. **Defaults never apply to T2 approvals, anything on the PI-only list, or active security incidents.** Those wait for an explicit answer and are re-raised in each digest until answered.
