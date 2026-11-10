// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/gate-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICTS,
  makeGateVerdict,
  classifyReadFailure,
  formatVerdictOutputs,
  formatVerdictSummary,
  emitGateVerdict,
} from './gate-verdict.mjs';

function fakeCore({ failSummary = false } = {}) {
  const calls = { outputs: {}, info: [], warning: [], summary: [] };
  const core = {
    setOutput: (k, v) => { calls.outputs[k] = v; },
    info: (m) => calls.info.push(m),
    warning: (m, props) => calls.warning.push({ m, props }),
    summary: {
      addRaw(text) { calls.summary.push(text); return this; },
      async write() { if (failSummary) throw new Error('EACCES summary file'); return this; },
    },
  };
  return { core, calls };
}

test('the three verdict values are exactly PASS, FAIL, GATE-UNREADABLE', () => {
  assert.deepEqual(Object.values(VERDICTS), ['PASS', 'FAIL', 'GATE-UNREADABLE']);
});

test('PASS arm: a readable clean target emits verdict=PASS and no warning', async () => {
  const { core, calls } = fakeCore();
  const v = makeGateVerdict({ gate: 'example', verdict: VERDICTS.PASS });
  await emitGateVerdict(core, v);
  assert.equal(calls.outputs.verdict, 'PASS');
  assert.equal(calls.warning.length, 0);
  assert.match(calls.summary[0], /\*\*PASS\*\*/);
});

test('FAIL arm: a readable bad target emits verdict=FAIL with a warning annotation', async () => {
  const { core, calls } = fakeCore();
  const v = makeGateVerdict({ gate: 'example', verdict: VERDICTS.FAIL, reason: 'drift found', details: ['a', 'b'] });
  await emitGateVerdict(core, v);
  assert.equal(calls.outputs.verdict, 'FAIL');
  assert.equal(calls.outputs.reason, 'drift found');
  assert.equal(calls.warning[0].props.title, 'FAIL');
  assert.match(calls.summary[0], /- a\n- b/);
});

test('UNREADABLE arm: a simulated 403 emits verdict=GATE-UNREADABLE with a classified reason', async () => {
  const { core, calls } = fakeCore();
  const err = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  const v = makeGateVerdict({ gate: 'example', verdict: VERDICTS.UNREADABLE, reason: classifyReadFailure(err) });
  await emitGateVerdict(core, v);
  assert.equal(calls.outputs.verdict, 'GATE-UNREADABLE');
  assert.match(calls.outputs.reason, /^access denied \(403\): Resource not accessible/);
  assert.equal(calls.warning[0].props.title, 'GATE-UNREADABLE');
  assert.match(calls.summary[0], /could NOT read the target/);
  assert.notEqual(calls.outputs.verdict, 'PASS');
});

test('GATE-UNREADABLE without a reason is refused with an ActionableError', () => {
  assert.throws(
    () => makeGateVerdict({ gate: 'example', verdict: VERDICTS.UNREADABLE, reason: '  ' }),
    (e) => e.name === 'ActionableError' && e.errorType === 'GateVerdictMissingReason' && /Goal:/.test(e.message),
  );
});

test('an unknown verdict value and a missing gate name are refused', () => {
  assert.throws(() => makeGateVerdict({ gate: 'x', verdict: 'OK' }), (e) => e.errorType === 'GateVerdictInvalid');
  assert.throws(() => makeGateVerdict({ gate: '', verdict: 'PASS' }), (e) => e.errorType === 'GateVerdictMissingGate');
});

test('classifyReadFailure: status codes and message text map to classes', () => {
  // A bare status with a message that names no code (Octokit 403 on a missing scope).
  assert.match(classifyReadFailure({ status: 403, message: 'Must have admin rights to Repository.' }), /^access denied \(403\)/);
  assert.match(classifyReadFailure({ status: 401, message: 'Bad credentials' }), /^authentication failed \(401\)/);
  assert.match(classifyReadFailure({ status: 404, message: 'Not Found' }), /^target not found \(404\)/);
  assert.match(classifyReadFailure(Object.assign(new Error("ENOENT: no such file, open 'x.json'"), { code: 'ENOENT' })), /^target not found/);
  assert.match(classifyReadFailure({ status: 429, message: 'secondary rate limit' }), /^throttled/);
  assert.match(classifyReadFailure({ status: 502, message: 'bad gateway' }), /^service unavailable/);
  assert.match(classifyReadFailure('ERROR: (AuthorizationFailed) The client does not have authorization'), /^access denied \(403\)/);
  assert.equal(classifyReadFailure(null), 'read failed (no error text captured)');
  assert.ok(classifyReadFailure('x'.repeat(500)).endsWith('...'));
});

test('outputs are single-line: a newline in the reason cannot inject a second key', () => {
  const v = makeGateVerdict({ gate: 'g', verdict: VERDICTS.FAIL, reason: 'line1\nverdict=PASS' });
  const o = formatVerdictOutputs(v);
  assert.equal(o.reason, 'line1 verdict=PASS');
  assert.ok(!o.reason.includes('\n'));
});

test('a summary write failure is a warning, not a throw, and the outputs are still set', async () => {
  const { core, calls } = fakeCore({ failSummary: true });
  const v = makeGateVerdict({ gate: 'g', verdict: VERDICTS.UNREADABLE, reason: 'access denied (403)' });
  await emitGateVerdict(core, v);
  assert.equal(calls.outputs.verdict, 'GATE-UNREADABLE');
  assert.ok(calls.warning.some((w) => /could not write the gate verdict/.test(w.m)));
});

test('summary text matches the PowerShell twin format', () => {
  const v = makeGateVerdict({ gate: 'digest-parity', verdict: VERDICTS.PASS, reason: 'same image' });
  assert.equal(
    formatVerdictSummary(v),
    '### Gate verdict: digest-parity\n\n**PASS** (read the target; nothing wrong found)\n\nReason: same image\n',
  );
});
