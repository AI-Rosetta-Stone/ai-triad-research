// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Pure predicate: does a PR's changed-file set make it "user-facing" for the Design gate
// (docs/review-routing.md:35, PI directive 2026-11-02 t/4781)?
//
// t/4952(a): split out of the design, so both `t0-enqueue-sweep.mjs` (this ticket) and the
// future `design-review-guard.yml` (t/4782) read the exact same rule instead of drifting.

const USER_FACING_DIR_RE = [
  /^taxonomy-editor\/src\/renderer\//,
  /^poviewer\/src\//,
  /^summary-viewer\/src\//,
].map((re) => re); // kept as an array of RegExp, not combined, so each is independently testable

const USER_FACING_EXT_RE = /\.(tsx|css)$/;

const EXCLUDED_RE = [
  /\.test\./,
  /\.spec\./,
  /\/__tests__\//,
  /\/__fixtures__\//,
];

const EXACT_USER_FACING_PATHS = new Set([
  'lib/electron-shared/introCopy.ts',
]);

// t/752 (Design's path list, p/18#128 and t/752#2): files outside the renderer that change what a
// user sees: text, order or structure that the app, an export or a share displays. Prompts feed
// the text the model writes; the synthesis, fact-check and export modules shape what is shown.
// Exact paths and one prefix, so a new file next to them is NOT silently gated (add it here).
const DEBATE_GATED_EXACT = new Set([
  'lib/debate/prompts.ts',
  'lib/debate/argumentNetwork/prompts.ts',
  'lib/debate/entrySummaries.ts',
  'lib/debate/factCheckFinding.ts',
  'lib/debate/factCheckValidator.ts',
  'lib/debate/synthesisOrder.ts',
  'lib/debate/synthesisPipeline.ts',
  'lib/debate/synthesisPhases.ts',
  'lib/debate/inquirySynthesis.ts',
  'lib/debate/explorationSummary.ts',
  'lib/debate/debateExport.ts',
  'lib/debate/formatters.ts',
  'lib/debate/types/synthesis.ts',
  'taxonomy-editor/src/renderer/hooks/useDebateStore/shared/factCheckFormat.ts',
  'taxonomy-editor/src/renderer/hooks/useDebateStore/shared/prompts.ts',
]);
const DEBATE_GATED_PREFIX = 'lib/debate/prompts/';

// Design's exemptions for that list: generated files, experiment results (exp-*), and context
// builders, unless prompt wording changes there (not detectable from a path: the author asks
// Design for `Design-exempt` or an approval when it does).
const DEBATE_EXEMPT_RE = [
  /\.generated\.ts$/,
  /(^|\/)exp-[^/]*/,
  /(^|\/)context\.ts$/,
  /(^|\/)(taxonomyContext|vocabularyContext|embedTexts)\.ts$/,
];

/** PURE. True when a path is on Design's list of gated files outside the renderer (t/752). */
export function isDebateGatedPath(path) {
  const p = String(path ?? '');
  if (!p || EXCLUDED_RE.some((re) => re.test(p)) || DEBATE_EXEMPT_RE.some((re) => re.test(p))) return false;
  return DEBATE_GATED_EXACT.has(p) || p.startsWith(DEBATE_GATED_PREFIX);
}

/** PURE. True when a single changed-file path (repo-relative, forward slashes) is user-facing. */
export function isUserFacingPath(path) {
  const p = String(path ?? '');
  if (!p) return false;
  if (EXCLUDED_RE.some((re) => re.test(p))) return false;
  if (EXACT_USER_FACING_PATHS.has(p)) return true;
  if (isDebateGatedPath(p)) return true;
  if (p.endsWith('/index.html') || p === 'index.html') return true;
  if (USER_FACING_EXT_RE.test(p) && USER_FACING_DIR_RE.some((re) => re.test(p))) return true;
  return false;
}

/**
 * PURE. True when any file in the PR's changed-file set is user-facing. `files` is an array of
 * either path strings or objects with a `path` property (matching `gh pr view --json files`'s
 * `{path}` shape), so callers don't need to pre-map.
 */
export function isUserFacing(files) {
  return (files ?? []).some((f) => isUserFacingPath(typeof f === 'string' ? f : f?.path));
}
