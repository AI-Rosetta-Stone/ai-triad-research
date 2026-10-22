// Rule-level Gate Verification for local/require-windows-hide-disable-reason (t/4238, TL e/351#2): the escape hatch
// for the now-blocking local/require-windows-hide. The rule lives in lib/eslint-rules and is applied by all five
// packages' configs, so its test lives here with the other lib rule tests.
// Both arms: `valid` = a line-scoped disable with a reason and a ticket, and disables of other rules; `invalid` = no
// reason, a reason without a ticket, and file/block-scoped disables.
import { describe, it, afterAll } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from '../../../lib/eslint-rules/require-windows-hide-disable-reason.js';
import requireWindowsHide from '../../../lib/eslint-rules/require-windows-hide.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

// The directives name the real rule ids, so register them as the configs do (otherwise ESLint reports "Definition for
// rule ... was not found" on every directive).
const rt = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tseslint.parser },
  plugins: { local: { rules: { 'require-windows-hide': requireWindowsHide, 'require-windows-hide-unverifiable': requireWindowsHide } } },
});
const noReason = [{ messageId: 'noReason' }];
const blockScoped = [{ messageId: 'blockScoped' }];

rt.run('require-windows-hide-disable-reason', rule, {
  valid: [
    '// eslint-disable-next-line local/require-windows-hide -- options come from execa wrapper, which sets windowsHide (t/4238)\nspawn();',
    '// eslint-disable-line local/require-windows-hide-unverifiable -- opts built in lib/run.ts with windowsHide (t/1234)',
    '/* eslint-disable-next-line local/require-windows-hide -- reason here (t/42) */',
    // another rule's disable is none of this rule's business
    '// eslint-disable-next-line no-console\nconsole.log(1);',
    '/* eslint-disable max-lines */',
    // an ordinary comment that mentions the rule
    '// local/require-windows-hide is blocking since t/4238',
  ],
  invalid: [
    { code: '// eslint-disable-next-line local/require-windows-hide\nspawn();', errors: noReason },
    { code: '// eslint-disable-next-line local/require-windows-hide -- trust me\nspawn();', errors: noReason },
    { code: '// eslint-disable-line local/require-windows-hide-unverifiable', errors: noReason },
    { code: '// eslint-disable-next-line no-console, local/require-windows-hide\nspawn();', errors: noReason },
    { code: '/* eslint-disable local/require-windows-hide */', errors: blockScoped },
    { code: '/* eslint-disable local/require-windows-hide -- whole file is fine (t/4238) */', errors: blockScoped },
  ],
});
