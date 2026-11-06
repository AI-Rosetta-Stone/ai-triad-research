# Dev Commands, Testing & Verify Gate

> Extracted from the root `AGENTS.md` for token efficiency (t/1730). This is reference detail read on demand — not always-on behavioral guidance.

## Build & Test Commands

```powershell
# Load the PowerShell module (required before using any cmdlet)
Import-Module ./scripts/AITriad/AITriad.psm1

# Run all Pester tests
Invoke-Pester ./tests/

# Agent-facing bounded run (wall-clock and memory ceiling; prints failed test names and summary line only)
./scripts/Invoke-BoundedTestRun.ps1 -Path ./tests/<file>.Tests.ps1

# Run a single Pester test by name
Invoke-Pester ./tests/ -FullNameFilter '*test name pattern*'

# Build distributable module
./scripts/Build-Module.ps1 -Clean

# Validate built manifest
Test-ModuleManifest -Path ./build/AITriad/AITriad.psd1
```

```bash
# Taxonomy Editor (Electron + React)
cd taxonomy-editor && npm ci && npm test        # run vitest suite
cd taxonomy-editor && npm run test:agent         # agent-facing: dot reporter, failures plus summary only
cd taxonomy-editor && npm run test:watch         # watch mode
cd taxonomy-editor && npm run dev                # dev server (port 5173)
cd taxonomy-editor && npx tsc --noEmit -p tsconfig.main.json  # type check

# POViewer / Summary Viewer (no test suites yet)
cd poviewer && npm ci && npm run dev             # port 5174
cd summary-viewer && npm ci && npm run dev       # port 5175
```

Agents quote the test summary line, not the run. Read CI with `gh run view --log-failed`, never `--log`.

## Dependency Graph

Before making cross-cutting changes, check the blast radius with the dependency graph tool:

```bash
cd taxonomy-editor
node scripts/depgraph.mjs --stats              # overview: file counts, top importers
node scripts/depgraph.mjs --reverse <pattern>  # who imports this module?
node scripts/depgraph.mjs --query <pattern>    # what does this module import?
node scripts/depgraph.mjs --orphans            # files imported by nothing
```

## Repository Map

`REPO_MAP.md` (root) is an auto-generated index of TypeScript files ranked by import count, with top exported symbols per file. **Coverage: taxonomy-editor + lib only** (poviewer/summary-viewer are not indexed), top-8 files per directory (leaf components with no importers are omitted — grep for those). Regenerate with:

```bash
cd taxonomy-editor && node scripts/depgraph.mjs --repomap > ../REPO_MAP.md
```

Use it for cross-scope discovery — finding which file defines a symbol or which modules are most central. The map is a snapshot; regenerate after major refactors.

## Verify Gate

Before reporting any task as complete, run the local verification gate:

```bash
cd taxonomy-editor && npm run verify   # tsc (main+server) + eslint + depcruise + vitest + vite build
```

`verify` type-checks **both** `tsconfig.main.json` and `tsconfig.server.json` and ends with `vite build`, because three classes of breakage have reached `main` that a main-tsc-only gate missed: a renderer importing a not-yet-committed module (`UNRESOLVED_IMPORT`), a renderer importing a missing export (`MISSING_EXPORT`), and a server-only type error (e.g. a backend-id union diverging across packages). `vite build` catches the first two; `tsc -p tsconfig.server.json` catches the third. Commit new files **before** running verify, or the import checks pass against your uncommitted working tree but fail in CI.

For PowerShell changes: `Invoke-Pester ./tests/`

## Test Tiers

Use the appropriate tier for each phase of work:

| Tier | When | Command | Target |
|------|------|---------|--------|
| 1 | During development | `npm run test:watch` / `Invoke-Pester -Tag <subsystem>` | <10s |
| 2 | Pre-push | `npm run verify` + `Invoke-Pester ./tests/` | ~2-3 min |
| 3 | CI (PR) | Auto — runs on push/PR to main | ~2-3 min |
| 4 | Release | Manual pre-deploy (includes `@slow`-tagged tests) | ~10-15 min |

Use Tier 1 while coding — fast feedback on what you changed. Run Tier 2 before pushing. CI handles Tier 3. Tier 4 is manual pre-deploy.

### Pester Tag Registry

All 48 suites in `tests/` are tagged. Use `Invoke-Pester ./tests/ -Tag <tag>`:

| Tag | Suites | Covers |
|-----|--------|--------|
| `health` | 17 | Remote health checks, endpoint smoke tests, personas |
| `ingestion` | 9 | Document import, summary pipeline, chunk merging |
| `taxonomy` | 7 | Taxonomy load, integrity, graph queries |
| `template` | 5 | Prompt template rendering |
| `debate` | 4 | Debate cmdlets, output repair |
| `enrichment` | 3 | UsageID registry, AI enrichment cmdlets |
| `Build` / `config` / `powershell` | 1 each | Module build, TriadConfig, module surface |

Note: summary-pipeline tests live under `ingestion`, not a "summary" tag.

## CI Pipeline (`.github/workflows/ci.yml`)

Four jobs on push/PR to main:
1. **changes** — `dorny/paths-filter` gate (skips unaffected jobs)
2. **test-powershell** — Pester tests, module build, manifest validation
3. **test-electron** — `npm ci`, TypeScript check, build (taxonomy-editor only)
4. **test-container** — container build check

## Version Update Checklist

When bumping the module version, verify that **all** of the following are updated consistently:

1. `scripts/AITriad/AITriad.psd1` — source manifest (`ModuleVersion`)
2. `build/AITriad/AITriad.psd1` — built manifest (rebuilt via `Build-Module.ps1 -Clean`)

After updating, run `Test-ModuleManifest -Path ./build/AITriad/AITriad.psd1` to confirm the build is coherent. Never publish to PSGallery without rebuilding first — the build manifest must match the source manifest. (The version is no longer hardcoded in the root `AGENTS.md`; read it from the manifest.)
