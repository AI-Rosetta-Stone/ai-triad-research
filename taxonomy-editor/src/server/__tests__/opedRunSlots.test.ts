// @vitest-environment node
// t/467 (SO condition 1, TL p/16#213): the in-process run slots. A per-user cap, and a process-wide cap on
// concurrent ANONYMOUS runs, so N cookies cannot run at once and multiply the spend overshoot.

import { describe, it, expect } from 'vitest';
import { reserveOpedRunSlot, ANON_PROCESS_RUN_CAP } from '../routes/opedRunSlots.js';

describe('op-ed run slots (t/467, SO condition 1)', () => {
  it('the process-wide anonymous cap is refused past its limit, across different visitors', () => {
    const held: Array<() => void> = [];
    for (let i = 0; i < ANON_PROCESS_RUN_CAP; i++) {
      const r = reserveOpedRunSlot(`anon-visitor-${i}`, true);
      expect(r).not.toBeNull();
      held.push(r!);
    }
    // One more visitor, with a fresh cookie: no slot, even though this user has none held.
    expect(reserveOpedRunSlot('anon-visitor-new', true)).toBeNull();
    // Releasing one frees one slot for the next anonymous run.
    held[0]();
    const next = reserveOpedRunSlot('anon-visitor-new', true);
    expect(next).not.toBeNull();
    next!();
    held.slice(1).forEach(release => release());
  });

  it('a released slot is freed exactly once (a second release does not free another run)', () => {
    const a = reserveOpedRunSlot('anon-once', true)!;
    const b = reserveOpedRunSlot('anon-other', true)!;
    a(); a(); // double release
    const third = reserveOpedRunSlot('anon-third', true);
    expect(third).not.toBeNull(); // one slot freed, not two
    expect(reserveOpedRunSlot('anon-fourth', true)).toBeNull();     // b and third hold both
    b();
    third!();
  });

  it('signed-in runs are not limited by the anonymous process cap', () => {
    const anon = Array.from({ length: ANON_PROCESS_RUN_CAP }, (_, i) => reserveOpedRunSlot(`anon-fill-${i}`, true)!);
    expect(reserveOpedRunSlot('signed-in-user', false)).not.toBeNull();
    anon.forEach(release => release());
  });

  it('the per-user cap still applies: one run per user', () => {
    const first = reserveOpedRunSlot('same-user', false)!;
    expect(reserveOpedRunSlot('same-user', false)).toBeNull();
    first();
    expect(reserveOpedRunSlot('same-user', false)).not.toBeNull();
  });
});

// t/467 (SO, TL p/16#216 item 1): the replica bound the ceilings must be set against.
import { replicaOvershootBoundUsd } from '../routes/opedRunSlots.js';
describe('replica overshoot bound (t/467, SO item 1)', () => {
  it('the anonymous spend a burst can add across replicas is replicas × cap × the largest run cost', () => {
    expect(replicaOvershootBoundUsd(1, 0.5)).toBeCloseTo(1); // 1 × 2 × 0.5
    expect(replicaOvershootBoundUsd(3, 0.5)).toBeCloseTo(3); // 3 × 2 × 0.5: three replicas triple it
  });
});
