// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Bypass guard for lib's complexity ratchet (t/3823 Phase 2, SO e/286#2 condition 2), and — behind the
// --include-tests flag (t/4442 part 2, TL e/365#2) — a second, narrower bypass guard for require-windows-hide
// in test files, for the three apps (poviewer, summary-viewer, workflow-app) that lint their tests with it.
//
// ESLint honours inline directives silently: `/* eslint-disable local/complexity-budget */` (or a blanket
// `/* eslint-disable */`, or `/* eslint local/complexity-budget: off */`) drops a file out of the gate with
// no CI signal. This check refuses those directives in the gated population.
//
// It is a SEPARATE PROCESS on purpose, not an ESLint rule: a blanket `eslint-disable` would switch off a
// guard rule along with the gate, and no source comment can reach this script. It runs from lib's `lint`
// npm script (`eslint . && node eslint-rules/check-complexity-budget-disables.mjs`), so CI's lib-lint
// "Lint" step runs it with no workflow change.
//
// Comments are found by the TypeScript parser, not a regex (t/4114), so a string such as 'src/*'
// can't open a false comment that hides a real directive; see findComments() below.
//
// Refused, in non-test .ts/.tsx under the scanned root (the population the complexity gate covers):
//   - eslint-disable / -line / -next-line naming any rule ending in `complexity-budget`
//   - eslint-disable / -line / -next-line with NO rule list (blanket: it disables the gate too)
//   - an inline config comment `/* eslint <rule>: <severity> */` naming a rule ending in `complexity-budget`
// These FAIL the run (exit 1) — unchanged by --include-tests, and identical with or without the flag.
//
// --include-tests (t/4442 part 2): also scans test files (*.test.ts/*.spec.ts and anything under a
// __tests__ dir), refusing in THEM:
//   - eslint-disable / -line / -next-line with NO rule list (blanket — it silences require-windows-hide
//     there too, since poviewer/summary-viewer/workflow-app apply it to test files at `error`, unlike
//     lib/taxonomy-editor's deliberate test exemption)
//   - eslint-disable / -line / -next-line naming any `require-windows-hide*` rule id (including
//     require-windows-hide-disable-reason itself — a named disable of the GUARD rule is a residual
//     ESLint's own rule can't catch, since it only watches disables of the two rules it guards, not of
//     itself)
//   - the equivalent inline config form
// These are Phase 1, WARN-ONLY (t/4442 part 2, TL e/365#2): printed as `::warning::` and never fail the
// run. Promoting them to blocking is a separate, later T2 change (SO round, then TL), once a full clean
// CI cycle shows 0 hits in all three apps.
//
// Without --include-tests, behavior for lib and taxonomy-editor is exactly as it has always been: test
// files are not walked at all, and the two apps' deliberate warn-only, test-exempt require-windows-hide
// wiring (t/4442 part 1) is untouched by this script either way.
//
// To RAISE a file's complexity budget instead, see the raise path in lib/eslint.config.mjs (a reviewed
// hand edit of the baseline). The generator never raises a number.

import { readFileSync, readdirSync } from 'fs';
import { join, relative, extname, sep } from 'path';
import { pathToFileURL } from 'url';
import ts from 'typescript';

const GATED_EXTS = new Set(['.ts', '.tsx']);
const ALWAYS_SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);
const isTestFileName = (p) => /\.(test|spec)\.tsx?$/.test(p);
// A file is in the test population if its own name says so, OR it lives under a __tests__ dir anywhere
// in its path (a helper file there need not itself be named *.test.ts).
const isTestPath = (relPath) => isTestFileName(relPath) || relPath.split(/[\\/]/).includes('__tests__');

const DISABLE_RE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)([\s\S]*)$/;
const INLINE_CONFIG_RE = /^\s*eslint\s+([\s\S]+)$/;
const isBudgetRule = (name) => /(^|\/)complexity-budget$/.test(name.trim());
// Matches all three ids this family has ever had: require-windows-hide, -unverifiable, -disable-reason
// (the guard rule itself — see the --include-tests header note on why it's included here).
const isWindowsHideRule = (name) => /(^|\/)require-windows-hide(-unverifiable|-disable-reason)?$/.test(name.trim());
const isJSDocNode = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * Every real comment in `source`, found by the TypeScript PARSER, not a regex (t/4114, SO e/286#7).
 * A regex can't tell a comment from a string, template or regex literal: `'src/*'` used to open a false
 * comment that could swallow a real `eslint-disable`. A bare `ts.createScanner` loop has the same flaw for
 * template substitutions and regex literals, because it scans without parser context.
 *
 * Every comment in code is trivia attached to some token: either on the same line after a token (that
 * token's TRAILING comments) or after a newline before the next token (that token's LEADING comments).
 * So we walk every token leaf of the parsed tree, collect both, and dedupe by position. Strings,
 * templates, regex literals and JSX text are tokens, not trivia, so they are never reported. JSDoc
 * sub-nodes are skipped (their leaves sit INSIDE a comment); the JSDoc comment itself is still collected
 * as a leading comment of the next real token.
 *
 * REMAINING LIMIT: a file that does not parse still yields its parseable comments; tsc and eslint fail on
 * such a file anyway, so the gate is never green on it.
 * @param {string} source
 * @param {string} fileName  `.tsx` parses JSX; anything else parses as TypeScript
 * @returns {{ pos: number, text: string, body: string }[]}
 */
export function findComments(source, fileName = 'file.ts') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  // JSX text is undelimited, so the comment-range scan at its boundaries would misread `<div>/* x */</div>`
  // as a comment. Record JSX text spans and drop any range inside one (a real `{/* x */}` is not JSX text).
  const jsxText = [];
  const add = (rs) => { for (const r of rs ?? []) if (!ranges.has(r.pos)) ranges.set(r.pos, r); };
  const visit = (node) => {
    if (isJSDocNode(node)) return;
    if (node.kind === ts.SyntaxKind.JsxText) { jsxText.push([node.pos, node.end]); return; }
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      add(ts.getLeadingCommentRanges(source, node.pos));
      add(ts.getTrailingCommentRanges(source, node.end));
      return;
    }
    for (const k of kids) visit(k);
  };
  add(ts.getLeadingCommentRanges(source, 0));
  visit(sf);
  const inJsxText = (r) => jsxText.some(([s, e]) => r.pos >= s && r.end <= e);
  return [...ranges.values()].filter((r) => !inJsxText(r)).sort((a, b) => a.pos - b.pos).map((r) => {
    const text = source.slice(r.pos, r.end);
    const body = r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? text.slice(2, -2) : text.slice(2);
    return { pos: r.pos, text, body };
  });
}

/**
 * The bypass directives in one file's source. Pure, for tests.
 * @param {string} source
 * @param {string} [fileName]  pass the real name so `.tsx` parses as JSX
 * @param {{ testMode?: boolean }} [opts]  testMode (t/4442 part 2): check for require-windows-hide*
 *   disables instead of complexity-budget ones. Defaults to false — omitting `opts` entirely reproduces
 *   this function's exact pre-t/4442 behavior.
 * @returns {{ line: number, directive: string, reason: string }[]}
 */
export function findBypasses(source, fileName = 'file.ts', opts = {}) {
  const testMode = opts.testMode ?? false;
  const namedMatcher = testMode ? isWindowsHideRule : isBudgetRule;
  const found = [];
  for (const c of findComments(source, fileName)) {
    const body = c.body;
    const line = source.slice(0, c.pos).split('\n').length;
    const directive = (c.text.length > 120 ? `${c.text.slice(0, 117)}...` : c.text).replace(/\s+/g, ' ');
    const disable = DISABLE_RE.exec(body);
    if (disable) {
      const rules = disable[1].split(/\s--\s|\s--$/)[0].split(',').map((r) => r.trim()).filter(Boolean);
      if (rules.length === 0) {
        found.push({ line, directive, reason: testMode
          ? 'blanket eslint-disable in a test file (silences require-windows-hide there too)'
          : 'blanket eslint-disable (switches off the complexity gate too)' });
      } else if (rules.some(namedMatcher)) {
        found.push({ line, directive, reason: testMode
          ? 'disables a require-windows-hide rule in a test file'
          : 'disables local/complexity-budget' });
      }
      continue;
    }
    const inline = INLINE_CONFIG_RE.exec(body);
    if (inline && !/^\s*(env|globals?)\b/.test(inline[1])) {
      const names = inline[1].split(',').map((kv) => kv.split(':')[0]);
      if (names.some(namedMatcher)) {
        found.push({ line, directive, reason: testMode
          ? 'reconfigures a require-windows-hide rule inline in a test file'
          : 'reconfigures local/complexity-budget inline' });
      }
    }
  }
  return found;
}

function* walk(dir, includeTests) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === '__tests__' && !includeTests) continue;
      yield* walk(full, includeTests);
      continue;
    }
    if (!GATED_EXTS.has(extname(entry.name))) continue;
    if (!includeTests && isTestFileName(entry.name)) continue;
    yield full;
  }
}

/**
 * Scan `root`. Returns the violations, keyed by root-relative path, each tagged `testFile` so the CLI
 * (and a caller like the taxonomy-editor test suite) can tell the two populations apart.
 * @param {string} root
 * @param {{ includeTests?: boolean }} [opts]  includeTests (t/4442 part 2): also walk test files, and
 *   check THEM for require-windows-hide* disables instead of complexity-budget ones. Defaults to false —
 *   omitting `opts` entirely reproduces this function's exact pre-t/4442 behavior (test files untouched).
 */
export function scan(root, opts = {}) {
  const includeTests = opts.includeTests ?? false;
  let files = 0;
  const violations = [];
  for (const file of walk(root, includeTests)) {
    files++;
    const relPath = relative(root, file).split(sep).join('/');
    const testFile = includeTests && isTestPath(relPath);
    for (const v of findBypasses(readFileSync(file, 'utf8'), file, { testMode: testFile })) {
      violations.push({ file: relPath, testFile, ...v });
    }
  }
  return { files, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const includeTests = args.includes('--include-tests');
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();
  const { files, violations } = scan(root, { includeTests });
  const blocking = violations.filter((v) => !v.testFile);
  const testWarnings = violations.filter((v) => v.testFile);

  // Test-file findings are Phase 1 (t/4442 part 2): visible, never blocking.
  for (const v of testWarnings) console.log(`::warning file=${v.file},line=${v.line}::${v.reason}: ${v.directive}`);

  if (blocking.length > 0) {
    for (const v of blocking) console.error(`${v.file}:${v.line}  ${v.reason}: ${v.directive}`);
    console.error(`\ncomplexity-budget bypass check FAILED: ${blocking.length} directive(s) in ${files} gated files.`);
    console.error('An inline disable silently removes a file from the complexity ratchet (SO e/286#2 C2).');
    console.error('To raise a budget, use the reviewed raise path in lib/eslint.config.mjs instead.');
    process.exit(1);
  }
  const testNote = includeTests ? `, ${testWarnings.length} test-file warning(s) (t/4442 part 2, warn-only)` : '';
  console.log(`complexity-budget bypass check passed: ${files} gated files, 0 bypass directives${testNote}.`);
}
