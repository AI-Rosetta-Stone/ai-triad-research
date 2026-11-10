// Both-arms tests for the contrast gate verdict (t/111; docs/CodeReview/gate-signal-integrity.md
// rules 1 and 4). One injected fault per decision site in contrast-gate.mjs, named per test.
//
// The gate failed OPEN for a long time: on Linux CI the ~330 KB --json payload reached
// check-contrast.sh truncated mid-object, the parse failed, the count was empty and
// `[ "" -gt 314 ]` fell through to "OK". These tests pin that every unreadable case is closed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateContrastGate } from './contrast-gate.mjs';

const payload = (n) => JSON.stringify({ findings: Array.from({ length: n }, (_, i) => ({ kind: 'contrast', selector: `.s${i}` })), undefinedTokens: [] }, null, 2);

describe('contrast gate — fails closed on anything unreadable', () => {
  it('truncated JSON is UNREADABLE, not OK (the CI shape: cut off at `"nonText": f`) [JSON.parse site]', () => {
    const cut = payload(5).slice(0, 120) + '\n      "nonText": f';
    const r = evaluateContrastGate({ stdout: cut, exitCode: 1, ceiling: 314 });
    assert.equal(r.verdict, 'UNREADABLE');
    assert.equal(r.ok, false);
  });

  it('empty output is UNREADABLE [JSON.parse site]', () => {
    assert.equal(evaluateContrastGate({ stdout: '', exitCode: 1, ceiling: 314 }).verdict, 'UNREADABLE');
  });

  it('output without a findings array is UNREADABLE [findings-array site]', () => {
    assert.equal(evaluateContrastGate({ stdout: '{"undefinedTokens":[]}', exitCode: 0, ceiling: 314 }).verdict, 'UNREADABLE');
  });

  it('a crashed checker (exit 2, or NaN when the arg is missing) is UNREADABLE [exit-code site]', () => {
    assert.equal(evaluateContrastGate({ stdout: payload(3), exitCode: 2, ceiling: 314 }).verdict, 'UNREADABLE');
    assert.equal(evaluateContrastGate({ stdout: payload(3), exitCode: Number(undefined), ceiling: 314 }).verdict, 'UNREADABLE');
  });

  it('exit code disagreeing with the findings count is UNREADABLE [consistency site]', () => {
    assert.equal(evaluateContrastGate({ stdout: payload(3), exitCode: 0, ceiling: 314 }).verdict, 'UNREADABLE');
    assert.equal(evaluateContrastGate({ stdout: payload(0), exitCode: 1, ceiling: 314 }).verdict, 'UNREADABLE');
  });

  it('a missing or non-integer ceiling is UNREADABLE [ceiling site]', () => {
    for (const ceiling of [undefined, '', 'undefined', '3.5', '-1', 'abc']) {
      assert.equal(evaluateContrastGate({ stdout: payload(3), exitCode: 1, ceiling }).verdict, 'UNREADABLE', `ceiling ${String(ceiling)}`);
    }
  });
});

describe('contrast gate — ratchet arms', () => {
  it('a count over the ceiling FAILs [ceiling-compare site]', () => {
    const r = evaluateContrastGate({ stdout: payload(4), exitCode: 1, ceiling: 3 });
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.count, 4);
  });

  it('a count at the ceiling passes', () => {
    const r = evaluateContrastGate({ stdout: payload(3), exitCode: 1, ceiling: '3' });
    assert.deepEqual([r.verdict, r.ok, r.count], ['OK', true, 3]);
    assert.equal(r.message, 'contrast check: 3 / 3 findings (OK)');
  });

  it('zero findings with exit 0 passes', () => {
    assert.equal(evaluateContrastGate({ stdout: payload(0), exitCode: 0, ceiling: 0 }).verdict, 'OK');
  });
});

describe('check-contrast.mjs --json — complete output through a pipe (t/111 root cause)', () => {
  it('stdout parses in full when piped (process.exit() used to truncate it on Linux)', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'check-contrast.mjs');
    const res = spawnSync(process.execPath, [script, '--json'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed.findings));
    assert.ok(res.stdout.length > 64 * 1024, `payload ${res.stdout.length} bytes should exceed a pipe buffer, or this test proves nothing`);
  });
});
