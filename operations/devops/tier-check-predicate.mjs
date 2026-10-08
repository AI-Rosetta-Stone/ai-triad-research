/**
 * Pure predicate for the advisory tier-declaration check (t/4103, t/4092 SO dissent 2).
 *
 * Known blanks (named at the point of use per TL design review, t/4103#6/#7 — not closed by
 * this check, each is a visible surviving vector):
 *  - data-mutation tooling (migrate/backfill/restore scripts): execution is gated by
 *    /data-mutation's recorded-authorization requirement, not by this PR-time check.
 *  - a lint severity raised through a shared preset or `extends` rather than an inline rule
 *    entry in the config file itself — R2c only scans the config file's own diff text.
 *  - a required context added through branch-protection API/UI: not visible in any PR diff,
 *    and changing branch protection is a PI-only setting outside this repo anyway.
 *  - a T2 change landing in a file this repo's R1 list doesn't yet name.
 *  - a truthful-looking but wrong `Schema-change: additive` line — R3 only checks the line
 *    exists and its value, never whether the diff actually matches that claim.
 *  - branch-protection or ruleset changes made through the GitHub API/UI directly: outside
 *    this repo's diff entirely.
 *  - overlay-repo gates (`.orca/feedback-rules/*`, `.orca-git` hooks): tracked in a separate
 *    repo, invisible to this check.
 *  - `.githooks/*` local pre-commit gates: not currently on R1; the t/4103 replay showed these
 *    change rarely, so they're left as a named blank rather than added speculatively.
 */

const TIER_LINE_RE = /^Tier:\s*T([012])\b/;
const SCHEMA_CHANGE_RE = /^Schema-change:\s*(additive|breaking)\b/m;
const SEVERITY_ADD_RE = /(['"])error\1|:\s*2\b/;
const PSD1_ERROR_RE = /\bError\b/;
const RULE_KEY_RE = /['"]([\w./-]+)['"]\s*:/;
const CONTINUE_ON_ERROR_RE = /^\s*continue-on-error:\s*true\s*$/;
const TEST_FILE_RE = /\.test\.|__tests__\//;
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#)/;

export function extractTier(body) {
  if (!body) return null;
  const firstLine = body.trim().split('\n')[0].trim();
  const m = TIER_LINE_RE.exec(firstLine);
  return m ? `T${m[1]}` : null;
}

export function extractSchemaChange(body) {
  if (!body) return null;
  const m = SCHEMA_CHANGE_RE.exec(body);
  return m ? m[1] : null;
}

export function isDependabot(headRefName) {
  return (headRefName ?? '').startsWith('dependabot/');
}

/** @param {string[]} paths @param {{r1Paths: string[], r1Globs: string[]}} config */
export function checkR1(paths, config) {
  for (const p of paths) {
    if (config.r1Paths.includes(p)) return p;
    for (const g of config.r1Globs ?? []) {
      if (matchGlob(p, g)) return p;
    }
  }
  return null;
}

// Small dependency-free glob matcher: supports a single trailing '*' segment, which is all
// R1's glob entries need (e.g. 'operations/devops/Move-PiCredential*.ps1').
function matchGlob(path, glob) {
  const re = new RegExp('^' + glob.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(path);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * R2a: a workflow-yml diff hunk that REMOVES a `continue-on-error: true` line.
 * @param {Array<{path: string, removedLines: string[]}>} workflowDiffs
 */
export function checkR2a(workflowDiffs) {
  for (const d of workflowDiffs) {
    if (!/^\.github\/workflows\/.*\.ya?ml$/.test(d.path)) continue;
    if (d.removedLines.some((l) => CONTINUE_ON_ERROR_RE.test(l))) return d.path;
  }
  return null;
}

/**
 * R2b: an entry ADDED to the `ci-gate` job's `needs:` set in .github/workflows/ci.yml.
 * Compares the parsed sets (not diff lines) because the list wraps across lines.
 * @param {string[]|null} baseNeeds @param {string[]|null} headNeeds
 */
export function checkR2b(baseNeeds, headNeeds) {
  if (!headNeeds) return null;
  const base = new Set(baseNeeds ?? []);
  const added = headNeeds.filter((n) => !base.has(n));
  return added.length > 0 ? added : null;
}

/**
 * R2c: a lint severity raised to 'error' in an eslint/PSScriptAnalyzer config file.
 * Exception: don't fire if a removed line in the same hunk already had 'error' for the same
 * rule key (moving/reformatting an existing error rule doesn't count).
 * @param {Array<{path: string, addedLines: string[], removedLines: string[]}>} lintDiffs
 * @param {{r2cGlobs: string[]}} config
 */
export function checkR2c(lintDiffs, config) {
  const hits = [];
  for (const d of lintDiffs) {
    if (!config.r2cGlobs.some((g) => matchGlob(d.path, g))) continue;
    const isPsd1 = /\.psd1$/.test(d.path);
    const severityRe = isPsd1 ? PSD1_ERROR_RE : SEVERITY_ADD_RE;

    const removedErrorKeys = new Set();
    for (const line of d.removedLines) {
      if (COMMENT_LINE_RE.test(line)) continue;
      if (!severityRe.test(line)) continue;
      const km = RULE_KEY_RE.exec(line);
      removedErrorKeys.add(km ? km[1] : `__line__:${line.trim()}`);
    }

    for (const line of d.addedLines) {
      if (COMMENT_LINE_RE.test(line)) continue;
      if (!severityRe.test(line)) continue;
      const km = RULE_KEY_RE.exec(line);
      const key = km ? km[1] : `__line__:${line.trim()}`;
      if (removedErrorKeys.has(key)) continue; // same-key reformat/move, not a raise
      hits.push({ path: d.path, line: line.trim() });
    }
  }
  return hits.length > 0 ? hits : null;
}

/** @param {string[]} paths @param {string|null} schemaChange @param {string|null} tier
 *  @param {{schemaDirPrefixes: string[]}} config */
export function checkR3(paths, schemaChange, tier, config) {
  const hits = paths.filter((p) => config.schemaDirPrefixes.some((pre) => p.startsWith(pre)) && !TEST_FILE_RE.test(p));
  if (hits.length === 0) return null;
  if (!schemaChange) return { kind: 'missing_line', path: hits[0] };
  if (schemaChange === 'breaking' && tier !== 'T2') return { kind: 'breaking_no_t2', path: hits[0] };
  return null;
}

/** @param {string|null} tier @param {boolean} dependabot @param {Date} prCreatedAt @param {Date} graceCutoff */
export function checkR4(tier, dependabot, prCreatedAt, graceCutoff) {
  if (dependabot) return false;
  if (tier !== null) return false;
  return prCreatedAt >= graceCutoff;
}

/** R5: advisory only — never changes pass/fail. @param {string|null} tier @param {string[]} labels */
export function checkR5(tier, labels) {
  if (tier !== 'T2') return false;
  return !(labels ?? []).includes('consult-hold');
}

/**
 * Combine R1-R5 into one verdict. `pass` reflects R1-R4 only (R5 is advisory and never fails
 * the check). `comments` lists human-readable advisory text for any hit, including R5.
 */
export function evaluateTierCheck(input) {
  const { body, headRefName, paths, prCreatedAt, graceCutoff, labels, config, workflowDiffs, lintDiffs, baseCiGateNeeds, headCiGateNeeds } = input;
  const tier = extractTier(body);
  const schemaChange = extractSchemaChange(body);
  const dependabot = isDependabot(headRefName);

  const r1 = checkR1(paths, config);
  const r2a = checkR2a(workflowDiffs ?? []);
  const r2b = checkR2b(baseCiGateNeeds ?? null, headCiGateNeeds ?? null);
  const r2c = checkR2c(lintDiffs ?? [], config);
  const r3 = checkR3(paths, schemaChange, tier, config);
  const r4 = checkR4(tier, dependabot, prCreatedAt, graceCutoff);
  const r5 = checkR5(tier, labels);

  const failures = [];
  if (r1 && tier !== 'T2') failures.push({ rule: 'R1', detail: `touches ${r1}, must declare Tier: T2` });
  if (r2a && tier !== 'T2') failures.push({ rule: 'R2a', detail: `removes continue-on-error: true in ${r2a}, must declare Tier: T2` });
  if (r2b && tier !== 'T2') failures.push({ rule: 'R2b', detail: `adds ${r2b.join(', ')} to ci-gate's needs:, must declare Tier: T2` });
  if (r2c && tier !== 'T2') failures.push({ rule: 'R2c', detail: `raises lint severity to error (${r2c.map((h) => h.path).join(', ')}), must declare Tier: T2` });
  if (r3?.kind === 'missing_line') failures.push({ rule: 'R3', detail: `touches ${r3.path}, needs a Schema-change: additive|breaking line` });
  if (r3?.kind === 'breaking_no_t2') failures.push({ rule: 'R3', detail: `Schema-change: breaking in ${r3.path} must declare Tier: T2` });
  if (r4) failures.push({ rule: 'R4', detail: 'no Tier: T0|T1|T2 line in the PR body' });

  const comments = failures.map((f) => `${f.rule}: ${f.detail}`);
  if (r5) comments.push('R5 (advisory): declared Tier: T2 but the consult-hold label is missing');

  return { tier, pass: failures.length === 0, failures, r5Advisory: r5, comments };
}
