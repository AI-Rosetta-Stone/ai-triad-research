// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (TL, SO): op-ed run slots, reserved in-process. Lives in its own module so the
// complexity gate on routes/oped.ts stays under its threshold.

/** Concurrent op-ed runs allowed per user (P1, TL Q1). */
export const MAX_CONCURRENT_OPED_RUNS = 1;

/** t/467 (SO condition 1, TL p/16#213): concurrent ANONYMOUS op-ed runs allowed across the whole process.
 *  Every anonymous visitor shares one budget, so N cookies cannot run at once and multiply the overshoot
 *  of the spend ceilings. Value chosen here (TL did not name it): 2. */
export const ANON_PROCESS_RUN_CAP = 2;

// Taken SYNCHRONOUSLY before the first await and held until the run finishes, so a parallel burst
// can't pass the cap while the shared-store count still shows zero. The store count
// (countRunningOpedRuns) stays as the cross-replica check.
const opedRunSlots = new Map<string, number>();
let anonRunsInFlight = 0;

/** Reserve a run slot for `userId`. Returns a release function, or null when the per-user cap, or,
 *  for an anonymous run, the process-wide anonymous cap, is already full. Call release exactly once. */
export function reserveOpedRunSlot(userId: string, anonymous: boolean): (() => void) | null {
  const held = opedRunSlots.get(userId) ?? 0;
  if (held >= MAX_CONCURRENT_OPED_RUNS) return null;
  if (anonymous && anonRunsInFlight >= ANON_PROCESS_RUN_CAP) return null;
  opedRunSlots.set(userId, held + 1);
  if (anonymous) anonRunsInFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (opedRunSlots.get(userId) ?? 1) - 1;
    if (left <= 0) opedRunSlots.delete(userId); else opedRunSlots.set(userId, left);
    if (anonymous) anonRunsInFlight--;
  };
}
