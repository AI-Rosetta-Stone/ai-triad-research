// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * CLI shim for the worktree-owner-guard-shell feedback rule (t/4212). Invoked as:
 *   node worktree-owner-guard-shell.mjs "<command>" "<agent.id>" "<role.path>" "<agent.address>"
 * Prints the warning text to stdout (the rule's `template` is `{run.stdout}`) iff action === 'warn';
 * silent (exit 0, no stdout) otherwise. Every evaluation — warn, silent-match, silent-unrelated,
 * override-used — is appended to the shared `.gate-telemetry/` sink (t/3394/t/3395 pattern) EXCEPT the
 * high-volume 'not-a-mutating-command' no-op, to keep the log to decision-relevant events only.
 *
 * FAIL-OPEN on any internal error (consistent with worktree-target-guard.mjs / worktree-path-guard):
 * a broken guard must never block or spam a legitimate git command. Telemetry is separately
 * best-effort (gate-telemetry.mjs's own isolation invariant) and can never affect the verdict.
 */
import { evaluateShellCommand, buildWarningMessage } from './worktree-owner-core.mjs';
import { gateTelemetryDir, appendGateTelemetry } from './gate-telemetry.mjs';

function main(argv) {
  const [command, agentId, rolePath, agentAddress] = argv;
  let verdict;
  try {
    verdict = evaluateShellCommand({ command, callerId: agentId, repoRoot: repoRootFromHereFallback() });
  } catch {
    return; // fail-open: any predicate error is silent, never a warn
  }

  if (verdict.reason !== 'not-a-mutating-command') {
    appendGateTelemetry({
      dir: gateTelemetryDir(import.meta.url),
      fileName: 'worktree-owner-guard.log',
      record: {
        ts: new Date().toISOString(),
        rule: 'worktree-owner-guard-shell',
        action: verdict.action,
        reason: verdict.reason,
        op: verdict.op,
        worktreeName: verdict.worktreeName,
        ownerId: verdict.ownerId || null,
        overrideTicket: verdict.overrideTicket || null,
        callerId: agentId || null,
        callerRole: rolePath || null,
      },
    });
  }

  if (verdict.action === 'warn') {
    process.stdout.write(buildWarningMessage({
      op: verdict.op,
      worktreeName: verdict.worktreeName,
      reason: verdict.reason,
      callerRole: rolePath,
      callerAddress: agentAddress,
    }));
  }
}

// repoRootFromHere needs import.meta.url from THIS file's location, not the core module's.
import { fileURLToPath } from 'node:url';
function repoRootFromHereFallback() {
  const here = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  return here.split('/').slice(0, -3).join('/');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worktree-owner-guard-shell.mjs')) {
  main(process.argv.slice(2));
}
