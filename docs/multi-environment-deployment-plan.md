# Multi-Environment Deployment Plan: Dev / Beta / Prod

## Problem Statement

The AI Triad project currently has a single Azure Container Apps deployment. We need three environments (dev, beta, prod) with a taxonomy data promotion workflow that supports collaborative editing, review/approval gates, and schema migration for breaking changes.

## Current State

- **Single deployment**: `taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io`
- **Single Azure Files share**: `/data` (10 GB) with taxonomy, debates, summaries
- **Single data repo**: `AI-Rosetta-Stone/ai-triad-data` on GitHub (main branch)
- **Git sync exists** (`gitRepoStore.ts`): per-user session branches, commit-on-write, PR creation, rebase conflict resolution — but only Phase 1-2 are implemented
- **Schema versioning exists**: `_schema_version: "1.0.0"` in taxonomy files, but no runtime version-gated parsing or migration

## Architecture

### Three Environments

| | Dev | Beta | Prod |
|---|---|---|---|
| **Purpose** | Rapid iteration, new features, experiments | Stakeholder review, UAT, pre-release validation | Stable, public-facing |
| **Update cadence** | Continuous (every push to `dev` branch) | On promotion (PR merge to `beta` branch) | On promotion (PR merge to `main` branch) |
| **Container image** | `ghcr.io/.../taxonomy-editor:dev` | `ghcr.io/.../taxonomy-editor:beta` | `ghcr.io/.../taxonomy-editor:latest` |
| **Data branch** | `dev` | `beta` | `main` |
| **Azure resource group** | `ai-triad-dev` | `ai-triad-beta` | `ai-triad` |
| **Scale** | 0-1 (same as today) | 0-1 | 0-1 (increase if needed) |
| **Auth** | Team only (allowlist) | Team + stakeholders (allowlist) | Configurable (allowlist or open) |
| **Cost** | ~$15/mo (scales to zero) | ~$15/mo (scales to zero) | ~$15/mo (existing) |

### Azure Resource Topology

Each environment gets its own:
- Container App (different image tag)
- Azure Files share (separate taxonomy data)
- Key Vault (per-user BYOK keys are environment-scoped)
- Log Analytics workspace (separate diagnostics)

Shared across environments:
- Container Apps Environment (single `cae-aitriad` — all three apps run in the same environment for cost efficiency and VNet simplicity)
- Storage Account (one account, three file shares: `taxonomy-data-dev`, `taxonomy-data-beta`, `taxonomy-data-prod`)

```
cae-aitriad (Container Apps Environment)
├── taxonomy-editor-dev     → share: taxonomy-data-dev     → git branch: dev
├── taxonomy-editor-beta    → share: taxonomy-data-beta    → git branch: beta
└── taxonomy-editor         → share: taxonomy-data-prod    → git branch: main
```

### Bicep Changes

Parameterize `main.bicep` with an `environment` parameter:

```bicep
@allowed(['dev', 'beta', 'prod'])
param environment string

var envSuffix = environment == 'prod' ? '' : '-${environment}'
var containerAppName = 'taxonomy-editor${envSuffix}'
var fileShareName = 'taxonomy-data-${environment}'
var imageTag = environment == 'prod' ? 'latest' : environment
```

All resource names derive from the environment parameter. One Bicep file, three deployments. The existing `deploy.ps1` gets an `-Environment` parameter:

```powershell
./deploy.ps1 -ResourceGroup ai-triad -Environment dev
./deploy.ps1 -ResourceGroup ai-triad -Environment beta
./deploy.ps1 -ResourceGroup ai-triad -Environment prod
```

### CI/CD Pipeline Changes

```
container.yml (existing)                    promotion.yml (new)
┌─────────────────────────┐                ┌────────────────────────────┐
│ On push to dev branch:  │                │ On PR merge to beta:       │
│   Build + push :dev tag │                │   Retag :dev → :beta       │
│   Deploy to dev env     │                │   Deploy to beta env       │
│                         │                │   Sync data: dev → beta    │
│ On push to beta branch: │                │                            │
│   (via promotion PR)    │                │ On PR merge to main:       │
│                         │                │   Retag :beta → :latest    │
│ On tag v*:              │                │   Deploy to prod env       │
│   Build + push :latest  │                │   Sync data: beta → prod   │
│   Deploy to prod env    │                └────────────────────────────┘
└─────────────────────────┘
```

---

## Taxonomy Data Collaboration Model

This is the hard problem. Three environments need to:
1. Share a common taxonomy baseline
2. Allow modifications in lower environments
3. Promote approved changes upward
4. Handle conflicts when multiple environments diverge
5. Deal with breaking schema changes

### Git as the Source of Truth

The `ai-triad-data` repo is already the taxonomy data store. Extend its branching model:

```
main (prod)
 ├── beta (pre-release)
 │    └── dev (active development)
 │         ├── user/jsnover/session-1  (per-user edit branches)
 │         └── user/reviewer2/session-1
 ```

**Each environment's Azure Files share tracks its corresponding branch.** The git sync infrastructure (`gitRepoStore.ts`) already handles:
- Committing edits to session branches
- Creating PRs from session branches
- Rebasing onto upstream
- Conflict resolution UI

### Data Flow: Edit → Review → Promote

```
┌─────────────────────────────────────────────────────────────┐
│                    TAXONOMY EDIT LIFECYCLE                    │
│                                                               │
│  1. User edits in DEV                                        │
│     └─ gitRepoStore commits to user/X/session branch         │
│                                                               │
│  2. User creates PR: session → dev                           │
│     └─ /api/sync/create-pr (already exists)                  │
│     └─ PR triggers: schema validation CI check               │
│     └─ PR triggers: diff summary comment (what changed)      │
│                                                               │
│  3. PR merged → dev branch updated                           │
│     └─ dev Azure Files auto-syncs (webhook or poll)          │
│     └─ Other dev users see changes after resync              │
│                                                               │
│  4. Promote dev → beta: Create PR dev → beta                 │
│     └─ CI runs: schema validation + migration check          │
│     └─ CI runs: taxonomy integrity (referential, QBAF)       │
│     └─ Requires 1 approver (stakeholder or tech lead)        │
│                                                               │
│  5. Promote beta → prod: Create PR beta → main               │
│     └─ CI runs: full validation suite                        │
│     └─ Requires 2 approvers (tech lead + product owner)      │
│     └─ Changelog generated from commit messages              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Environment Sync Mechanism

Each environment's container keeps its Azure Files share in sync with its git branch:

1. **Startup**: `gitRepoStore.initDataRepo()` clones the environment's branch (already implemented — add `--branch=${ENV_BRANCH}` parameter)
2. **Periodic poll** (new): Every 5 minutes, `git fetch origin && git diff --stat HEAD origin/${branch}` — if upstream has new commits, pull and broadcast a `taxonomy-updated` WebSocket event so the UI refreshes
3. **Webhook** (Phase 3, partially implemented): GitHub webhook on push → `/api/sync/webhook/github` → pull + refresh. Already has HMAC verification scaffolding
4. **Write path**: Unchanged — edits commit to session branches, PRs merge to the environment branch

### Conflict Resolution Between Environments

**Scenario**: Dev and beta both modify the same node.

This can't happen in the normal flow because changes only flow upward (dev → beta → prod). Beta and prod are read-from-upstream-only — edits happen in dev. If a hotfix is needed directly in prod:

1. Create a hotfix branch from `main`
2. Edit, PR to `main` (prod)
3. Cherry-pick or merge `main` back into `beta` and `dev` (downward sync)

**Downward sync** (prod → beta → dev) happens automatically:
- `beta` periodically rebases onto `main` (or merges)
- `dev` periodically rebases onto `beta`
- Conflicts surface in the rebase UI (already built: `/api/sync/rebase-*` endpoints)

---

## Schema Migration for Breaking Changes

This is the critical piece. A breaking schema change (e.g., renaming a field, changing an enum, restructuring a type) must propagate safely across three environments that may be on different schema versions simultaneously.

### Schema Version Contract

Every taxonomy data file already has `_schema_version: "1.0.0"`. Formalize the contract:

| Version bump | Meaning | Example |
|---|---|---|
| Patch (1.0.x) | Additive field, no code change needed | Add optional `temporal_scope` field |
| Minor (1.x.0) | New required field with default, or union-type expansion | `Interpretation` becomes `string \| BdiInterpretation` |
| Major (x.0.0) | Removed field, renamed field, enum value change, structural reorganization | `Goals/Values` → `Desires`, `cc-` → `sit-` |

### Migration Registry

New file: `taxonomy/migrations/registry.json`

```json
{
  "migrations": [
    {
      "id": "001-bdi-terminology",
      "from_version": "1.0.0",
      "to_version": "2.0.0",
      "description": "Rename Goals/Values→Desires, Data/Facts→Beliefs, Methods/Arguments→Intentions",
      "breaking": true,
      "script": "001-bdi-terminology.ts",
      "rollback": "001-bdi-terminology-rollback.ts",
      "applied_at": null
    },
    {
      "id": "002-situation-ids",
      "from_version": "2.0.0",
      "to_version": "2.1.0",
      "description": "Rename cc-NNN IDs to sit-NNN",
      "breaking": true,
      "script": "002-situation-ids.ts",
      "rollback": "002-situation-ids-rollback.ts",
      "applied_at": null
    }
  ]
}
```

Each migration script exports:

```typescript
export interface Migration {
  id: string;
  fromVersion: string;
  toVersion: string;
  // Transform a single taxonomy file's JSON in-place
  up(data: unknown): unknown;
  // Reverse the transformation
  down(data: unknown): unknown;
  // Validate that the migration was applied correctly
  validate(data: unknown): { valid: boolean; errors: string[] };
}
```

### Runtime Schema Version Gate

Add version checking to the server's taxonomy load path (`fileIO.ts`):

```typescript
function loadTaxonomyFile(filePath: string): TaxonomyData {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const fileVersion = raw._schema_version || '1.0.0';
  const expectedVersion = CURRENT_SCHEMA_VERSION; // from package or config

  if (semver.major(fileVersion) !== semver.major(expectedVersion)) {
    // Major version mismatch — data is incompatible
    throw new ActionableError({
      goal: `Load taxonomy file ${filePath}`,
      problem: `Schema version ${fileVersion} is incompatible with app version (expects ${expectedVersion})`,
      location: 'fileIO.loadTaxonomyFile',
      nextSteps: [
        `Run migration: npm run migrate -- --from ${fileVersion} --to ${expectedVersion}`,
        `Or deploy the matching app version for this data`,
      ],
    });
  }

  if (semver.lt(fileVersion, expectedVersion)) {
    // Minor/patch behind — auto-migrate in memory (don't write)
    return applyMigrations(raw, fileVersion, expectedVersion);
  }

  return raw;
}
```

### Breaking Change Deployment Sequence

When a breaking schema change is ready:

```
Phase 1: Prepare (no downtime)
├── Write migration script + rollback script
├── Write new schema version
├── Add shim layer (app accepts both old and new format)
├── Deploy shimmed app to ALL environments (prod first!)
│   └── Prod app can now READ both v1 and v2 data
│   └── Prod app still WRITES v1 format
└── Validate: all environments healthy with shimmed app

Phase 2: Migrate data (dev first)
├── Run migration on dev branch data
│   └── Commit: "migrate: schema v1→v2 (001-bdi-terminology)"
│   └── Dev now reads/writes v2
├── Soak in dev (1-3 days): test all features with v2 data
├── Promote to beta (PR dev→beta)
│   └── Beta now reads/writes v2
├── Soak in beta (1 week): stakeholder validation
└── Promote to prod (PR beta→main)
    └── Prod now reads/writes v2

Phase 3: Remove shims (after all environments on v2)
├── Remove v1 compatibility code from app
├── Deploy clean app to all environments
└── Delete rollback script (migration is permanent)
```

**Key insight**: The app upgrade (Phase 1) deploys **top-down** (prod first) so that prod can always read data from any environment. The data migration (Phase 2) deploys **bottom-up** (dev first) so that breaking data changes are validated before reaching prod.

### Simultaneous Multi-Version Operation

During the migration window, environments run different schema versions:

```
Timeline:
  T0: All on v1 (app has shim, reads v1+v2)
  T1: Dev migrates to v2
  T2: Beta migrates to v2
  T3: Prod migrates to v2
  T4: Shim removed from app
```

Between T1 and T3, the promotion PRs carry both data changes AND version bumps. The CI validation step checks:

```yaml
# .github/workflows/taxonomy-validation.yml
- name: Validate schema version
  run: |
    # Check that all taxonomy files have consistent _schema_version
    # Check that version matches the target branch's expected version
    # Check that migration was applied (not just version bumped)
    npm run validate-taxonomy -- --branch ${{ github.base_ref }}
```

### Edge Case: Hotfix During Migration Window

If prod needs a taxonomy edit while dev is on v2 but prod is still on v1:

1. Hotfix branch from `main` (v1 data)
2. Edit in v1 format (prod app still writes v1)
3. Merge to `main`
4. **Downward sync**: When merging `main` into `beta`/`dev`, the migration script re-applies to the hotfixed data. The merge will show a conflict on `_schema_version` — resolve by keeping v2 and re-migrating the hotfixed nodes.

This is the one scenario that requires manual intervention. The rebase conflict UI already handles file-level conflicts; we add a `taxonomy-migration-conflict` handler that detects version mismatches and offers "re-migrate this file" as a resolution option.

---

## Implementation Plan

### Phase 1: Infrastructure (Bicep + CI/CD)

| Task | Owner | Description |
|------|-------|-------------|
| 1.1 | Azure/SRE | Parameterize `main.bicep` with `environment` parameter |
| 1.2 | Azure/SRE | Update `deploy.ps1` with `-Environment` parameter |
| 1.3 | Azure/SRE | Deploy dev and beta environments (Bicep) |
| 1.4 | Azure/SRE | Update `container.yml` for multi-tag builds (`:dev`, `:beta`, `:latest`) |
| 1.5 | Azure/SRE | Create `promotion.yml` workflow for image retagging + deploy |
| 1.6 | Azure/SRE | Configure environment-specific env vars (branch names, auth settings) |

### Phase 2: Data Branch Model

| Task | Owner | Description |
|------|-------|-------------|
| 2.1 | Tech Lead | Create `dev` and `beta` branches in `ai-triad-data` repo |
| 2.2 | Shared Lib | Add `DATA_BRANCH` env var to `gitRepoStore.ts` — clone/sync to specific branch |
| 2.3 | Shared Lib | Implement periodic upstream poll (5-min interval, WebSocket broadcast on change) |
| 2.4 | Shared Lib | Implement downward sync: merge main→beta→dev on schedule or trigger |
| 2.5 | Taxonomy Editor | Add environment badge to UI header (green=dev, yellow=beta, red=prod) |

### Phase 3: Schema Migration Framework

| Task | Owner | Description |
|------|-------|-------------|
| 3.1 | Shared Lib | Create migration registry format + runner (`taxonomy/migrations/`) |
| 3.2 | Shared Lib | Add runtime schema version gate to `fileIO.ts` (load-time validation) |
| 3.3 | Shared Lib | Build `migrate` CLI command (`npm run migrate -- --from X --to Y`) |
| 3.4 | PowerShell | Mirror migration runner in PS (`Invoke-TaxonomyMigration`) |
| 3.5 | Azure/SRE | Create `taxonomy-validation.yml` CI workflow for PR checks |

### Phase 4: Promotion Workflow

| Task | Owner | Description |
|------|-------|-------------|
| 4.1 | Tech Lead | Define PR templates for dev→beta and beta→main promotions |
| 4.2 | Azure/SRE | Configure branch protection rules (approver counts, required checks) |
| 4.3 | Taxonomy Editor | Add "Promote to Beta" / "Promote to Prod" buttons in Sync panel (creates PR) |
| 4.4 | Shared Lib | Build taxonomy diff summary generator (for PR comments) |

### Phase 5: Operational Hardening

| Task | Owner | Description |
|------|-------|-------------|
| 5.1 | Azure/SRE | Monitoring: alerts for sync failures, schema version drift between environments |
| 5.2 | Azure/SRE | Backup: daily snapshots of prod Azure Files share |
| 5.3 | Tech Lead | Runbook: emergency rollback procedure (revert data + app to last known good) |
| 5.4 | Tech Lead | Runbook: breaking schema change deployment checklist |

## Cost Impact

| Resource | Current (1 env) | Projected (3 envs) | Notes |
|----------|-----------------|---------------------|-------|
| Container Apps | ~$15/mo | ~$25/mo | Scale-to-zero means idle envs cost near $0 |
| Azure Files | ~$0.60/mo (10GB) | ~$1.80/mo (30GB) | 10GB per share |
| Key Vault | ~$0.03/mo | ~$0.09/mo | Per-secret pricing, minimal |
| Log Analytics | ~$2/mo | ~$4/mo | 30-day retention, low volume |
| **Total** | **~$18/mo** | **~$31/mo** | +$13/mo for two additional environments |

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Schema version drift (env on wrong version) | Medium | High | Runtime version gate blocks incompatible loads with actionable error |
| Merge conflicts during promotion | Medium | Medium | Rebase conflict UI already exists; add migration-aware conflict handler |
| Hotfix during migration window | Low | High | Document procedure; re-migration handler in conflict UI |
| Data loss during sync | Low | Critical | Git is the source of truth; Azure Files is a cache. Loss = re-clone |
| Cost overrun | Low | Low | Scale-to-zero; total ~$31/mo for all three environments |

## Decision Points for User

1. **Shared vs separate resource groups?** Plan uses one resource group with suffixed resources. Alternative: three resource groups for strict isolation (slightly more cost, better security boundary).

2. **Downward sync strategy**: Auto-merge (less friction, potential conflicts) vs manual PR (more control, more work)?

3. **Migration script language**: TypeScript (runs in Node, matches app) vs PowerShell (matches existing `Invoke-*Migration` pattern) vs both?

4. **Beta access model**: Same allowlist as prod (stakeholders test with their own accounts) vs separate allowlist (test accounts)?
