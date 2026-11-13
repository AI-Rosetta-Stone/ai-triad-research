// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { probeLazyGraph, shouldReloadOnce, type GraphProbe } from './lazyModuleProbe';

// Chrome/Vite reject a failed dynamic import with a TypeError whose message embeds the
// resolved module URL, e.g.:
//   "Failed to fetch dynamically imported module: http://127.0.0.1:5173/src/renderer/components/debate/DebateTab.tsx"
const MODULE_FETCH_ERROR_RE = /Failed to fetch dynamically imported module:?\s*(\S+)/i;

// Cap the dev-only probe so an unreachable server can't stall the ErrorBoundary fallback.
const PROBE_TIMEOUT_MS = 3000;

interface ModuleProbe {
  status: number | null; // HTTP status if the dev server answered
  body: string | null;   // first 500 chars of a non-2xx body (e.g. a Vite compile error)
  error: string | null;  // set when the fetch itself failed (connection refused ⇒ crashed server)
}

/**
 * Dev-only: re-fetch the failed module URL to recover the server-side signal the bare
 * import() rejection hides. Without it, a 500 compile error, a crashed/unreachable
 * server, and a stale-chunk cold-cache reload all surface as the same browser error
 * ("Failed to fetch dynamically imported module"), making triage impossible (t/2314,
 * discovered during t/2313). The probe disambiguates them:
 *   • 500 + body   ⇒ Vite compile/transform error (body carries the message)
 *   • fetch error  ⇒ dev server crashed or unreachable
 *   • 200          ⇒ module now serves fine ⇒ transient cold-cache full-reload
 */
// Exported for unit testing the 500 / fetch-error / 200 mapping; not part of the public API.
export function probeModule(url: string): Promise<ModuleProbe> {
  // Bare fetch is intentional here (cf. taxonomy-editor/AGENTS.md § Client Network
  // Resilience). This is NOT a shipped network call: the sole caller gates it on
  // `import.meta.hot`, so the whole branch is tree-shaken out of production bundles —
  // it never routes user traffic and thus is outside the web-bridge mandate. It is a
  // one-shot, no-retry, no-store status probe of an arbitrary Vite dev-server module
  // URL; the bridge's /api retry + circuit-breaker semantics would mask the very status
  // we are trying to read. The 3s AbortSignal timeout keeps a hung/unreachable server
  // from stalling the ErrorBoundary fallback (the caller awaits this probe before
  // re-throwing).
  return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .then(async (res): Promise<ModuleProbe> => ({
      status: res.status,
      body: res.ok ? null : (await res.text()).slice(0, 500),
      error: null,
    }))
    .catch((err: unknown): ModuleProbe => ({
      status: null,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }));
}

// Exported for unit testing the t/2314 disambiguation logic; not part of the public API.
// Probe only in dev (import.meta.hot present) — the whole branch is tree-shaken out of
// production builds, where there is no dev server to interrogate.
async function probeFailedModule(moduleUrl: string | null): Promise<{ probe: ModuleProbe; graph: GraphProbe | null }> {
  if (!moduleUrl || !import.meta.hot) return { probe: { status: null, body: null, error: null }, graph: null };
  return { probe: await probeModule(moduleUrl), graph: await probeLazyGraph(moduleUrl) };
}

export async function recordModuleFetchFailure(err: unknown): Promise<void> {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const moduleUrl = MODULE_FETCH_ERROR_RE.exec(message)?.[1] ?? null;

  const { probe, graph } = await probeFailedModule(moduleUrl);

  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'module-loader',
    level: 'error',
    message: moduleUrl ? `Dynamic import failed: ${moduleUrl}` : 'Dynamic import failed',
    error: { name, message, stack },
    data: {
      module_url: moduleUrl,
      http_status: probe.status,
      probe_error: probe.error,
      body_snippet: probe.body,
      graph_ok: graph?.graph_ok ?? null,
      graph_error: graph?.graph_error ?? null,
      child_url: graph?.child_url ?? null,
    },
  });
}

/**
 * Drop-in replacement for React.lazy that records dynamic-import failures — with a
 * dev-only HTTP-status probe of the module URL — before re-throwing, so Suspense /
 * ErrorBoundary behaviour is unchanged. Use for every lazily-loaded tab/window so a
 * "Failed to fetch dynamically imported module" leaves a self-diagnosing flight-recorder
 * entry instead of an ambiguous browser error (t/2314).
 */
// `any` mirrors React.lazy's own generic constraint (ComponentType<any>); the project's
// eslint base config does not enable no-explicit-any, so no disable directive is needed.
export function recordingLazy<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    loader().catch(async (err: unknown): Promise<{ default: T }> => {
      await recordModuleFetchFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      const moduleUrl = MODULE_FETCH_ERROR_RE.exec(message)?.[1] ?? null;
      if (moduleUrl && shouldReloadOnce(moduleUrl, window.sessionStorage)) {
        window.location.reload();
      }
      throw err;
    }),
  );
}
