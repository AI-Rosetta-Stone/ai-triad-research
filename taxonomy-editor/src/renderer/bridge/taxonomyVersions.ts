// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4187: optimistic concurrency for whole-file POV saves (web build). The bridge owns one "version cell" per
// POV: the ETag of the file the EDITOR last loaded or saved. A save sends it as If-Match, so the server writes
// only if the file hasn't moved since the editor's copy; otherwise it answers 409 WRITE_CONFLICT. A missing
// If-Match is answered 428 BASE_VERSION_REQUIRED. A successful save returns the new ETag, which becomes the
// cell's value, so a tab's next save doesn't conflict with its own previous one.
//
// Only an editor load sets the cell (loadForEdit). A plain read (the store's pre-save re-read, viewers in the
// same window) must NOT, or the next save would carry a version newer than the content being saved and the
// precondition would always pass: the lost update this fixes (t/4187#9).
//
// Saves are serialized per POV: an autosave and a manual save in flight together would otherwise both send the
// same If-Match, and the second would conflict with the first (TL t/4187#5).
//
// Extracted from web-bridge.ts (ADR-007, file at its max-lines ceiling); the fetch is injected so this module
// keeps the bridge's resilience and session recovery.

import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export type BridgeFetch = (path: string, init: RequestInit) => Promise<Response>;

export interface TaxonomyVersions {
  /** Read without touching the version cell. */
  load(pov: string): Promise<unknown>;
  /** Read for editing: the response's ETag becomes the POV's version cell (cleared when there is none). */
  loadForEdit(pov: string): Promise<unknown>;
  /** Save with If-Match from the cell; the response's ETag replaces it. Serialized per POV. */
  save(pov: string, data: unknown): Promise<void>;
}

/** The codes a save surfaces for the UI to branch on, alongside httpStatus. */
export const SAVE_CONFLICT_CODES = ['WRITE_CONFLICT', 'BASE_VERSION_REQUIRED'] as const;

const pathFor = (pov: string) => `/api/taxonomy/${encodeURIComponent(pov)}`;

function httpError(status: number, problem: string, location: string, code?: string): ActionableError {
  const conflict = code === 'WRITE_CONFLICT' || code === 'BASE_VERSION_REQUIRED';
  const err = new ActionableError({
    goal: location.endsWith('save') ? 'Save the taxonomy file' : 'Load the taxonomy file',
    problem,
    location,
    nextSteps: conflict
      ? ['Reload to see the current version', 'Reapply your edit after reloading']
      : ['Try again', 'Check the server logs if it keeps failing'],
  });
  Object.assign(err, { httpStatus: status }, code ? { code } : {});
  return err;
}

async function readCode(res: Response): Promise<string | undefined> {
  try {
    const body = await res.clone().json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch { /* telemetry — silent by design: a non-JSON error body simply carries no code */ }
  return undefined;
}

async function send(fetchFn: BridgeFetch, path: string, init: RequestInit, location: string): Promise<Response> {
  try {
    return await fetchFn(path, init);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'web-bridge', level: 'error',
      message: `${init.method ?? 'GET'} ${path} network error (${location})`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ActionableError({
        goal: 'Call server API', problem: `${init.method ?? 'GET'} ${path} timed out`, location,
        nextSteps: ['The server may be overloaded — try again', 'Check server logs for errors'], innerError: err,
      });
    }
    throw err;
  }
}

/** Parity with web-bridge's get/put: a login page served as HTML means the session is gone. */
function assertNotLoginPage(res: Response, location: string): void {
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new ActionableError({
      goal: location.endsWith('save') ? 'Save the taxonomy file' : 'Load the taxonomy file',
      problem: 'Server returned a login page instead of JSON data — authentication may be required',
      location,
      nextSteps: ['Sign in or navigate to /.auth/anonymous to start an anonymous session'],
    });
  }
}

export function createTaxonomyVersions(fetchFn: BridgeFetch): TaxonomyVersions {
  const cells = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();

  async function read(pov: string, forEdit: boolean): Promise<unknown> {
    const location = forEdit ? 'web-bridge.loadTaxonomyFileForEdit' : 'web-bridge.loadTaxonomyFile';
    const res = await send(fetchFn, pathFor(pov), { method: 'GET' }, location);
    if (!res.ok) {
      throw httpError(res.status, `GET ${pathFor(pov)} failed with HTTP ${res.status}: ${await res.text()}`, location);
    }
    assertNotLoginPage(res, location);
    if (forEdit) {
      const etag = res.headers.get('ETag');
      if (etag) cells.set(pov, etag);
      else cells.delete(pov); // no version from the server: never keep a stale one (TL: reset on every editor load)
    }
    return res.json();
  }

  async function doSave(pov: string, data: unknown): Promise<void> {
    const location = 'web-bridge.saveTaxonomyFile';
    const base = cells.get(pov);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (base) headers['If-Match'] = base;
    const res = await send(fetchFn, pathFor(pov), { method: 'PUT', headers, body: JSON.stringify(data) }, location);
    if (!res.ok) {
      const code = await readCode(res);
      const problem = code === 'WRITE_CONFLICT'
        ? 'Someone else changed this file since you loaded it. Reload to see their version.'
        : code === 'BASE_VERSION_REQUIRED'
          ? 'This page is out of date. Reload to save.'
          : `PUT ${pathFor(pov)} failed with HTTP ${res.status}: ${await res.text()}`;
      throw httpError(res.status, problem, location, code);
    }
    assertNotLoginPage(res, location);
    const etag = res.headers.get('ETag');
    if (etag) cells.set(pov, etag);
  }

  return {
    load: (pov) => read(pov, false),
    loadForEdit: (pov) => read(pov, true),
    save(pov, data) {
      // Chain after the previous save for this POV, success or failure, so each PUT sends the latest version.
      const prev = chains.get(pov) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(() => doSave(pov, data));
      chains.set(pov, next);
      void next.catch(() => undefined).then(() => { if (chains.get(pov) === next) chains.delete(pov); });
      return next;
    },
  };
}
