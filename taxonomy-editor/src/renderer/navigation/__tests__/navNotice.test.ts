// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC3: a not-found notice must reach the user even though the toast host mounts, unmounts
// (MainApp's loading screen) and remounts during boot. Notices stay active for their display
// window; every subscriber gets the active ones.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { postNavNotice, subscribeNavNotice, dismissNavNotice, NAV_NOTICE_TTL_MS, __resetNavNoticeForTest, type NavNotice } from '../navNotice';

const texts = (got: NavNotice[]) => got.map(n => n.text);

describe('navNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetNavNoticeForTest();
  });
  afterEach(() => vi.useRealTimers());

  it('a notice posted before anyone subscribes reaches the first subscriber', () => {
    postNavNotice('That debate couldn’t be found.');
    const got: NavNotice[] = [];
    subscribeNavNotice(n => got.push(n));
    expect(texts(got)).toEqual(['That debate couldn’t be found.']);
  });

  it('boot remount: a notice delivered to a host that then unmounts reaches the remounted host', () => {
    const first: NavNotice[] = [];
    const unmount = subscribeNavNotice(n => first.push(n));
    postNavNotice('That chat couldn’t be found.'); // the fast-failing restore
    unmount(); // MainApp swaps to its loading screen

    vi.advanceTimersByTime(3000); // loadAll runs
    const remounted: NavNotice[] = [];
    subscribeNavNotice(n => remounted.push(n));

    expect(texts(first)).toEqual(['That chat couldn’t be found.']);
    expect(texts(remounted)).toEqual(['That chat couldn’t be found.']);
    expect(remounted[0].id).toBe(first[0].id); // same notice, so a host can de-duplicate by id
  });

  it('a dismissed notice is not replayed to a later subscriber', () => {
    postNavNotice('gone');
    const got: NavNotice[] = [];
    subscribeNavNotice(n => got.push(n))();
    dismissNavNotice(got[0].id);
    const later: NavNotice[] = [];
    subscribeNavNotice(n => later.push(n));
    expect(later).toEqual([]);
  });

  it('a notice older than its display window is not replayed', () => {
    postNavNotice('stale');
    vi.advanceTimersByTime(NAV_NOTICE_TTL_MS + 1);
    const later: NavNotice[] = [];
    subscribeNavNotice(n => later.push(n));
    expect(later).toEqual([]);
  });

  it('with a subscriber present, a notice is delivered immediately', () => {
    const got: NavNotice[] = [];
    subscribeNavNotice(n => got.push(n));
    postNavNotice('now');
    expect(texts(got)).toEqual(['now']);
  });
});
