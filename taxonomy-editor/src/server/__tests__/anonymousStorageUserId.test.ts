// @vitest-environment node
// t/467 (TL p/16#209, PI option a): anonymous visitors get their own storage key from their
// anon_session_id cookie, so they do not share the '_local' store with the local user or with each other.

import { describe, it, expect } from 'vitest';
import { anonymousStorageUserId } from '../security/userContext.js';

const A = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const B = '7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601';

describe('anonymousStorageUserId (t/467)', () => {
  it('a valid anon_session_id gets its own anon-<uuid> key, never the shared _local store', () => {
    expect(anonymousStorageUserId(A)).toBe(`anon-${A}`);
    expect(anonymousStorageUserId(A)).not.toBe('_local');
  });

  it('two different anonymous visitors get two different keys', () => {
    expect(anonymousStorageUserId(A)).not.toBe(anonymousStorageUserId(B));
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
