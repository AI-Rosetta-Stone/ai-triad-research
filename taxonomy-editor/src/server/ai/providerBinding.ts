// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Cross-provider account collision guard.
 *
 * Records which identity provider (idp) first "claimed" each storageUserId.
 * Subsequent logins with a different idp for the same storageUserId are
 * rejected — preventing a user on provider B from landing in provider A's
 * data directory when both produce the same normalized id.
 *
 * Binding data lives at {dataRoot}/admin/provider_bindings.json, following
 * the same fs-with-mtime-cache pattern as quotas.ts.
 */

import fs from 'fs';
import path from 'path';
import { readFileWithMtime } from './fsCache.js';
import { getStateRoot } from '../config.js';
import { log } from '../logger.js';
import { getConfig } from '../runtimeConfig.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

// On-disk shape: a JSON object of { storageUserId: idp }.
type StoredBindings = Record<string, string>;

// Property names that would reach Object.prototype if used as a dynamic key.
// Kept as a defensive reject in checkProviderBinding even though the in-memory
// store is a Map (whose set()/get() never touch the prototype chain).
const FORBIDDEN_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);
function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

// Bindings live in a Map: a user-controlled key is only ever passed to
// Map.set()/get() (method calls), never used as a dynamic object-property name
// — which is the property-injection sink (CodeQL js/remote-property-injection).
let _cache: Map<string, string> | null = null;
let _cacheMtime = 0;
let _lastLoadTime = 0;

function getBindingsPath(): string {
  // t/2643: provider bindings are class-A writable state (runtime-written on first login) →
  // the writable state root, so a staging login can't rewrite prod's provider_bindings.json.
  return path.join(getStateRoot(), 'admin', 'provider_bindings.json');
}

function loadBindings(): Map<string, string> {
  const bindingsPath = getBindingsPath();
  try {
    const { content, mtimeMs } = readFileWithMtime(bindingsPath, _cache ? _cacheMtime : undefined);
    if (content === null) return _cache ?? new Map();
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // Rebuild into a Map, dropping any prototype-polluting or non-string
    // entries a hand-edited bindings file could contain.
    const clean = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed)) {
      if (!isForbiddenKey(k) && typeof v === 'string') clean.set(k, v);
    }
    _cache = clean;
    _cacheMtime = mtimeMs;
    return _cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'providerBinding',
        level: 'warn',
        message: 'Failed to load provider bindings — using empty defaults',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return new Map();
  }
}

function getBindings(): Map<string, string> {
  const now = Date.now();
  if (now - _lastLoadTime > getConfig().cache.defaultTtlMs) { // t/929: runtime-configurable (default 30_000)
    _lastLoadTime = now;
    return loadBindings();
  }
  return _cache ?? loadBindings();
}

function saveBindings(bindings: Map<string, string>): void {
  const bindingsPath = getBindingsPath();
  const dir = path.dirname(bindingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const serialized: StoredBindings = Object.fromEntries(bindings);
  fs.writeFileSync(bindingsPath, JSON.stringify(serialized, null, 2), 'utf-8');
  _cache = new Map(bindings);
  _cacheMtime = 0;
  _lastLoadTime = Date.now();
}

export interface BindingResult {
  ok: boolean;
  boundTo?: string;
}

/**
 * Verify that the idp is allowed to use this storageUserId.
 *
 * - First login for a storageUserId: binds it to the idp, returns ok.
 * - Matching idp: returns ok.
 * - Mismatched idp: returns { ok: false, boundTo } — the caller should
 *   reject the request (403).
 * - _local / empty: always ok (no binding for anonymous or Electron users).
 * - Mismatched idp, but `identityMapKey` set: an admin-held IDENTITY_MAP entry for this
 *   request's own (idp, stable id) — stronger proof than first-claim — overrides the
 *   mismatch (t/4540). The binding file is NOT rewritten: an admin asserting "same person
 *   across providers" shouldn't narrow future access to whichever provider signed in last.
 *   `identityMapKey` must come from `principalName.ts`'s `getIdentityMapKey(req)` (a
 *   WeakMap, never client input) — passing anything else here would move IDENTITY_MAP's
 *   trust root onto an attacker-controlled value, same risk class as the name/admin
 *   decisions IDENTITY_MAP already makes (#3744) deployed under this same trust: it's
 *   admin-held and deploy-gated, so this adds no new privilege-escalation class, only
 *   extends the existing one.
 */
export function checkProviderBinding(storageUserId: string, idp: string, identityMapKey?: string): BindingResult {
  if (!storageUserId || storageUserId === '_local') return { ok: true };
  // Defensive: reject reserved keys outright. The Map store already keeps a
  // user-controlled key off the object-property path (js/remote-property-injection),
  // so this is belt-and-suspenders plus a clear operator signal.
  if (isForbiddenKey(storageUserId)) {
    log.server.warn({ storageUserId }, 'Provider binding: rejected reserved storageUserId key');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'providerBinding', level: 'warn',
      message: 'Rejected reserved storageUserId key',
      data: { storageUserId },
    });
    return { ok: false };
  }

  const bindings = getBindings();
  const bound = bindings.get(storageUserId);

  if (!bound) {
    try {
      bindings.set(storageUserId, idp);
      saveBindings(bindings);
      log.server.info({ storageUserId, idp }, 'Provider binding created');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'providerBinding',
        level: 'warn',
        message: 'Failed to persist provider binding — allowing login',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return { ok: true };
  }

  if (bound === idp) return { ok: true };

  if (identityMapKey) {
    log.server.info({ storageUserId, idp, boundTo: bound, identityMapKey }, 'Accepted cross-provider sign-in via IDENTITY_MAP');
    return { ok: true };
  }

  log.server.warn({ storageUserId, idp, boundTo: bound }, 'Provider binding mismatch — access denied');
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'providerBinding',
    level: 'warn',
    message: `Provider mismatch: ${idp} attempted to access storageUserId bound to ${bound}`,
    data: { storageUserId, attemptedIdp: idp, boundIdp: bound },
  });
  return { ok: false, boundTo: bound };
}

/** Reset module cache — for testing only. */
export function _resetBindingsCache(): void {
  _cache = null;
  _cacheMtime = 0;
  _lastLoadTime = 0;
}
