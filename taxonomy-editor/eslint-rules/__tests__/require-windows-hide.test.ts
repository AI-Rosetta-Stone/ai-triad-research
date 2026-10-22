// Rule-level Gate Verification for local/require-windows-hide (t/3922, parent t/3914).
// The rule lives in lib/eslint-rules (Shared Lib scope) but is applied by taxonomy-editor's config,
// so its test lives in the taxonomy-editor rule-test harness (same place as the other lib rules).
// Both-arms proof: `invalid` = the FAIL arm (a child_process call without `windowsHide: true`
// warns, through every binding shape the rule claims to resolve), `valid` = the precision arm
// (the option present, RegExp.prototype.exec, node-pty, and shadowed names stay silent).
// Parsed with the typescript-eslint parser so `as` casts and TS-only syntax are exercised.
import { describe, it, afterAll } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from '../../../lib/eslint-rules/require-windows-hide.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const rt = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tseslint.parser },
});

const missing = [{ messageId: 'missing' }];
const unverifiable = [{ messageId: 'unverifiable' }];

rt.run('require-windows-hide', rule, {
  valid: [
    // ── The option present, every call shape ──
    "import { execFileSync } from 'child_process'; execFileSync('python', ['--version'], { encoding: 'utf-8', windowsHide: true });",
    "import { spawn } from 'node:child_process'; spawn('git', ['status'], { cwd: '.', windowsHide: true });",
    "import { exec } from 'child_process'; exec('git status', { windowsHide: true }, (err) => {});",
    "import * as cp from 'child_process'; cp.execSync('git status', { windowsHide: true });",
    "import cp from 'child_process'; cp.fork('worker.js', [], { windowsHide: true });",
    "const { execFile } = require('child_process'); execFile('git', ['log'], { windowsHide: true }, () => {});",
    "require('child_process').execSync('ls', { windowsHide: true });",
    "async function f() { const { execFile } = await import('node:child_process'); execFile('x', [], { windowsHide: true }, () => {}); }",
    // a dynamic import of some other module is not child_process
    "async function f() { const { exec } = await import('./runner'); exec('x'); }",
    "import { promisify } from 'util'; import { execFile } from 'child_process'; const run = promisify(execFile); await run('git', ['log'], { windowsHide: true });",
    // options via a same-file const literal, and through an `as` cast
    "import { spawn } from 'child_process'; const opts = { stdio: 'pipe', windowsHide: true }; spawn('git', [], opts);",
    "import { spawn } from 'child_process'; spawn('git', [], { windowsHide: true } as const);",
    // spread is fine when windowsHide is explicit
    "import { spawn } from 'child_process'; spawn('git', [], { ...base, windowsHide: true });",
    // ── Precision arm: not child_process ──
    "const re = /a(b)/; re.exec('ab');",
    "const m = /x/g.exec(s);",
    "import * as pty from 'node-pty'; pty.spawn('pwsh.exe', [], { cols: 80 });",
    "import { spawn } from 'node-pty'; spawn('pwsh.exe', [], {});",
    "import { exec } from './myExec'; exec('x');",
    // shadowed name: a local `exec` in an inner scope is not the imported binding
    "import { exec } from 'child_process'; function f(exec) { exec('x'); }",
  ],
  invalid: [
    // no options object at all
    { code: "import { execFileSync } from 'child_process'; execFileSync('python', ['--version']);", errors: missing },
    { code: "import { spawn } from 'child_process'; spawn('git');", errors: missing },
    // options object without the key
    { code: "import { execFileSync } from 'child_process'; execFileSync('python', ['--version'], { encoding: 'utf-8', timeout: 5000 });", errors: missing },
    // explicit false
    { code: "import { spawn } from 'child_process'; spawn('git', [], { windowsHide: false });", errors: missing },
    // aliased named import
    { code: "import { execFile as run } from 'node:child_process'; run('git', ['log'], {}, () => {});", errors: missing },
    // namespace / default import member calls
    { code: "import * as cp from 'child_process'; cp.spawnSync('git', ['log']);", errors: missing },
    { code: "import cp from 'child_process'; cp.exec('git log', () => {});", errors: missing },
    // require: destructured, module object, direct member
    { code: "const { execSync } = require('child_process'); execSync('ls');", errors: missing },
    { code: "const cp = require('child_process'); cp.fork('w.js');", errors: missing },
    { code: "require('child_process').execSync('ls');", errors: missing },
    // dynamic import binding (taxonomyLoader.ts:454 shape) and a cast require (pipeline.ts:406 shape)
    { code: "async function f() { const { execFile } = await import('child_process'); execFile('markitdown', ['x'], { timeout: 1 }, () => {}); }", errors: missing },
    { code: "const { execSync } = require('child_process') as typeof import('child_process'); execSync('git log');", errors: missing },
    // promisify wrappers (bare and util.promisify), declared below the function that calls them
    { code: "import { promisify } from 'util'; import { execFile } from 'child_process'; const run = promisify(execFile); await run('git', ['log']);", errors: missing },
    { code: "import util from 'util'; import * as cp from 'child_process'; async function f() { await execAsync('ls'); } const execAsync = util.promisify(cp.exec);", errors: missing },
    // same-file const options without the key
    { code: "import { spawn } from 'child_process'; const opts = { stdio: 'pipe' }; spawn('git', [], opts);", errors: missing },
    // a let options binding may be reassigned: can't verify
    { code: "import { spawn } from 'child_process'; let opts = { windowsHide: true }; spawn('git', [], opts);", errors: unverifiable },
    // options from a parameter / call result / bare spread: can't verify
    { code: "import { spawn } from 'child_process'; function f(o) { spawn('git', [], o); }", errors: unverifiable },
    { code: "import { spawn } from 'child_process'; spawn('git', [], makeOpts());", errors: unverifiable },
    { code: "import { spawn } from 'child_process'; spawn('git', [], { ...base });", errors: unverifiable },
  ],
});

// t/4238 (TL e/351#2): the same module runs at two severities. `report: 'missing'` (registered at error) never reports
// an unverifiable call, and `report: 'unverifiable'` (registered at warn) never reports a definite miss.
const MISSING_CALL = "import { spawn } from 'child_process'; spawn('git', ['status']);";
const UNVERIFIABLE_CALL = "import { spawn } from 'child_process'; function f(o) { spawn('git', [], o); }";
rt.run('require-windows-hide report option (t/4238)', rule, {
  valid: [
    { code: UNVERIFIABLE_CALL, options: [{ report: 'missing' }] },
    { code: MISSING_CALL, options: [{ report: 'unverifiable' }] },
  ],
  invalid: [
    { code: MISSING_CALL, options: [{ report: 'missing' }], errors: missing },
    { code: UNVERIFIABLE_CALL, options: [{ report: 'unverifiable' }], errors: unverifiable },
    // no option: both, as before t/4238
    { code: MISSING_CALL, errors: missing },
    { code: UNVERIFIABLE_CALL, options: [{ report: 'all' }], errors: unverifiable },
  ],
});
