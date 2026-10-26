// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerExplainTarget, requestExplainForSelection, __clearExplainTargetsForTests } from './explainRequestBus';

beforeEach(() => { __clearExplainTargetsForTests(); });

describe('explainRequestBus', () => {
  it('delivers a selection request to the registered handler for that entry id', () => {
    const handler = vi.fn();
    registerExplainTarget('entry-1', handler);
    const handled = requestExplainForSelection('entry-1', 'some selected text');
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith({ text: 'some selected text' });
  });

  it('returns false and calls nothing when no handler is registered for that entry id', () => {
    const handled = requestExplainForSelection('unregistered-entry', 'text');
    expect(handled).toBe(false);
  });

  it('a request for one entry id never reaches a handler registered for a different id', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    registerExplainTarget('entry-a', handlerA);
    registerExplainTarget('entry-b', handlerB);
    requestExplainForSelection('entry-a', 'text');
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('unregistering stops further delivery to that handler', () => {
    const handler = vi.fn();
    const unregister = registerExplainTarget('entry-1', handler);
    unregister();
    expect(requestExplainForSelection('entry-1', 'text')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a later registration for the same entry id replaces the earlier one', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerExplainTarget('entry-1', first);
    registerExplainTarget('entry-1', second);
    requestExplainForSelection('entry-1', 'text');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unregistering a stale (replaced) handler does not remove the current one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerExplainTarget('entry-1', first);
    registerExplainTarget('entry-1', second);
    unregisterFirst(); // stale — 'second' is now registered, this must be a no-op
    expect(requestExplainForSelection('entry-1', 'text')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
