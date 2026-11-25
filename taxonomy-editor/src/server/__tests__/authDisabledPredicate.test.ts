// @vitest-environment node
// t/516: the copy of the AUTH_DISABLED rule in userContext (isAuthDisabledMode) must match accessControl's
// isAuthDisabledAllowed, for every env combination that matters.
import { describe, it, expect } from 'vitest';
import { isAuthDisabledAllowed } from '../security/accessControl.js';
import { isAuthDisabledMode } from '../security/userContext.js';

describe('t/516: isAuthDisabledMode matches accessControl.isAuthDisabledAllowed', () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ['1', 'development'], ['1', 'test'], ['1', undefined], ['1', 'production'],
    ['0', 'development'], [undefined, 'development'], ['true', 'development'],
  ];
  for (const [auth, node] of cases) {
    it(`AUTH_DISABLED=${auth} NODE_ENV=${node}`, () => {
      const env = { AUTH_DISABLED: auth, NODE_ENV: node } as NodeJS.ProcessEnv;
      const saved = { a: process.env.AUTH_DISABLED, n: process.env.NODE_ENV };
      try {
        if (auth === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = auth;
        if (node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = node;
        expect(isAuthDisabledMode()).toBe(isAuthDisabledAllowed(env));
      } finally {
        if (saved.a === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = saved.a;
        if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
      }
    });
  }
});
