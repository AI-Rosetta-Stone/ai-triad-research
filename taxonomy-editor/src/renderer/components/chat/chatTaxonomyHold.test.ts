// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/490 item 3: generateOpening and sendMessage wait for the taxonomy before they build the prompt.
 * waitForTaxonomy is the wait: it resolves once the parts are loaded, rejects on a load error, and
 * rejects after its timeout, so a send never waits forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@bridge', () => ({ api: {}, setActiveDebateId: () => undefined, isElectronMode: () => false }));

import { waitForTaxonomy, chatErrorText } from '../../hooks/useChatStore';
import { ActionableError } from '@lib/debate/errors';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

const FILE = { nodes: [] };

function setParts(loaded: boolean): void {
  useTaxonomyStore.setState({
    accelerationist: loaded ? FILE : null,
    safetyist: loaded ? FILE : null,
    skeptic: loaded ? FILE : null,
    situations: loaded ? FILE : null,
    policyRegistry: loaded ? [] : null,
    loading: false,
    loadError: null,
    loadAll: vi.fn(async () => undefined),
  } as never);
}

describe('waitForTaxonomy (t/490 item 3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves at once when the taxonomy has already loaded', async () => {
    setParts(true);
    await expect(waitForTaxonomy()).resolves.toBeUndefined();
  });

  it('holds the send until the parts load, then resolves', async () => {
    setParts(false);
    let settled = false;
    const waiting = waitForTaxonomy().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    setParts(true);
    await waiting;
    expect(settled).toBe(true);
  });

  it('a failed load rejects with the load error, so the send surfaces it', async () => {
    setParts(false);
    const waiting = waitForTaxonomy();
    useTaxonomyStore.setState({ loadError: 'disk unreadable', loading: false } as never);
    const error = await waiting.then(() => null, (e: unknown) => e as { problem?: string; message?: string });
    expect(error?.problem).toBe("The taxonomy couldn't load, so the chat can't start. Check your connection, then send again.");
    expect(error?.problem).not.toContain('disk unreadable');
  });

  it('gives up after the timeout, so a send never waits forever', async () => {
    setParts(false);
    const waiting = waitForTaxonomy(1000);
    const expectation = expect(waiting).rejects.toMatchObject({ problem: 'The taxonomy is still loading, so the chat cannot start. Try again in a moment.' });
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });
});

describe('chatErrorText (t/490 item 3)', () => {
  it('shows a taxonomy wait error as written, with no prefix', () => {
    const err = new ActionableError({ goal: 'Chat: start a conversation', problem: 'The taxonomy is still loading, so the chat cannot start. Try again in a moment.', location: 'x', nextSteps: [] });
    expect(chatErrorText(err, 'Response failed')).toBe('The taxonomy is still loading, so the chat cannot start. Try again in a moment.');
  });

  it('keeps the prefix for any other failure', () => {
    expect(chatErrorText(new Error('boom'), 'Response failed')).toMatch(/^Response failed: /);
  });
});
