// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// § Phone "up": at phone width, with nothing to go back to and a linked ancestor, ← goes up.

import { describe, it, expect } from 'vitest';
import { backAction } from './backAction';
import type { Crumb, HistoryEntry } from '../../navigation/types';

const chatItem: Crumb[] = [{ text: 'Chat', href: '/chat' }, { text: 'Compute caps' }];
const taxonomyNode: Crumb[] = [
  { text: 'Taxonomy' },
  { text: 'Safetyist', camp: 'saf', href: '/taxonomy/saf' },
  { text: 'Keep humans in the loop' },
];
const dest: HistoryEntry = { path: '/debate', placeKey: 'debate:none', label: 'Debate', timestamp: 0 };

describe('backAction', () => {
  it('phone + deep link (no Back) + linked ancestor → up to that ancestor', () => {
    expect(backAction({ isPhone: true, canGoBack: false, backDest: undefined, crumbs: chatItem }))
      .toEqual({ kind: 'up', name: 'Up to Chat', href: '/chat' });
  });

  it('skips a non-link ancestor ("Taxonomy") and goes up to the linked camp', () => {
    expect(backAction({ isPhone: true, canGoBack: false, backDest: undefined, crumbs: taxonomyNode }))
      .toEqual({ kind: 'up', name: 'Up to Safetyist', href: '/taxonomy/saf' });
  });

  it('with two linked ancestors, goes up to the nearer one — one level, not to the top', () => {
    const crumbs: Crumb[] = [{ text: 'Outer', href: '/outer' }, { text: 'Inner', href: '/inner' }, { text: 'Item' }];
    expect(backAction({ isPhone: true, canGoBack: false, backDest: undefined, crumbs }))
      .toEqual({ kind: 'up', name: 'Up to Inner', href: '/inner' });
  });

  it('phone with history to go back to → plain Back, named for its destination', () => {
    expect(backAction({ isPhone: true, canGoBack: true, backDest: dest, crumbs: chatItem }))
      .toEqual({ kind: 'back', name: 'Back to Debate', enabled: true });
  });

  it('phone, no history, no linked ancestor (a collection) → disabled plain Back', () => {
    expect(backAction({ isPhone: true, canGoBack: false, backDest: undefined, crumbs: [{ text: 'Chat' }] }))
      .toEqual({ kind: 'back', name: 'Back', enabled: false });
  });

  it('wider than phone never goes up — the crumbs are visible there', () => {
    expect(backAction({ isPhone: false, canGoBack: false, backDest: undefined, crumbs: chatItem }))
      .toEqual({ kind: 'back', name: 'Back', enabled: false });
  });
});
