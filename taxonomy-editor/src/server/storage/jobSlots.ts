// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Cross-replica admission for per-user job caps (t/400). The count-then-write check in jobCapChecker
// is only atomic inside one process (withSubmissionLock). Here each of the `cap` slots is claimed with
// an atomic create-only write, so two replicas can never both hold the same slot, and a cap of N
// admits at most N live jobs however many replicas race.
//
// Layout: `<jobsDir>/slots/slot-<index>-<generation>.json`, holding { jobId, claimedAt }.
// A slot's current holder is the file with the highest generation for that index. Reclaiming a dead
// holder never overwrites: the reclaimer creates generation+1 with writeFileIfAbsent, so exactly one
// racer wins and the others re-list. A holder is live while its job record says so (see
// isSlotHolderLive in jobCapChecker); a job reaching a terminal status, or going stale, frees its slot.

import type { StorageBackend } from './storageBackend.js';
import { writeFileIfAbsentStrict } from './fileIO.js';
import { log } from '../logger.js';

export interface SlotHolder {
  jobId: string;
  claimedAt: string;
}

/** Decides whether a slot's holder still occupies its slot (job record running and fresh, or a claim
 *  too recent for its record to exist yet). */
export type IsSlotHolderLive = (holder: SlotHolder) => Promise<boolean>;

const SLOT_FILE_RE = /^slot-(\d+)-(\d+)\.json$/;
const MAX_RACE_ATTEMPTS = 5;

export interface JobSlot {
  index: number;
  generation: number;
  dir: string;
}

/**
 * Claim one of `cap` slots for `jobId`. Returns the claimed slot, or null when every slot is held by a
 * live job. Throws if storage fails, so the caller answers 5xx rather than admitting unrecorded.
 */
export async function claimJobSlot(args: {
  backend: StorageBackend;
  jobsDir: string;
  cap: number;
  jobId: string;
  isLive: IsSlotHolderLive;
}): Promise<JobSlot | null> {
  const dir = `${args.jobsDir}/slots`;
  for (let index = 0; index < args.cap; index++) {
    let settled = false;
    for (let attempt = 0; attempt < MAX_RACE_ATTEMPTS && !settled; attempt++) {
      const { generation, holder } = await currentHolder(args.backend, dir, index);
      // An unreadable holder is held, not free: its claim time is unknown, so it cannot be aged past the
      // grace window. Fail closed and let an operator clear the file; never skip the grace on a guess.
      if (holder === 'unreadable') { settled = true; break; }
      if (holder && await args.isLive(holder)) { settled = true; break; } // held; try the next index
      const holderJobId = holder?.jobId ?? null;
      const claim: SlotHolder = { jobId: args.jobId, claimedAt: new Date().toISOString() };
      const created = await writeFileIfAbsentStrict(
        args.backend, `${dir}/slot-${index}-${generation + 1}.json`, JSON.stringify(claim),
      );
      if (created === 'created') {
        if (holderJobId) {
          log.server.info({ slot: index, reclaimedFrom: holderJobId }, 'job slot reclaimed from a dead holder');
        }
        return { index, generation: generation + 1, dir };
      }
      // 'exists': another replica claimed this generation first. Re-list and look again.
    }
    if (!settled) {
      // Every attempt lost the create race. The slot is not taken, so the next index is tried; WARN so the
      // contention is visible rather than silently skipped.
      log.server.warn({ slot: index, attempts: MAX_RACE_ATTEMPTS, cause: 'job-slot-race-exhausted' },
        'job slot claim lost every race attempt — trying the next slot');
    }
  }
  return null;
}

/** Highest generation for a slot index, with its holder. An unreadable or incomplete holder is 'unreadable'
 *  (held, see claimJobSlot); a holder file that vanished between list and read is free. */
async function currentHolder(
  backend: StorageBackend, dir: string, index: number,
): Promise<{ generation: number; holder: SlotHolder | 'unreadable' | null }> {
  const names = await backend.listDirectory(dir);
  let generation = -1;
  for (const name of names) {
    const m = SLOT_FILE_RE.exec(name);
    if (!m || Number(m[1]) !== index) continue;
    generation = Math.max(generation, Number(m[2]));
  }
  if (generation < 0) return { generation: -1, holder: null };
  const raw = await backend.readFile(`${dir}/slot-${index}-${generation}.json`);
  if (raw === null) return { generation, holder: null };
  let parsed: Partial<SlotHolder> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<SlotHolder>;
  } catch (err) {
    log.server.warn({ slot: index, generation, err: String(err), cause: 'job-slot-unreadable' },
      'job slot holder unreadable — slot held (fail closed); clear the file to free it');
    return { generation, holder: 'unreadable' };
  }
  if (typeof parsed.jobId !== 'string' || typeof parsed.claimedAt !== 'string') {
    log.server.warn({ slot: index, generation, cause: 'job-slot-unreadable' },
      'job slot holder lacks jobId or claimedAt — slot held (fail closed); clear the file to free it');
    return { generation, holder: 'unreadable' };
  }
  return { generation, holder: { jobId: parsed.jobId, claimedAt: parsed.claimedAt } };
}

/** Free a slot this request claimed but did not start a job in (the create failed), so the user's
 *  next POST is not held out for the claim grace window. Deleting a claim file is safe: it is never
 *  overwritten, and a newer generation is untouched. */
export async function releaseJobSlot(backend: StorageBackend, slot: JobSlot): Promise<void> {
  try {
    await backend.deleteFile(`${slot.dir}/slot-${slot.index}-${slot.generation}.json`);
  } catch (err) {
    // Fallback: the claim stays until its job record is missing past the grace window, then frees itself.
    log.server.warn({ slot: slot.index, generation: slot.generation, err: String(err), cause: 'job-slot-release-failed' },
      'job slot release failed — the claim frees itself after the claim grace window');
  }
}
