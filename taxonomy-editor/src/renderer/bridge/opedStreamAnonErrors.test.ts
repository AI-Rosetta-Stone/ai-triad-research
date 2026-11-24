// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: the create errors an anonymous user can get from the merged server (routes/opedAnonGate.ts,
// routes/oped.ts). Each must reach the user with the server's own text and a fitting next step.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

import { runOpEdCreate } from './opedStream';

const params = { outlet: 'x', model: 'm', temperature: 0.2 } as never;

/** The error a create with `status` and `body` surfaces. */
async function errorFor(status: number, body: unknown): Promise<{ problem: string; nextSteps: string[]; httpStatus: number }> {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const err = await runOpEdCreate(fetchFn, { params, voices: ['acc'], topic: 'x' } as never).then(() => null, (e: unknown) => e);
  return err as { problem: string; nextSteps: string[]; httpStatus: number };
}

describe('create errors for anonymous users (t/467)', () => {
  it('spend ceiling shows the server text, not the plan-limit copy', async () => {
    const e = await errorFor(429, { error: 'spend_ceiling', ceiling: 'daily', message: 'Anonymous op-ed creation is paused: the spend limit has been reached. Sign in or try again later.' });
    expect(e.problem).toBe('Anonymous op-ed creation is paused: the spend limit has been reached. Sign in or try again later.');
    expect(e.problem).not.toMatch(/op-ed limit/);
    expect(e.nextSteps).toContain('Sign in to keep creating op-eds');
    expect(e.httpStatus).toBe(429);
  });

  it('URL-fetch limit shows the server text and offers a topic instead', async () => {
    const e = await errorFor(429, { error: 'rate_limited', message: 'Too many URL sources from this client; try again later.' });
    expect(e.problem).toBe('Too many URL sources from this client; try again later.');
    expect(e.nextSteps).toContain('Use a topic instead of a web page');
  });

  it('an unpriced model points to another model, not to sign-in', async () => {
    const e = await errorFor(403, { error: 'This model has no price on file, so it cannot run for anonymous users.' });
    expect(e.problem).toMatch(/no price on file/);
    expect(e.nextSteps).toEqual(['Choose a different model in Settings']);
  });

  it('an unkeyed anonymous session still points to sign-in or a fresh session', async () => {
    const e = await errorFor(403, { error: 'Start an anonymous session to create op-eds: reload the page, or sign in.' });
    expect(e.nextSteps).toEqual(['Sign in with GitHub or Google to create op-eds']);
  });

  it('a concurrency limit keeps its own wording', async () => {
    const e = await errorFor(429, { error: 'concurrency_limit', message: 'An op-ed is already generating for you, or the service is busy with anonymous runs. Wait for it to finish, then try again.' });
    expect(e.nextSteps).toEqual(['Wait for the current op-ed to finish, then try again']);
  });
});
