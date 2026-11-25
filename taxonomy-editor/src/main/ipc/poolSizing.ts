// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/424: validation for the optional relevant-nodes pool sizes. Kept out of taxonomyHandlers.ts so
// the handler file stays within its complexity budget. Absent (undefined) is valid and means the
// lib defaults apply. Caps match the server route (routes/relevantNodes.ts): minPerCategory at most
// 10, maxTotal at most 500.

const POOL_MAX: Record<'minPerCategory' | 'maxTotal', number> = { minPerCategory: 10, maxTotal: 500 };

export function assertPoolSize(name: 'minPerCategory' | 'maxTotal', value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > POOL_MAX[name]) {
    throw new Error(`Invalid ${name} (expected a positive integer, at most ${POOL_MAX[name]}), got: ${String(value)}`);
  }
}
