// @vitest-environment node
// t/2465 — resolveAnonSessionKey: anonymous analytics events keyed by the anon_session_id cookie instead of the
// _anonymous bucket. t/664/t/666: only a VERIFIED signed cookie counts; the key is the verified uuid's first 12 chars.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { resolveAnonSessionKey } from '../routes/session.js';
import { setAnonSessionSecret, signAnonSessionId } from '../security/anonSessionSigning.js';

const UUID = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const reqWith = (cookie?: string): IncomingMessage =>
  ({ headers: { cookie } } as unknown as IncomingMessage);

beforeAll(() => { setAnonSessionSecret(crypto.randomBytes(32)); });

describe('resolveAnonSessionKey (t/2465, t/664)', () => {
  it('returns anon:<first 12 chars of the uuid> for a verified signed cookie', () => {
    expect(resolveAnonSessionKey(reqWith(`anon_session_id=${signAnonSessionId(UUID)}`))).toBe(`anon:${UUID.slice(0, 12)}`);
  });

  it('a bare or forged cookie is not trusted: _anonymous', () => {
    expect(resolveAnonSessionKey(reqWith(`anon_session_id=${UUID}`))).toBe('_anonymous');
    expect(resolveAnonSessionKey(reqWith(`anon_session_id=${UUID}.${'0'.repeat(64)}`))).toBe('_anonymous');
  });

  it('returns _anonymous when no anon_session_id cookie is present', () => {
    expect(resolveAnonSessionKey(reqWith(undefined))).toBe('_anonymous');
    expect(resolveAnonSessionKey(reqWith('other=cookie'))).toBe('_anonymous');
  });
});
