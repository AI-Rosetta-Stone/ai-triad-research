// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { currentMock } = vi.hoisted(() => ({ currentMock: vi.fn() }));

vi.mock('../index', () => ({
  navHistory: { current: currentMock },
}));

import {
  registerRun,
  isElsewhere,
  runningCountByTool,
  subscribeRunning,
  subscribeRunCompletion,
  __resetRunningSignalForTest,
} from '../runningSignal';

describe('runningSignal', () => {
  beforeEach(() => {
    __resetRunningSignalForTest();
    currentMock.mockReturnValue({ placeKey: 'rosetta-stone' });
  });

  it('isElsewhere is false for an item that was never registered', () => {
    expect(isElsewhere('chat', 'chat-1')).toBe(false);
  });

  it('isElsewhere is true once registered, unless the current place matches', () => {
    registerRun('chat', 'chat-1', 'My chat');
    expect(isElsewhere('chat', 'chat-1')).toBe(true);

    currentMock.mockReturnValue({ placeKey: 'chat:chat-1' });
    expect(isElsewhere('chat', 'chat-1')).toBe(false);
  });

  it('runningCountByTool only counts the given tool', () => {
    registerRun('chat', 'chat-1', 'My chat');
    registerRun('chat', 'chat-2', 'Other chat');
    registerRun('debate', 'debate-1', 'My debate');
    expect(runningCountByTool('chat')).toBe(2);
    expect(runningCountByTool('debate')).toBe(1);
  });

  it('unregistering via the returned callback clears the run', () => {
    const finish = registerRun('chat', 'chat-1', 'My chat');
    expect(runningCountByTool('chat')).toBe(1);
    finish('done');
    expect(runningCountByTool('chat')).toBe(0);
    expect(isElsewhere('chat', 'chat-1')).toBe(false);
  });

  it('is idempotent: registering the same item twice needs two outcomes to clear it', () => {
    const finishA = registerRun('chat', 'chat-1', 'My chat');
    const finishB = registerRun('chat', 'chat-1', 'My chat');
    finishA('done');
    expect(runningCountByTool('chat')).toBe(1); // still running — second registration outstanding
    finishB('done');
    expect(runningCountByTool('chat')).toBe(0);
  });

  it('the outcome callback is idempotent — a second call does not double-notify', () => {
    const finish = registerRun('chat', 'chat-1', 'My chat');
    const listener = vi.fn();
    subscribeRunCompletion(listener);
    finish('done');
    finish('done');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies running-state subscribers on register and on outcome', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRunning(listener);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    expect(listener).toHaveBeenCalledTimes(1);
    finish('done');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registerRun('chat', 'chat-2', 'Another chat');
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed — no further calls
  });

  it('completion carries wasElsewhere computed at the moment the outcome fires', () => {
    const listener = vi.fn();
    subscribeRunCompletion(listener);
    const finish = registerRun('debate', 'debate-1', 'My debate');

    currentMock.mockReturnValue({ placeKey: 'debate:debate-1' }); // user navigated to it
    finish('done');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'debate', itemId: 'debate-1', outcome: 'done', wasElsewhere: false,
    }));
  });

  it('reports aborted/error outcomes without altering the shape of the completion', () => {
    const listener = vi.fn();
    subscribeRunCompletion(listener);
    const finish = registerRun('chat', 'chat-1', 'My chat');
    finish('aborted');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted', wasElsewhere: true }));
  });
});
