// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (TL, SO): per-user op-ed run slot, reserved in-process. Lives in its own module so the
// complexity gate on routes/oped.ts stays under its threshold.

/** Concurrent op-ed runs allowed per user (P1, TL Q1). */
export const MAX_CONCURRENT_OPED_RUNS = 1;

// Taken SYNCHRONOUSLY before the first await and held until the run finishes, so a parallel burst
// can't pass the cap while the shared-store count still shows zero. The store count
// (countRunningOpedRuns) stays as the cross-replica check.
const opedRunSlots = new Map<string, number>();

export function reserveOpedRunSlot(userId: string): boolean {
  const held = opedRunSlots.get(userId) ?? 0;
  if (held >= MAX_CONCURRENT_OPED_RUNS) return false;
  opedRunSlots.set(userId, held + 1);
  return true;
}

export function releaseOpedRunSlot(userId: string): void {
  const held = (opedRunSlots.get(userId) ?? 1) - 1;
  if (held <= 0) opedRunSlots.delete(userId); else opedRunSlots.set(userId, held);
}
