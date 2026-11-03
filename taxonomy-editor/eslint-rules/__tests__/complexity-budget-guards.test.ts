// @vitest-environment node
// Guards around lib's complexity ratchet (t/3823 Phase 2, SO e/286#2):
//  C2: check-complexity-budget-disables.mjs refuses inline bypasses of local/complexity-budget.
//  C1: generate-complexity-baseline.mjs --ext filters the walk and rejects an extension it does not measure.
// Also t/4442 part 2 (TL e/365#2): the same script's --include-tests flag, a second, narrower bypass
// guard for require-windows-hide* in test files (poviewer/summary-viewer/workflow-app only).
// Lives here with the rule's own tests (t/3093 precedent: lib eslint-rules are tested from taxonomy-editor).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
// @ts-expect-error -- plain .mjs module, no type declarations
import { findBypasses, scan } from '../../../lib/eslint-rules/check-complexity-budget-disables.mjs';

type Bypass = { line: number; directive: string; reason: string };
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../lib');
const GENERATOR = path.join(LIB, 'eslint-rules/generate-complexity-baseline.mjs');
const SCRIPT = path.join(LIB, 'eslint-rules/check-complexity-budget-disables.mjs');

describe('C2: inline bypasses of local/complexity-budget are refused', () => {
  it.each([
    ['block disable naming the rule', '/* eslint-disable local/complexity-budget */\nexport const a = 1;'],
    ['block disable among other rules', '/* eslint-disable no-console, local/complexity-budget -- why */\nexport const a = 1;'],
    ['next-line disable naming the rule', '// eslint-disable-next-line local/complexity-budget\nexport const a = 1;'],
    ['same-line disable naming the rule', 'export const a = 1; // eslint-disable-line local/complexity-budget'],
    ['blanket block disable', '/* eslint-disable */\nexport const a = 1;'],
    ['blanket next-line disable', '// eslint-disable-next-line\nexport const a = 1;'],
    ['blanket disable with only a description', '/* eslint-disable -- legacy */\nexport const a = 1;'],
    ['inline config turning the rule off', '/* eslint local/complexity-budget: off */\nexport const a = 1;'],
    ['inline config among other rules', '/* eslint no-console: 0, local/complexity-budget: "off" */\nexport const a = 1;'],
  ])('%s', (_label, src) => {
    const found = findBypasses(src) as Bypass[];
    expect(found).toHaveLength(1);
    expect(found[0].line).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['a disable naming an unrelated rule', '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;'],
    ['an eslint-enable', '/* eslint-enable */\nexport const a = 1;'],
    ['an env/globals config comment', '/* eslint-env node */\n/* global foo */\nexport const a = 1;'],
    ['prose that mentions the rule', '// see local/complexity-budget for the gate\nexport const a = 1;'],
    ['the built-in complexity rule (advisory, not the gate)', '// eslint-disable-next-line complexity\nexport const a = 1;'],
  ])('allows %s', (_label, src) => {
    expect(findBypasses(src)).toEqual([]);
  });

  it('reports the right line and skips test files and node_modules when scanning a tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cb-bypass-'));
    try {
      mkdirSync(path.join(root, 'sub'));
      mkdirSync(path.join(root, 'node_modules'));
      writeFileSync(path.join(root, 'sub/a.ts'), 'export const a = 1;\n\n/* eslint-disable local/complexity-budget */\n');
      writeFileSync(path.join(root, 'sub/a.test.ts'), '/* eslint-disable */\n');
      writeFileSync(path.join(root, 'node_modules/x.ts'), '/* eslint-disable */\n');
      writeFileSync(path.join(root, 'b.tsx'), 'export const b = 1;\n');
      const { files, violations } = scan(root) as { files: number; violations: (Bypass & { file: string })[] };
      expect(files).toBe(2); // sub/a.ts and b.tsx only
      expect(violations).toEqual([expect.objectContaining({ file: 'sub/a.ts', line: 3 })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // t/4114 (SO e/286#7): comments are found by the TypeScript parser, not a regex. The first four arms
  // FAILED on the old regex scanner; they are the discriminating evidence for the switch.
  it.each([
    ['a "src/*" string before a real blanket disable', "const g = 'src/*';\nconst x = 1;\n/* eslint-disable */\nexport const y = 2;", 1],
    ['a template literal containing "// eslint-disable" is not a comment', 'export const t = `\n// eslint-disable\n`;', 0],
    ['a template with a substitution and "/*" before a real disable', 'const b = 1;\nexport const t = `a ${b} /* c`;\n/* eslint-disable local/complexity-budget */', 1],
    ['a regex literal containing "/*" before a real disable', 'export const r = /a\\/*b/;\n/* eslint-disable */\nexport const z = 1;', 1],
    // completeness: comments that are neither before a node nor on a node's line
    ['a disable on its own line before a closing brace', 'export function f(): number {\n  return 1;\n  /* eslint-disable */\n}', 1],
    ['a JSDoc block containing "src/*" is one comment, and the real disable after it is still found', '/** reads src/* for files */\nexport const a = 1;\n/* eslint-disable */', 1],
  ])('parser-based scan: %s', (_label, src, n) => {
    expect(findBypasses(src as string)).toHaveLength(n as number);
  });

  it('JSX text that looks like a directive is not a comment (.tsx parses as JSX)', () => {
    expect(findBypasses('export const e = <div>/* eslint-disable */</div>;', 'x.tsx')).toEqual([]);
    expect(findBypasses('export const e = <div>{/* eslint-disable */}</div>;', 'x.tsx')).toHaveLength(1); // a real JSX comment
  });

  // Parses all ~370 lib files with the TS parser: ~1.5s as a plain script, ~7s under CI coverage instrumentation.
  it('the real lib tree is clean, so the gate starts green', { timeout: 60_000 }, () => {
    expect((scan(LIB) as { violations: unknown[] }).violations).toEqual([]);
  });
});

// t/4442 part 2 (TL e/365#2): --include-tests widens the walk to test files, and checks THEM for
// require-windows-hide* disables instead of complexity-budget ones. Without the flag, behavior for
// lib and taxonomy-editor is exactly the C2 suite above, unchanged.
describe('--include-tests (t/4442 part 2): require-windows-hide bypasses in test files', () => {
  it.each([
    ['blanket block disable in a test file', '/* eslint-disable */\nexport const a = 1;'],
    ['blanket next-line disable in a test file', '// eslint-disable-next-line\nexport const a = 1;'],
    ['named disable of require-windows-hide', '// eslint-disable-next-line local/require-windows-hide\nexport const a = 1;'],
    ['named disable of require-windows-hide-unverifiable', '// eslint-disable-next-line local/require-windows-hide-unverifiable\nexport const a = 1;'],
    // The guard rule itself, named directly -- a residual ESLint's own require-windows-hide-disable-reason
    // rule can't catch (it only watches disables of the two rules it guards, not disables of itself).
    ['named disable of the guard rule itself, require-windows-hide-disable-reason', '/* eslint-disable local/require-windows-hide-disable-reason */\nexport const a = 1;'],
    ['inline config turning require-windows-hide off', '/* eslint local/require-windows-hide: off */\nexport const a = 1;'],
  ])('%s is refused in testMode', (_label, src) => {
    const found = findBypasses(src, 'file.test.ts', { testMode: true }) as Bypass[];
    expect(found).toHaveLength(1);
  });

  it.each([
    ['a named disable of local/complexity-budget (out of scope for testMode -- not require-windows-hide*)', '// eslint-disable-next-line local/complexity-budget\nexport const a = 1;'],
    ['a disable naming an unrelated rule', '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;'],
    ['prose that mentions require-windows-hide', '// see local/require-windows-hide for the gate\nexport const a = 1;'],
  ])('allows %s in testMode', (_label, src) => {
    expect(findBypasses(src, 'file.test.ts', { testMode: true })).toEqual([]);
  });

  it('without opts (or testMode: false), a require-windows-hide disable is NOT flagged -- the default path is unchanged', () => {
    expect(findBypasses('// eslint-disable-next-line local/require-windows-hide\nexport const a = 1;')).toEqual([]);
    expect(findBypasses('// eslint-disable-next-line local/require-windows-hide\nexport const a = 1;', 'file.ts', { testMode: false })).toEqual([]);
  });

  it('a blanket disable in a NON-test file is still the complexity-budget reason, even with includeTests set -- testMode is per-file, not global', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cb-include-tests-'));
    try {
      mkdirSync(path.join(root, '__tests__'));
      writeFileSync(path.join(root, 'a.ts'), '/* eslint-disable */\nexport const a = 1;\n');
      writeFileSync(path.join(root, '__tests__/b.test.ts'), '/* eslint-disable */\nexport const b = 1;\n');
      const { violations } = scan(root, { includeTests: true }) as { violations: (Bypass & { file: string; testFile: boolean })[] };
      const byFile = Object.fromEntries(violations.map((v) => [v.file, v]));
      expect(byFile['a.ts'].testFile).toBe(false);
      expect(byFile['a.ts'].reason).toMatch(/complexity gate/);
      expect(byFile['__tests__/b.test.ts'].testFile).toBe(true);
      expect(byFile['__tests__/b.test.ts'].reason).toMatch(/require-windows-hide/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a blanket disable in a test file is reported when scanning WITH --include-tests, and the same file is invisible WITHOUT it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cb-include-tests-'));
    try {
      writeFileSync(path.join(root, 'a.test.ts'), '/* eslint-disable */\nexport const a = 1;\n');
      const without = scan(root) as { files: number; violations: unknown[] };
      expect(without.files).toBe(0); // the test file is not even walked
      expect(without.violations).toEqual([]);

      const withFlag = scan(root, { includeTests: true }) as { files: number; violations: (Bypass & { testFile: boolean })[] };
      expect(withFlag.files).toBe(1);
      expect(withFlag.violations).toHaveLength(1);
      expect(withFlag.violations[0].testFile).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a helper file under __tests__/ not itself named *.test.ts is still test-mode-scanned with --include-tests', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cb-include-tests-'));
    try {
      mkdirSync(path.join(root, '__tests__'));
      writeFileSync(path.join(root, '__tests__/helper.ts'), '// eslint-disable-next-line local/require-windows-hide\nexport const h = 1;\n');
      const { violations } = scan(root, { includeTests: true }) as { violations: (Bypass & { testFile: boolean })[] };
      expect(violations).toHaveLength(1);
      expect(violations[0].testFile).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the real lib tree, scanned WITH --include-tests, reports only test-file findings (testFile: true) -- 0 non-test regressions', { timeout: 60_000 }, () => {
    const { violations } = scan(LIB, { includeTests: true }) as { violations: (Bypass & { testFile: boolean })[] };
    expect(violations.every((v) => v.testFile)).toBe(true);
  });

  it('the CLI (spawned) exits 0 and prints ::warning:: lines for test-file findings, but still fails on a non-test one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cb-cli-'));
    try {
      writeFileSync(path.join(root, 'a.test.ts'), '/* eslint-disable */\nexport const a = 1;\n');
      const warnOnly = spawnSync(process.execPath, [SCRIPT, root, '--include-tests'], { encoding: 'utf8' });
      expect(warnOnly.status, warnOnly.stderr).toBe(0);
      expect(warnOnly.stdout).toMatch(/::warning file=a\.test\.ts,line=1::/);

      writeFileSync(path.join(root, 'b.ts'), '/* eslint-disable local/complexity-budget */\nexport const b = 1;\n');
      const stillFails = spawnSync(process.execPath, [SCRIPT, root, '--include-tests'], { encoding: 'utf8' });
      expect(stillFails.status).not.toBe(0);
      expect(stillFails.stderr).toMatch(/complexity-budget bypass check FAILED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Each arm spawns node + typescript-eslint, which can take well over 5s on a loaded machine.
describe('C1: generate-complexity-baseline.mjs --ext', { timeout: 60_000 }, () => {
  let root: string;
  // Each file holds one function of complexity 17 (> threshold 15), so every measured file becomes an entry.
  const over = `export function f(n: number): number {\n${Array.from({ length: 16 }, (_, i) => `  if (n === ${i}) return ${i};`).join('\n')}\n  return -1;\n}\n`;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cb-ext-'));
    writeFileSync(path.join(root, 'a.ts'), over);
    writeFileSync(path.join(root, 'b.tsx'), over);
    writeFileSync(path.join(root, 'c.js'), over.replace('f(n: number): number', 'f(n)')); // plain JS: no annotations
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const run = (...args: string[]) => spawnSync(process.execPath, [GENERATOR, '--root', root, ...args], { encoding: 'utf8' });

  it('--ext ts,tsx walks only .ts/.tsx: the .js file gets no entry, and __meta__.ext records the filter', () => {
    const out = path.join(root, 'b-ext.json');
    const r = run('--baseline', out, '--ext', 'ts,tsx');
    expect(r.status, r.stderr).toBe(0);
    const baseline = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(baseline).filter((k) => k !== '__meta__').sort()).toEqual(['a.ts', 'b.tsx']);
    expect(baseline.__meta__.ext).toEqual(['.ts', '.tsx']);
  });

  it('without --ext the walk is unchanged (the .js file is measured too) and __meta__ has no ext key', () => {
    const out = path.join(root, 'b-all.json');
    const r = run('--baseline', out);
    expect(r.status, r.stderr).toBe(0);
    const baseline = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(baseline).filter((k) => k !== '__meta__').sort()).toEqual(['a.ts', 'b.tsx', 'c.js']);
    expect('ext' in baseline.__meta__).toBe(false);
  });

  it('rejects an extension the generator does not measure, and writes nothing', () => {
    const out = path.join(root, 'b-bad.json');
    const r = run('--baseline', out, '--ext', 'ts,py');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/names an extension this generator does not measure/);
    expect(() => readFileSync(out)).toThrow();
  });
});
