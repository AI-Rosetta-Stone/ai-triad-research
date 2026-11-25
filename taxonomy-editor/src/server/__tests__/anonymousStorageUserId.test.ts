// @vitest-environment node
// t/467 (TL p/16#209, PI option a): anonymous visitors get their own storage key from their
// anon_session_id cookie, so they do not share the '_local' store with the local user or with each other.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { anonymousStorageUserId } from '../security/userContext.js';
import { setAnonSessionSecret, signAnonSessionId } from '../security/anonSessionSigning.js';

// t/664: the cookie is <uuid>.<hmac>; only a validly signed one selects anon-<uuid>.
beforeAll(() => setAnonSessionSecret(crypto.randomBytes(32)));

const A = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const B = '7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601';

describe('anonymousStorageUserId (t/467)', () => {
  it('a valid anon_session_id gets its own anon-<uuid> key, never the shared _local store', () => {
    expect(anonymousStorageUserId(signAnonSessionId(A))).toBe(`anon-${A}`);
    expect(anonymousStorageUserId(signAnonSessionId(A))).not.toBe('_local');
    expect(anonymousStorageUserId(A)).toBe('_local'); // t/664: a bare uuid is no longer accepted
  });

  it('two different anonymous visitors get two different keys', () => {
    expect(anonymousStorageUserId(signAnonSessionId(A))).not.toBe(anonymousStorageUserId(signAnonSessionId(B)));
  });

  it('no cookie falls back to _local (refused by op-ed creation before any write)', () => {
    expect(anonymousStorageUserId(undefined)).toBe('_local');
  });

  it('a malformed or hostile cookie value never becomes a storage key', () => {
    for (const bad of ['', '../../etc', 'not-a-uuid', `${A}/../x`, A.toUpperCase(), `${A}\u0000`, 'anon-' + A]) {
      expect(anonymousStorageUserId(bad)).toBe('_local');
    }
  });
});
