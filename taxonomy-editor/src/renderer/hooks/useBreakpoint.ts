// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect } from 'react';

export type Breakpoint = 'phone' | 'phone-lg' | 'tablet' | 'tablet-lg' | 'desktop';

const BREAKPOINT_QUERIES: [Breakpoint, string][] = [
  ['phone', '(max-width: 479px)'],
  ['phone-lg', '(max-width: 767px)'],
  ['tablet', '(max-width: 1023px)'],
  ['tablet-lg', '(max-width: 1199px)'],
];

// jsdom (unit tests) has no matchMedia unless a test mocks it; treat that as desktop so a shared
// component using this hook doesn't crash every test that renders it (t/4571).
const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function resolveBreakpoint(): Breakpoint {
  if (!hasMatchMedia()) return 'desktop';
  for (const [bp, query] of BREAKPOINT_QUERIES) {
    if (window.matchMedia(query).matches) return bp;
  }
  return 'desktop';
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(resolveBreakpoint);

  useEffect(() => {
    if (!hasMatchMedia()) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mqls = BREAKPOINT_QUERIES.map(([, query]) => window.matchMedia(query));

    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setBreakpoint(resolveBreakpoint()), 100);
    };

    for (const mql of mqls) mql.addEventListener('change', handler);
    window.addEventListener('resize', handler);
    return () => {
      if (timer) clearTimeout(timer);
      for (const mql of mqls) mql.removeEventListener('change', handler);
      window.removeEventListener('resize', handler);
    };
  }, []);

  return breakpoint;
}
