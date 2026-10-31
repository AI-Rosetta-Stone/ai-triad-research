// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { navHistory } from './index';

export type RunningToolId = 'chat' | 'debate';
export type RunOutcome = 'done' | 'error' | 'aborted';

export interface RunCompletion {
  tool: RunningToolId;
  itemId: string;
  title: string;
  outcome: RunOutcome;
  /** Whether the run was not the current place when it finished — the shell toast
   *  (done/error only, never aborted) fires only when this is true. */
  wasElsewhere: boolean;
}

interface RunEntry {
  title: string;
  count: number;
}

const running = new Map<string, RunEntry>();
const runningListeners = new Set<() => void>();
const completionListeners = new Set<(completion: RunCompletion) => void>();

function key(tool: RunningToolId, itemId: string): string {
  return `${tool}:${itemId}`;
}

function notifyRunningChanged(): void {
  for (const listener of runningListeners) listener();
}

/**
 * Called from the store-level run loop ONLY — never a view's useEffect/unmount handler,
 * since leaving the view is exactly the case this exists for; a view-scoped call would
 * unregister on navigation and defeat the feature. t/4687/t/4688 verify this call site.
 *
 * Idempotent: registering the same (tool, itemId) twice increments a refcount rather than
 * overwriting, and the run stays "elsewhere" until every registration's outcome has fired.
 */
export function registerRun(tool: RunningToolId, itemId: string, title: string): (outcome: RunOutcome) => void {
  const k = key(tool, itemId);
  const existing = running.get(k);
  running.set(k, { title, count: (existing?.count ?? 0) + 1 });
  notifyRunningChanged();

  let settled = false;
  return (outcome: RunOutcome) => {
    if (settled) return;
    settled = true;

    const entry = running.get(k);
    const remaining = (entry?.count ?? 1) - 1;
    const wasElsewhere = isElsewhere(tool, itemId);
    if (remaining <= 0) {
      running.delete(k);
    } else {
      running.set(k, { title: entry?.title ?? title, count: remaining });
    }
    notifyRunningChanged();

    for (const listener of completionListeners) {
      listener({ tool, itemId, title, outcome, wasElsewhere });
    }
  };
}

/**
 * Running AND not the current place. A popout (Electron) or a new tab (web) is a
 * separate renderer with its own store instance, so the main window's signal never
 * sees runs started there in the first place — no separate "is this a ⧉ window" flag.
 */
export function isElsewhere(tool: RunningToolId, itemId: string): boolean {
  if (!running.has(key(tool, itemId))) return false;
  return navHistory.current()?.placeKey !== key(tool, itemId);
}

export function runningCountByTool(tool: RunningToolId): number {
  let count = 0;
  const prefix = `${tool}:`;
  for (const k of running.keys()) {
    if (k.startsWith(prefix)) count++;
  }
  return count;
}

/** For the rail dot and the Recent row's "Running…" state. */
export function subscribeRunning(listener: () => void): () => void {
  runningListeners.add(listener);
  return () => runningListeners.delete(listener);
}

/** For the shell's finished toast. */
export function subscribeRunCompletion(listener: (completion: RunCompletion) => void): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}

/** Test-only: clears all running state between tests. */
export function __resetRunningSignalForTest(): void {
  running.clear();
}
