// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/664 (t/500 part A; Security t/500#10, TL t/500#11, #14): the anonymous session cookie is signed.
 *
 *   anon_session_id = <uuid v4>.<base64url HMAC-SHA256(uuid) under the per-environment secret>
 *
 * Verification checks the shape first, then compares the full 256-bit digest with crypto.timingSafeEqual.
 * There is NO fallback: a bare uuid (the pre-t/664 cookie), an unsigned, forged or other-environment cookie,
 * or one signed with a rotated-out secret does not verify, so it never selects anyone's anon-<uuid> store.
 *
 * Pure crypto, no file or network I/O (userContext imports this). The secret is installed by
 * anonSessionSecret.ts at boot. Until it is installed, nothing verifies and nothing can be signed
 * (fail closed). The secret is never logged, returned or serialized.
 */

import crypto from 'crypto';
import { ActionableError } from '../../../../lib/debate/errors.js';

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4_RE = new RegExp(`^${UUID_V4}$`);
/** <uuid v4>.<43 base64url chars> (32 bytes, unpadded). */
const SIGNED_RE = new RegExp(`^(${UUID_V4})\\.([A-Za-z0-9_-]{43})$`);

/** The minimum secret length in bytes (TL t/500#14: 32+ random bytes). */
export const ANON_SESSION_SECRET_MIN_BYTES = 32;

let secret: Buffer | null = null;

/** Installs (or replaces, on rotation) the signing secret. Throws on a secret shorter than 32 bytes. */
export function setAnonSessionSecret(value: Buffer): void {
  if (value.length < ANON_SESSION_SECRET_MIN_BYTES) {
    throw new ActionableError({ goal: 'Sign an anonymous session id', problem: `anon-session-hmac must be at least ${ANON_SESSION_SECRET_MIN_BYTES} bytes`, location: 'security/anonSessionSigning.ts', nextSteps: ['Generate the secret from 32 or more random bytes (t/664)'] });
  }
  secret = Buffer.from(value);
}

/** Test seam: forget the secret (back to the fail-closed state). */
export function clearAnonSessionSecret(): void {
  secret = null;
}

/** True once a secret is installed, so anonymous sessions can be minted and verified. */
export function anonSessionSigningReady(): boolean {
  return secret !== null;
}

/** The label the community pseudonym subkey is derived under. Changing it changes every pseudonym. */
const COMMUNITY_PSEUDONYM_LABEL = 'community-pseudonym-v1';

/**
 * t/693: the key Community uses to turn a contributor's storage id into a display pseudonym, or null when no
 * secret is installed (the caller then shows the fixed word, never the storage id).
 *
 *   subkey = HMAC-SHA256(anon-session-hmac, 'community-pseudonym-v1')
 *
 * One-way: the subkey does not reveal the signing secret, and it cannot be used to sign a cookie. The cookie
 * path cannot produce it either, because signAnonSessionId only MACs a uuid v4 and the label is not one.
 * Rotating anon-session-hmac changes the subkey, so pseudonyms published afterwards differ from stored ones.
 * The subkey is a credential: never log, return or serialize it.
 */
export function deriveCommunityPseudonymKey(): Buffer | null {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(COMMUNITY_PSEUDONYM_LABEL, 'utf8').digest();
}

function mac(uuid: string, key: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(uuid, 'utf8').digest();
}

/** `<uuid>.<sig>` for a uuid v4. Throws when no secret is installed (never mints an unsigned cookie). */
export function signAnonSessionId(uuid: string): string {
  if (!UUID_V4_RE.test(uuid)) throw new ActionableError({ goal: 'Sign an anonymous session id', problem: 'signAnonSessionId was given a value that is not a uuid v4', location: 'security/anonSessionSigning.ts', nextSteps: ['Pass crypto.randomUUID() output'] });
  if (!secret) throw new ActionableError({ goal: 'Sign an anonymous session id', problem: 'anonymous session signing is unavailable: the anon-session-hmac secret is not loaded', location: 'security/anonSessionSigning.ts', nextSteps: ['Load anon-session-hmac at boot (anonSessionSecret.ts); hosted needs the secret in Key Vault'] });
  return `${uuid}.${mac(uuid, secret).toString('base64url')}`;
}

/**
 * The uuid inside a validly signed cookie value, or undefined. Undefined for: no value, a bare uuid, any other
 * shape, a signature that is not exactly 32 bytes, a wrong signature (forged, other environment, rotated-out
 * secret), or no secret installed. Constant-time over the full digest.
 */
export function verifyAnonSessionCookie(raw: string | undefined): string | undefined {
  if (raw === undefined || !secret) return undefined;
  const m = SIGNED_RE.exec(raw);
  if (!m) return undefined;
  const [, uuid, sig] = m;
  const given = Buffer.from(sig, 'base64url');
  const want = mac(uuid, secret);
  if (given.length !== want.length) return undefined;
  return crypto.timingSafeEqual(given, want) ? uuid : undefined;
}
