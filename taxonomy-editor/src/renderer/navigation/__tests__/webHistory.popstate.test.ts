// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640#40 item 5: on the web, browser Back moved the URL but the view stuck. WebHistory must
// notify on every popstate (so the subscriber restores) and keep its stack index in step.

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebHistory } from '../navHistory';
import type { HistoryEntry } from '../types';

function popTo(state: unknown, path: string): void {
  window.history.replaceState(state, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

describe('WebHistory popstate', () => {
  let history: WebHistory;
  let notified: HistoryEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    history = new WebHistory();
    notified = [];
    unsubscribe = history.subscribe(e => notified.push(e));
  });
  // Each WebHistory keeps its window popstate listener; drop this test's subscriber so an
  // earlier instance can't push into the next test's array.
  afterEach(() => unsubscribe());

  it('notifies with the entry popped to and syncs index() from its state', () => {
    history.replace({ path: '/', placeKey: 'rosetta-stone', label: 'Rosetta Stone' });
    history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
    history.push({ path: '/debate', placeKey: 'debate:none', label: 'Debate' });
    expect(history.index()).toBe(2);
    notified = [];

    popTo({ v: 1, idx: 1, placeKey: 'chat:none', label: 'Chat' }, '/chat');

    expect(notified.map(e => e.placeKey)).toEqual(['chat:none']);
    expect(notified[0].path).toBe('/chat');
    expect(history.index()).toBe(1);
  });

  it('still notifies for an entry it didn\'t write, with its URL and an empty placeKey', () => {
    popTo({}, '/taxonomy/acc?node=n-1');

    expect(notified).toHaveLength(1);
    expect(notified[0].placeKey).toBe('');
    expect(notified[0].path).toBe('/taxonomy/acc?node=n-1');
  });
});
