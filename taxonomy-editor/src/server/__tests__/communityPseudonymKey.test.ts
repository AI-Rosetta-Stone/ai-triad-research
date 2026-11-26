// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/693: the community pseudonym subkey derived from anon-session-hmac.
 *   - null with no secret installed (the caller shows the fixed word, never the storage id)
 *   - deterministic per secret, different per environment, and it changes on rotation
 *   - it is not the secret, and it cannot sign or verify a session cookie
 *   - the cookie signer cannot be made to produce it (the label is not a uuid v4)
 */

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  setAnonSessionSecret, clearAnonSessionSecret, signAnonSessionId, verifyAnonSessionCookie, deriveCommunityPseudonymKey,
} from '../security/anonSessionSigning.js';

const PROD = crypto.randomBytes(32);
const STAGING = crypto.randomBytes(32);
const UUID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

afterEach(() => { clearAnonSessionSecret(); });

describe('t/693: deriveCommunityPseudonymKey', () => {
  it('is null until a secret is installed', () => {
    expect(deriveCommunityPseudonymKey()).toBeNull();
  });

  it('is 32 bytes, stable for one secret and equal to HMAC-SHA256(secret, label)', () => {
    setAnonSessionSecret(PROD);
    const key = deriveCommunityPseudonymKey()!;
    expect(key.length).toBe(32);
    expect(deriveCommunityPseudonymKey()!.equals(key)).toBe(true);
    expect(key.equals(crypto.createHmac('sha256', PROD).update('community-pseudonym-v1').digest())).toBe(true);
  });

  it('differs between environments and changes on rotation', () => {
    setAnonSessionSecret(PROD);
    const prod = deriveCommunityPseudonymKey()!;
    setAnonSessionSecret(STAGING);
    expect(deriveCommunityPseudonymKey()!.equals(prod)).toBe(false);
  });

  it('is not the secret and does not work as a cookie-signing key', () => {
    setAnonSessionSecret(PROD);
    const key = deriveCommunityPseudonymKey()!;
    expect(key.equals(PROD)).toBe(false);
    const forged = `${UUID}.${crypto.createHmac('sha256', key).update(UUID).digest('base64url')}`;
    expect(verifyAnonSessionCookie(forged)).toBeUndefined();
  });

  it('the cookie signer refuses the label, so it cannot be used to obtain the subkey', () => {
    setAnonSessionSecret(PROD);
    expect(() => signAnonSessionId('community-pseudonym-v1')).toThrow();
  });
});
