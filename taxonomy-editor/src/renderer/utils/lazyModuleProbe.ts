// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/417: probing and reload-guard helpers for lazily loaded modules. Kept apart from recordingLazy.ts
// so each file stays within the complexity budget.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

// t/417: the module URL alone can look healthy (HTTP 200) while one of its own imports fails
// (a dep that Vite re-optimised mid-session). This re-imports the lazy module under a fresh query,
// so the browser re-evaluates it and reports the import that actually fails.
export interface GraphProbe {
  graph_ok: boolean;          // the module, re-imported with a fresh query, evaluated without error
  graph_error: string | null; // the error text from that re-import
  child_url: string | null;   // the failing child URL, when the error names one
}

const CHILD_FAILURE_RE = /Failed to fetch dynamically imported module:?\s*(\S+)|Outdated Optimize Dep|Failed to resolve module specifier[^\n]*/i;

// The URL of the failing child import, when the error names one (a bare marker has no URL).
function childUrl(message: string): string | null {
  const m = CHILD_FAILURE_RE.exec(message);
  return m?.[1] ?? null;
}

export async function probeLazyGraph(
  moduleUrl: string,
  importer: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
): Promise<GraphProbe> {
  const separator = moduleUrl.includes('?') ? '&' : '?';
  try {
    await importer(`${moduleUrl}${separator}fr-probe=${Date.now()}`);
    return { graph_ok: true, graph_error: null, child_url: null };
  } catch (err: unknown) {
    /* telemetry — silent by design: recordModuleFetchFailure records graph_error and child_url */
    const graphError = err instanceof Error ? err.message : String(err);
    return {
      graph_ok: false,
      graph_error: graphError.slice(0, 500),
      child_url: childUrl(graphError),
    };
  }
}

// t/417: reload the page once when a lazy module fails to load, then stop. The guard is per module
// URL and lives in sessionStorage, which survives the reload, so a module that still fails after the
// reload is not retried in a loop. Returns true only the first time for a URL.
const LAZY_RELOAD_KEY_PREFIX = 'taxonomy-editor:lazy-reload:';

export function shouldReloadOnce(moduleUrl: string, storage: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  const key = LAZY_RELOAD_KEY_PREFIX + moduleUrl;
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, '1');
    return true;
  } catch (err: unknown) {
    // Storage unavailable (private mode, quota): do not reload, so a broken module cannot loop.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'module-loader', level: 'warn',
      message: 'Lazy-reload guard unavailable (sessionStorage); not reloading',
      error: { name: err instanceof Error ? err.name : 'Error', message: String(err), stack: err instanceof Error ? err.stack : undefined },
    });
    return false;
  }
}
