// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4962: query-param surface for Server Community's AnalyticsExclusionOptions (t/4960).
// Contract agreed with Analysis (t/4962#4): `true`/`1` → true; `false`/`0` or absent → false;
// any other value is a 400, so a typo fails loudly instead of silently mis-toggling a filter.

import type { AnalyticsExclusionOptions } from '../community/analytics.js';

const EXCLUSION_PARAMS = ['includeListed', 'includeInternal', 'includeSystem', 'excludeAmbiguous'] as const;

export function parseExclusionParams(params: URLSearchParams): AnalyticsExclusionOptions | { invalid: string } {
  const opts: AnalyticsExclusionOptions = {};
  for (const name of EXCLUSION_PARAMS) {
    const raw = params.get(name);
    if (raw === null || raw === 'false' || raw === '0') continue;
    if (raw === 'true' || raw === '1') { opts[name] = true; continue; }
    return { invalid: `${name} must be true, false, 1 or 0` };
  }
  return opts;
}
