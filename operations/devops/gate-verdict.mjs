// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Three-state gate verdict convention (t/4496): PASS, FAIL or GATE-UNREADABLE.
// JavaScript / github-script twin of operations/devops/GateVerdict.ps1; same contract:
//
//   PASS             the gate read real content and found nothing wrong.
//   FAIL             the gate read real content and found the condition it checks for.
//   GATE-UNREADABLE  the gate could not read its target (403, missing file, auth failure), so it
//                    has NO verdict. Always carries a reason. Never read it as a pass.
//
//   step output   verdict=, reason=, gate=   (core.setOutput -> steps.<id>.outputs.verdict)
//   step summary  one markdown block          (core.summary)
//   annotation    PASS: core.info. FAIL / GATE-UNREADABLE: core.warning (warn-only gates).
//
// Why: a warn-only gate that cannot read its target looked the same in CI as one that passed
// clean. The share-freshness gate ran green for an unknown period on a 403 (t/4390).
//
// Pure core (makeGateVerdict, classifyReadFailure, formatVerdictOutputs, formatVerdictSummary) does
// no I/O; emitGateVerdict is the thin shim and takes github-script's `core` as an argument.
//
// Loading from github-script: load it from the BASE branch's tip, never the PR head (same
// anti-self-narrowing posture as tier-check / t1-approval-guard, e/291 C1), so a PR can't weaken
// the helper that reports its own gate:
//
//   execSync(`git fetch origin ${JSON.stringify(baseRef)}`, { cwd: process.env.GITHUB_WORKSPACE });
//   const tip = execSync('git rev-parse FETCH_HEAD', { cwd: process.env.GITHUB_WORKSPACE, encoding: 'utf8' }).trim();
//   const text = execSync(`git show ${tip}:operations/devops/gate-verdict.mjs`, { cwd: process.env.GITHUB_WORKSPACE, encoding: 'utf8' });
//   const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-verdict-')), 'gate-verdict.mjs');
//   fs.writeFileSync(p, text);
//   const gv = await import(pathToFileURL(p).href);
//
// The module has no imports of its own, so the single file is enough. If `git show` fails (the
// helper is not on the base tip yet), that is itself a GATE-UNREADABLE condition for the caller:
// report it with a reason rather than skipping silently.
//
// Run the tests: node --test operations/devops/gate-verdict.test.mjs

export const VERDICTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNREADABLE: 'GATE-UNREADABLE',
});

const VALID = new Set(Object.values(VERDICTS));

/** One line, no control characters (step outputs are key=value lines). */
export function toVerdictLine(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function actionableError({ goal, problem, location, nextSteps, errorType }) {
  const err = new Error(
    `  Goal:       ${goal}\n  Problem:    ${problem}\n  Location:   ${location}\n` +
      `  Next Steps: ${nextSteps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
  );
  Object.assign(err, { name: 'ActionableError', errorType, goal, problem, location, nextSteps });
  return err;
}

/**
 * PURE. Build a verdict object. GATE-UNREADABLE requires a non-empty reason.
 * @param {{gate: string, verdict: string, reason?: string, details?: string[]}} input
 * @returns {{gate: string, verdict: string, reason: string, details: string[]}}
 */
export function makeGateVerdict({ gate, verdict, reason = '', details = [] }) {
  const location = 'makeGateVerdict (operations/devops/gate-verdict.mjs)';
  if (!gate || !String(gate).trim()) {
    throw actionableError({
      goal: 'Record a gate verdict (t/4496)',
      problem: 'No gate name was given.',
      location,
      nextSteps: ['Pass gate: "<the gate or step name>" so the summary and outputs say which gate this is.'],
      errorType: 'GateVerdictMissingGate',
    });
  }
  if (!VALID.has(verdict)) {
    throw actionableError({
      goal: `Record a verdict for gate '${gate}' (t/4496)`,
      problem: `'${verdict}' is not a verdict. Valid values: ${[...VALID].join(', ')}.`,
      location,
      nextSteps: ['Use VERDICTS.PASS, VERDICTS.FAIL or VERDICTS.UNREADABLE.'],
      errorType: 'GateVerdictInvalid',
    });
  }
  if (verdict === VERDICTS.UNREADABLE && !toVerdictLine(reason)) {
    throw actionableError({
      goal: `Record a GATE-UNREADABLE verdict for gate '${gate}' (t/4496)`,
      problem: 'GATE-UNREADABLE was requested with no reason. An unreadable verdict must say why the target could not be read.',
      location,
      nextSteps: [
        'Pass reason, e.g. classifyReadFailure(err).',
        'If the target WAS read, the verdict is PASS or FAIL, not GATE-UNREADABLE.',
      ],
      errorType: 'GateVerdictMissingReason',
    });
  }
  return {
    gate: String(gate),
    verdict,
    reason: toVerdictLine(reason),
    details: (details || []).map(toVerdictLine).filter(Boolean),
  };
}

/**
 * PURE. Classify a failed read (an Octokit error with .status, a Node error, or a string) into a
 * short reason for a GATE-UNREADABLE verdict. The raw message is kept, truncated.
 */
export function classifyReadFailure(err, maxLength = 300) {
  const status = err && typeof err === 'object' && 'status' in err ? Number(err.status) : NaN;
  const message = toVerdictLine(typeof err === 'string' ? err : err && err.message);
  // The HTTP status (when there is one) leads the probe, so `\b403\b` etc. match it as well as text.
  const probe = `${Number.isFinite(status) ? status : ''} ${message}`;
  let cls = 'read failed';
  if (/\b403\b|Forbidden|AuthorizationFailed|AuthorizationPermissionMismatch|Resource not accessible by integration/i.test(probe)) cls = 'access denied (403)';
  else if (/\b401\b|Unauthorized|Bad credentials|AuthenticationFailed/i.test(probe)) cls = 'authentication failed (401)';
  else if (/\b404\b|Not Found|ENOENT|does not exist/i.test(probe)) cls = 'target not found (404)';
  else if (/\b429\b|rate limit|TooManyRequests/i.test(probe)) cls = 'throttled (429)';
  else if ((status >= 500 && status < 600) || /timed out|timeout|ETIMEDOUT|ECONNRESET|Service Unavailable/i.test(probe)) cls = 'service unavailable or timed out';
  if (!message) return `${cls} (no error text captured)`;
  return `${cls}: ${message.length > maxLength ? `${message.slice(0, maxLength)}...` : message}`;
}

/** PURE. The step outputs for a verdict. */
export function formatVerdictOutputs(v) {
  return { gate: toVerdictLine(v.gate), verdict: v.verdict, reason: toVerdictLine(v.reason) };
}

const MEANING = {
  [VERDICTS.PASS]: 'read the target; nothing wrong found',
  [VERDICTS.FAIL]: 'read the target; found the condition this gate checks for',
  [VERDICTS.UNREADABLE]: 'could NOT read the target; this is no verdict, not a pass',
};

/** PURE. The step-summary markdown block for a verdict (same text as the PowerShell twin). */
export function formatVerdictSummary(v) {
  const lines = [`### Gate verdict: ${v.gate}`, '', `**${v.verdict}** (${MEANING[v.verdict]})`];
  if (v.reason) lines.push('', `Reason: ${v.reason}`);
  for (const d of v.details || []) lines.push(`- ${toVerdictLine(d)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Thin shim for github-script. Sets outputs, writes the summary and logs one line. A summary write
 * failure is logged as a warning, never thrown: a reporting fault must not hide the verdict.
 * @param {object} core   github-script's @actions/core
 * @param {ReturnType<typeof makeGateVerdict>} v
 */
export async function emitGateVerdict(core, v) {
  const outputs = formatVerdictOutputs(v);
  for (const [k, val] of Object.entries(outputs)) core.setOutput(k, val);
  const line = `${v.gate}: ${v.verdict}${v.reason ? ` - ${v.reason}` : ''}`;
  if (v.verdict === VERDICTS.PASS) core.info(`GATE-VERDICT ${line}`);
  else core.warning(line, { title: v.verdict });
  try {
    await core.summary.addRaw(formatVerdictSummary(v), true).write();
  } catch (e) {
    core.warning(`WARN: could not write the gate verdict to the step summary (${e && e.message}); the outputs and this log line still carry it.`);
  }
  return outputs;
}
