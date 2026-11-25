// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/678: a source's full text is sign-in only (PI decision 5e). The server's refusal becomes a sign-in result;
// every other failure keeps its existing fallback.
import { describe, it, expect, vi } from 'vitest';
import { isSignInRequiredError, snapshotOrSignIn } from './sourceAccess';

const httpErr = (status: number, problem: string) => Object.assign(new Error(problem), { httpStatus: status, problem });
const ANON_403 = 'GET /api/snapshots/s1 failed with HTTP 403: {"error":"Sign in required","reason":"anon_route_blocked"}';

describe('sourceAccess (t/678)', () => {
  it('recognises only a 403 with reason anon_route_blocked', () => {
    expect(isSignInRequiredError(httpErr(403, ANON_403))).toBe(true);
    expect(isSignInRequiredError(httpErr(403, 'GET x failed with HTTP 403: {"error":"forbidden"}'))).toBe(false);
    expect(isSignInRequiredError(httpErr(401, ANON_403))).toBe(false);
    expect(isSignInRequiredError(new Error('network'))).toBe(false);
    expect(isSignInRequiredError(null)).toBe(false);
  });

  it('a sign-in refusal becomes { signInRequired } and skips the fallback', async () => {
    const other = vi.fn(() => null);
    await expect(snapshotOrSignIn(Promise.reject(httpErr(403, ANON_403)), other)).resolves.toEqual({ content: '', signInRequired: true });
    expect(other).not.toHaveBeenCalled();
  });

  it('any other failure takes the existing fallback; success passes through', async () => {
    const other = vi.fn(() => null);
    await expect(snapshotOrSignIn(Promise.reject(httpErr(500, 'boom')), other)).resolves.toBeNull();
    expect(other).toHaveBeenCalledTimes(1);
    await expect(snapshotOrSignIn(Promise.resolve({ content: 'text' }), other)).resolves.toEqual({ content: 'text' });
  });
});
