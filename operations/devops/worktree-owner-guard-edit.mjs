// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * CLI shim for the worktree-owner-guard-edit feedback rule (t/4212, route-enumeration blank #1,
 * closed per TL cond. 4). Invoked as:
 *   node worktree-owner-guard-edit.mjs "<file_path>" "<agent.id>" "<role.path>" "<agent.address>"
 * Same contract as worktree-owner-guard-shell.mjs — see that file's header for the fail-open and
 * telemetry rationale (identical here).
 */
import { fileURLToPath } from 'node:url';
import { evaluateFilePath, buildWarningMessage } from './worktree-owner-core.mjs';
import { gateTelemetryDir, appendGateTelemetry } from './gate-telemetry.mjs';

function repoRootFromHereFallback() {
  const here = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  return here.split('/').slice(0, -3).join('/');
}

function main(argv) {
  const [filePath, agentId, rolePath, agentAddress] = argv;
  let verdict;
  try {
    verdict = evaluateFilePath({ filePath, callerId: agentId, repoRoot: repoRootFromHereFallback() });
  } catch {
    return; // fail-open
  }

  if (verdict.reason !== 'not-under-worktrees-root') {
    appendGateTelemetry({
      dir: gateTelemetryDir(import.meta.url),
      fileName: 'worktree-owner-guard.log',
      record: {
        ts: new Date().toISOString(),
        rule: 'worktree-owner-guard-edit',
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

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worktree-owner-guard-edit.mjs')) {
  main(process.argv.slice(2));
}
