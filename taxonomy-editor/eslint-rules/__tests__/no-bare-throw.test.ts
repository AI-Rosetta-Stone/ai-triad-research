// Rule-level Gate Verification for local/no-bare-throw (t/4153, t/4109 migration D2).
// The rule lives in lib/eslint-rules (Shared Lib scope) and is applied by both lib's and taxonomy-editor's
// configs, so its test lives in the taxonomy-editor rule-test harness with the other lib rules.
// Both arms: `invalid` = an inline-message throw reports (bootstrap mode, over-baseline, unlisted file);
// `valid` = rethrows, ActionableError, variable messages, other Error subclasses and within-baseline files
// stay silent. A parity block proves the baseline generator counts exactly what the rule reports.
import { describe, it, expect, afterAll } from 'vitest';
import { RuleTester, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from '../../../lib/eslint-rules/no-bare-throw.js';
import { countBareThrows } from '../../../lib/eslint-rules/generate-bare-throw-baseline.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const rt = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tseslint.parser },
});

const bare = (n = 1) => Array.from({ length: n }, () => ({ messageId: 'bare' }));
const FILE = 'src/some/file.ts';

const VALID_SHAPES = [
  'try { f(); } catch (err) { throw err; }',
  'function g(e: unknown) { throw e; }',
  "throw new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: ['n'] });",
  'const msg = build(); throw new Error(msg);',
  'throw new Error(describe(x));',
  "throw new TypeError('expected a string');",
  "throw new RangeError(`index ${i} out of range`);",
  'throw new Error();',
  "throw makeError('x');",
];

const INVALID_SHAPES = [
  "throw new Error('something failed');",
  'throw new Error("double quoted");',
  'throw new Error(`templated ${x}`);',
  "throw new Error('bad input: ' + x);",
  "throw new Error(x + ' was bad');",
  "throw Error('no new');",
  "throw new Error('with cause', { cause: err });",
  "throw 'a bare string';",
  'throw `a bare template ${x}`;',
];

rt.run('no-bare-throw', rule, {
  valid: [
    ...VALID_SHAPES.map((code) => ({ code })),
    // within baseline: two bare throws in a file whose baseline is 2
    { code: "throw new Error('a'); throw new Error('b');", filename: FILE, options: [{ baseline: { [FILE]: 2 } }] },
    // the count fell below the baseline: fine (ratchet down)
    { code: "throw new Error('a');", filename: FILE, options: [{ baseline: { [FILE]: 3 } }] },
  ],
  invalid: [
    // bootstrap mode (no baseline): every shape reports
    ...INVALID_SHAPES.map((code) => ({ code, errors: bare() })),
    // over baseline: every bare throw in the file reports, naming the counts
    {
      code: "throw new Error('a'); throw new Error('b'); throw new Error('c');",
      filename: FILE,
      options: [{ baseline: { [FILE]: 2 } }],
      errors: bare(3),
    },
    // an unlisted file has a baseline of 0
    { code: "throw new Error('a');", filename: FILE, options: [{ baseline: { 'src/other.ts': 5 } }], errors: bare() },
    // an unreadable baseline is reported, never silently treated as empty or as "off"
    {
      code: 'const ok = 1;',
      options: [{ baseline: 'does/not/exist.json' }],
      errors: [{ messageId: 'baselineLoadError' }],
    },
  ],
});

describe('generator parity: countBareThrows counts exactly what the rule reports', () => {
  const linter = new Linter({ configType: 'flat' });
  const reported = (code: string) => linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { local: { rules: { 'no-bare-throw': rule } } },
    rules: { 'local/no-bare-throw': 'warn' },
  }], 'x.ts').filter((m) => m.ruleId === 'local/no-bare-throw').length;

  const mixed = [...VALID_SHAPES, ...INVALID_SHAPES].map((s) => `function f${Math.random().toString(36).slice(2)}() { ${s} }`).join('\n');
  it.each([
    ['every valid shape', VALID_SHAPES.join('\n'), 0],
    ['every invalid shape', INVALID_SHAPES.join('\n'), INVALID_SHAPES.length],
    ['valid and invalid mixed, nested in functions', mixed, INVALID_SHAPES.length],
  ])('%s', (_name, code, expected) => {
    expect(reported(code)).toBe(expected);
    expect(countBareThrows(code, 'x.ts')).toBe(expected);
  });

  it('parses .tsx', () => {
    expect(countBareThrows("const C = () => { if (!x) throw new Error('no x'); return <div/>; };", 'x.tsx')).toBe(1);
  });
});
