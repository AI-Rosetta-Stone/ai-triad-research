// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Weekly future-clock prevention (t/4279, t/4268 Q3b): a fixture dated 2026-07-20 aged past a
// 90-day re-eligibility window on 2026-10-18, and nothing caught it before the date passed — the
// first signal was a scheduled run that looked like one more flake. This setup file shifts every
// test's clock forward by FUTURE_CLOCK_OFFSET_DAYS days, so a weekly CI run can surface a
// date-dependent fixture about a year before it actually expires.
//
// A no-op when the env var is absent (every normal `vitest run`, including the real-clock
// baseline leg of the future-clock workflow itself) — this file is always in setupFiles, but only
// the dedicated weekly job sets the env var.

import { afterEach, beforeEach, vi } from 'vitest';

const offsetDaysRaw = process.env.FUTURE_CLOCK_OFFSET_DAYS;
const offsetDays = offsetDaysRaw ? Number(offsetDaysRaw) : 0;

if (offsetDays > 0) {
  // Captured once at module load (the real "now" when this run started), not per-test — so every
  // test in the run sees the same shifted instant advancing at normal speed from that point,
  // rather than each test getting its own fresh +offsetDays from whenever it happens to run.
  const realNowMs = Date.now();
  const futureNowMs = realNowMs + offsetDays * 86_400_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(futureNowMs));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}
