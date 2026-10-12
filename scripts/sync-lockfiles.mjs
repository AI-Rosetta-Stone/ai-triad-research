#!/usr/bin/env node
// scripts/sync-lockfiles.mjs
// Single entry point for the t/2188 dual-lockfile footgun (t/4150, t/4109 #8): after any change
// to pnpm-workspace.yaml's overrides: block, BOTH lockfiles need regenerating --
// taxonomy-editor/pnpm-lock.yaml (the standalone copy the Dockerfile prod-deps stage uses) and
// the root pnpm-lock.yaml (what CI's root `pnpm install --frozen-lockfile` checks against).
// The two-command prose kept getting missed (#3167/#3168's ERR_PNPM_OUTDATED_LOCKFILE is the
// live instance) because doing only one half looks locally correct -- `pnpm install` at the root
// never touches the standalone copy, and running the standalone sync alone never updates root.
//
// Fails non-zero if EITHER step fails -- this script is meant to be the one thing a PR runs, so
// a silent partial success here would recreate exactly the footgun it closes.

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(label, command, cwd) {
  console.log(`\n--- ${label} ---`)
  execSync(command, { cwd, stdio: 'inherit' })
}

try {
  run('sync-standalone-lockfile.mjs (taxonomy-editor/pnpm-lock.yaml)', 'node scripts/sync-standalone-lockfile.mjs', repoRoot)
  run('pnpm install --lockfile-only (root pnpm-lock.yaml)', 'pnpm install --lockfile-only', repoRoot)
  console.log('\nBoth lockfiles synced to pnpm-workspace.yaml overrides.')
} catch (err) {
  console.error(`\n::error::sync-lockfiles.mjs: a step failed -- ${err.message}`)
  process.exit(1)
}
