// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate for the advisory code-root-allowlist check (t/4665).
 *
 * The class: #4167 added 8 TS files under a stray top-level `src/` that no vite/vitest config,
 * tsconfig, or CI job reads -- nothing built or tested them, and CI still went green. The fix
 * isn't a hardcoded list of "real" roots (that drifts the moment a new app/package is added) --
 * it's comparing the PR's changed files against the set of top-level directories that ALREADY
 * exist on `main`'s own tip. A code/test file landing under a top-level name `main` has never
 * seen is exactly the #4167 shape, whether that's a typo'd path or a genuinely new root that
 * just hasn't been introduced to main yet (in which case it still needs a human look before
 * anything builds/tests it).
 *
 * Advisory only (per the ticket): a match is a warning, never a failure. Promotion to blocking
 * is a separate T2 change, same pattern as every other advisory-first check in this repo
 * (tier-check, ci-shared-input-coverage, t1-approval-guard).
 */

const CODE_TEST_EXTENSION_RE = /\.(ts|tsx|js|jsx|mjs|cjs|ps1|psm1|py)$/i;

/**
 * @param {string[]} allowlistRoots top-level directory names that exist on main's tip
 *   (e.g. from `git ls-tree -d --name-only <sha>`).
 * @param {string[]} changedPaths repo-relative paths changed in the PR.
 * @returns {{violations: Array<{path: string, root: string}>}}
 */
export function evaluateRootAllowlist(allowlistRoots, changedPaths) {
  const rootSet = new Set(allowlistRoots ?? []);
  const violations = [];
  for (const p of changedPaths ?? []) {
    if (!p || !CODE_TEST_EXTENSION_RE.test(p)) continue;
    const topSegment = p.split('/')[0];
    // A file with no '/' (bare repo-root file) has no "root" to allowlist against -- not this
    // check's concern (root-level config files like vite.config.ts are expected and legitimate).
    if (!topSegment || topSegment === p) continue;
    if (!rootSet.has(topSegment)) {
      violations.push({ path: p, root: topSegment });
    }
  }
  return { violations };
}

/** Formats violations as a human-readable PR comment body, or null if clean. */
export function formatRootAllowlistComment(violations) {
  if (!violations || violations.length === 0) return null;
  const lines = [
    '**code-root-allowlist (advisory, t/4665)**',
    '',
    "Code or test file(s) sit under a top-level directory that doesn't exist on `main` — nothing currently builds or tests them:",
    '',
  ];
  for (const v of violations) {
    lines.push(`- \`${v.path}\` — stray top-level root \`${v.root}/\``);
  }
  lines.push(
    '',
    "If this is a deliberate new root (a new app or package), that's fine — just confirm something actually builds/tests it (a CI job, a vitest `include`, a tsconfig) before merging. If it's a mistake, move the file(s) under the correct existing root.",
    '',
    '_This check is advisory and never blocks a merge. See t/4665._',
  );
  return lines.join('\n');
}

/**
 * Second (optional) arm: every test file under a RECOGNIZED root should be matched by at least
 * one app's vitest `include` glob, or it silently never runs (the #4167 shape one level deeper —
 * a test file that's under a real root but still outside every config that would ever execute
 * it). Text-extracted `include` arrays (string literals only, not a full AST parse) — a known,
 * accepted limitation for a warn-only check; a config using anything other than a plain string
 * array for `include` is simply not checked by this arm and reports no violation for its files,
 * which is the safe failure direction (never a false positive blocking someone else's green PR).
 *
 * `resolvedIncludeGlobs` must ALREADY be fully resolved to repo-root-relative patterns by the
 * caller (see `resolveIncludeGlobs` below) — this function does no path math itself. This is
 * load-bearing: taxonomy-editor's vite config sets `root: 'src/renderer'` and lists globs like
 * `../../../lib/debate/**\/*.test.ts` — naively gating on "does the path start with the app's
 * own directory name" (an earlier version of this check) flags EVERY lib/debate test file as
 * uncovered, even though taxonomy-editor's real vitest run covers them. Resolving each glob
 * against its config's OWN root first, before matching, is what avoids that false positive.
 *
 * Uses `matchGlobZeroOrMoreDirs` below, NOT cl-path-check-predicate.mjs's shared `matchGlob` —
 * that shared matcher's `**` requires at least one intermediate directory segment (non-standard;
 * `a/**\/b` does not match literal `a/b` there), which is exactly the real shape of this repo's
 * `lib/debate/*.test.ts` files (flat, zero intermediate dirs under the `**`). Reusing it here
 * would false-positive on every already-covered, untouched-for-years lib/debate/chat/etc. test
 * file the moment anyone edits one — worse than no arm 2 at all. Fixing the shared matcher's
 * semantics is a separate, wider-blast-radius change outside this ticket's scope.
 *
 * @param {string[]} testFilePaths repo-relative paths of changed files matching a test naming
 *   convention (e.g. already pre-filtered by the caller to *.test.ts / *.test.tsx / *.spec.ts).
 * @param {string[]} resolvedIncludeGlobs every app's `include` globs, already resolved to be
 *   repo-root-relative (e.g. 'lib/debate/**\/*.test.ts', not '../../../lib/debate/**\/*.test.ts').
 * @returns {{uncovered: string[]}}
 */
export function evaluateVitestIncludeCoverage(testFilePaths, resolvedIncludeGlobs) {
  const uncovered = [];
  for (const p of testFilePaths ?? []) {
    const covered = (resolvedIncludeGlobs ?? []).some((g) => matchGlobZeroOrMoreDirs(p, g));
    if (!covered) uncovered.push(p);
  }
  return { uncovered };
}

/**
 * Standard-semantics glob match: `**` matches zero or more path segments (including zero —
 * `a/**\/b` matches literal `a/b`), `*` matches within one segment. Deliberately separate from
 * cl-path-check-predicate.mjs's `matchGlob` (see the note above on why reusing it here would
 * false-positive on this repo's real flat lib/*.test.ts files).
 */
export function matchGlobZeroOrMoreDirs(filePath, glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(/\*\*\//g, '(?:.*/)?');
  pattern = pattern.replace(/\*\*/g, '.*');
  pattern = pattern.replace(/\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`).test(filePath);
}

/**
 * Resolves a config's `include` globs (which may contain `../` segments, relative to the
 * config's own `root:` option if set, else the config's own directory) into repo-root-relative
 * glob patterns. Pure string/path math — no filesystem access.
 * @param {string} configDir repo-relative directory containing the config file (e.g. 'taxonomy-editor').
 * @param {string|null} rootOption the config's own `root:` option text, if any (e.g. 'src/renderer'),
 *   relative to configDir. Null/undefined means the config's own directory is the base.
 * @param {string[]} rawGlobs the globs as written in the config (relative to the resolved base).
 * @returns {string[]}
 */
export function resolveIncludeGlobs(configDir, rootOption, rawGlobs) {
  const base = rootOption ? `${configDir}/${rootOption}` : configDir;
  return (rawGlobs ?? []).map((g) => posixJoinNormalize(base, g));
}

/** Minimal POSIX path join + `.`/`..` normalization, glob-segment-safe (treats `**`/`*` as opaque). */
function posixJoinNormalize(base, rel) {
  const segments = [...base.split('/'), ...rel.split('/')].filter((s) => s !== '' && s !== '.');
  const resolved = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else resolved.push(seg);
  }
  return resolved.join('/');
}

/**
 * Text-extracts a vitest config's `root: '...'` option, if present. Returns null if absent —
 * the caller treats that as "base is the config's own directory", never as an empty string.
 * @param {string} configText
 * @returns {string | null}
 */
export function extractRootOption(configText) {
  if (!configText) return null;
  const match = configText.match(/\broot\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * Text-extracts a vitest/vite config's `include: [...]` string-literal array. Returns `null`
 * (not an empty array) when no `include:` array of string literals is found — the caller must
 * treat `null` as "can't evaluate this config" (skip it), never as "this config covers nothing."
 * @param {string} configText
 * @returns {string[] | null}
 */
export function extractIncludeGlobs(configText) {
  if (!configText) return null;
  const match = configText.match(/include\s*:\s*\[([^\]]*)\]/s);
  if (!match) return null;
  const items = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return items.length > 0 ? items : null;
}
