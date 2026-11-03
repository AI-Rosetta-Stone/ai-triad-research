// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerShareProvider, getShareProvider, __resetShareProvidersForTest, type ShareProvider } from '../shareProvider';
import type { PlaceInfo } from '../types';

const place = (tool: PlaceInfo['tool'], placeKey: string): PlaceInfo =>
  ({ tool, placeKey, path: '/x', label: 'x', crumbs: [] });

const dummyProvider: ShareProvider = {
  label: 'Copy public link',
  needsConfirm: false,
  current: () => Promise.resolve(null),
  create: () => Promise.resolve('https://example.test/x'),
};

describe('shareProvider registry', () => {
  beforeEach(() => __resetShareProvidersForTest());

  it('returns null for a tool with no registered provider (lists/settings)', () => {
    expect(getShareProvider(place('opeds', 'opeds:none'))).toBeNull();
  });

  it('a registered factory resolves for its tool', () => {
    registerShareProvider('opeds', () => dummyProvider);
    expect(getShareProvider(place('opeds', 'opeds:s1'))).toBe(dummyProvider);
  });

  it('a factory can itself decline (e.g. a library place) by returning null', () => {
    registerShareProvider('opeds', (p) => (p.placeKey === 'opeds:none' ? null : dummyProvider));
    expect(getShareProvider(place('opeds', 'opeds:none'))).toBeNull();
    expect(getShareProvider(place('opeds', 'opeds:s1'))).toBe(dummyProvider);
  });

  it('a later registerShareProvider call for the same tool replaces the earlier one (re-registration on reload)', () => {
    const second: ShareProvider = { ...dummyProvider, label: 'second' };
    registerShareProvider('inquiry', () => dummyProvider);
    registerShareProvider('inquiry', () => second);
    expect(getShareProvider(place('inquiry', 'inquiry:q1'))).toBe(second);
  });

  it('registering one tool does not affect another (TL point 1: no shared central switch)', () => {
    registerShareProvider('opeds', () => dummyProvider);
    expect(getShareProvider(place('inquiry', 'inquiry:q1'))).toBeNull();
  });
});
