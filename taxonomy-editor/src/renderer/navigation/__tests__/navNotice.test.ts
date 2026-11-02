// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC3 staging sweep: a not-found notice posted at boot — while MainApp still shows its
// loading screen and RunToastHost hasn't mounted — was lost. Held notices reach the first
// subscriber.

import { describe, it, expect, beforeEach } from 'vitest';
import { postNavNotice, subscribeNavNotice, __resetNavNoticeForTest } from '../navNotice';

describe('navNotice', () => {
  beforeEach(() => __resetNavNoticeForTest());

  it('a notice posted before anyone subscribes is delivered on the first subscribe', () => {
    postNavNotice('That debate couldn’t be found.');
    const got: string[] = [];
    subscribeNavNotice(t => got.push(t));
    expect(got).toEqual(['That debate couldn’t be found.']);
  });

  it('held notices are delivered once — a later subscriber does not get them again', () => {
    postNavNotice('held');
    subscribeNavNotice(() => {});
    const later: string[] = [];
    subscribeNavNotice(t => later.push(t));
    expect(later).toEqual([]);
  });

  it('with a subscriber present, a notice is delivered immediately and not held', () => {
    const got: string[] = [];
    const unsubscribe = subscribeNavNotice(t => got.push(t));
    postNavNotice('now');
    expect(got).toEqual(['now']);
    unsubscribe();
    const next: string[] = [];
    subscribeNavNotice(t => next.push(t));
    expect(next).toEqual([]);
  });
});
