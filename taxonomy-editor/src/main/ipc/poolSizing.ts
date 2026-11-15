// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/424: validation for the optional relevant-nodes pool sizes. Kept out of taxonomyHandlers.ts so
// the handler file stays within its complexity budget. Absent (undefined) is valid and means the
// lib defaults apply.

export function assertPoolSize(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name} (expected a positive integer), got: ${String(value)}`);
  }
}
