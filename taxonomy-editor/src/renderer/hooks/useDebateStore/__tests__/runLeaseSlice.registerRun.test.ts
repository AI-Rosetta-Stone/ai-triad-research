// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4691, per TL p/864#1 / t/4688#1: registerRun must be called from the store-level run loop
// (runUnderDebateLease, the single chokepoint every automatic-advancing call goes through), with
// the outcome the shell's RunToastHost depends on — 'done' on a clean completion, 'error' on a
// thrown rejection, and 'aborted' when the run's own abort controller was cancelled mid-run
// (so the finished toast doesn't fire on a user-initiated Stop / model-switch retry).
//
// `runLeaseSingleFlight.test.ts` already covers the lease mechanics (single-flight, supersede,
// remote-window refusal) end to end via `runOpeningStatements`; this file is scoped to the
// registerRun/outcome instrumentation added on top of that wrapper.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRegisterRun, mockFinishRun } = vi.hoisted(() => {
  const mockFinishRun = vi.fn();
  const mockRegisterRun = vi.fn().mockReturnValue(mockFinishRun);
  return { mockRegisterRun, mockFinishRun };
});

vi.mock('../../../navigation/runningSignal', () => ({
  registerRun: mockRegisterRun,
}));

// Harness FIRST so its hoisted vi.mock registrations run before the store imports.
import { makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { newAbortController, cancelAndResetAbort } from '../shared/guards';

type Store = ReturnType<typeof useDebateStore.getState>;

function seedDebate(): string {
  const session = makeSession();
  useDebateStore.setState({
    activeDebate: session as unknown as Store['activeDebate'],
    activeDebateId: session.id,
  });
  return session.id;
}

describe('runUnderDebateLease — registerRun/outcome wiring (t/4691)', () => {
  beforeEach(() => {
    mockRegisterRun.mockClear();
    mockFinishRun.mockClear();
  });

  it('registers once with the debate\'s title and reports "done" on a clean completion', async () => {
    const debateId = seedDebate();
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { newAbortController(); });

    await useDebateStore.getState().crossRespond({ caller: 'test' });

    expect(mockRegisterRun).toHaveBeenCalledTimes(1);
    expect(mockRegisterRun).toHaveBeenCalledWith('debate', debateId, 'AI governance');
    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('done');
  });

  it('reports "error" when the leased body throws, and the throw still propagates', async () => {
    seedDebate();
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockRejectedValue(new Error('boom'));

    await expect(useDebateStore.getState().crossRespond({ caller: 'test' })).rejects.toThrow('boom');

    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('error');
  });

  it('reports "aborted", not "done", when the run\'s own controller is cancelled mid-run', async () => {
    seedDebate();
    let started = false;
    let resolveFn!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFn = resolve; });
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      newAbortController(); // mirrors the real leased body's own synchronous prelude
      started = true;
      await gate;
    });

    const run = useDebateStore.getState().crossRespond({ caller: 'test' });
    // Wait until the leased body has actually started (past its own newAbortController() call,
    // which — per the capture-timing fix — must land in `_abortController` before anything else
    // can run, since nothing can interleave before fn()'s first await in a single-threaded VM).
    await vi.waitFor(() => expect(started).toBe(true));
    cancelAndResetAbort(); // an external Stop / model-switch cancel, exactly as production fires it
    resolveFn();
    await run;

    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('aborted');
  });

  it('control: no cancellation reports "done", not "aborted"', async () => {
    seedDebate();
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { newAbortController(); });

    await useDebateStore.getState().crossRespond({ caller: 'test' });

    expect(mockFinishRun).toHaveBeenCalledWith('done');
  });

  it('a refused re-entry never registers a run — only the holder\'s call does', async () => {
    seedDebate();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      newAbortController();
      await gate;
    });

    const first = useDebateStore.getState().crossRespond({ caller: 'first' });
    await vi.waitFor(() => expect(mockRegisterRun).toHaveBeenCalledTimes(1));

    await useDebateStore.getState().crossRespond({ caller: 'second' }); // refused before fn() ever runs
    expect(mockRegisterRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).not.toHaveBeenCalled();

    openGate();
    await first;
    expect(mockFinishRun).toHaveBeenCalledTimes(1);
  });
});
