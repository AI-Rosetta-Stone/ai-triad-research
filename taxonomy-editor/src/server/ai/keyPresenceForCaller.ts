// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/516 (t/501 incident): whether the CALLER has a key for a backend, as a presence check for listing routes.
//
// An anonymous request has no stored keys of its own. Its principal is '_local' (server.ts), so a plain
// hasApiKey() would read the OWNER's '_local' key slots and report which providers the owner holds keys for.
// For an anonymous caller the only server-side key is the free pool, which serves gemini, so presence is the
// pool's: gemini if the pool has keys, and every other backend false. No owner slot is read.
// Signed-in callers are unchanged: hasApiKey() resolves their own keys.

import { hasApiKey, type AIBackend } from '../config.js';
import { isHostedAnonymousRequest } from '../security/userContext.js';
import { freeTierKeyCount } from './proxyTiers.js';

export async function callerHasKey(backend: string): Promise<boolean> {
  if (isHostedAnonymousRequest()) return backend === 'gemini' && freeTierKeyCount() > 0;
  return hasApiKey(backend as AIBackend);
}
