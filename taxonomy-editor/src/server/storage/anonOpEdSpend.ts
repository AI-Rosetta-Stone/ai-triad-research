// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (PI decision, TL p/16#211): spending guard for ANONYMOUS op-ed creation. A daily ceiling
// and a monthly ceiling, in USD, across all anonymous visitors. The ledger is a single shared
// record per day and per month (not per visitor), so a new cookie does not reset it.
//
// Fail closed: an unreadable ledger counts as at the ceiling, so the run is refused rather than
// let through unrecorded. Recording is read-modify-write, not atomic across replicas, so a
// concurrent burst can undercount by at most the runs in flight.

import path from 'path';
import { getUserContentBackend } from './fileIO.js';
import { log } from '../logger.js';

export const ANON_OPED_DAILY_CAP_USD = 10;
export const ANON_OPED_MONTHLY_CAP_USD = 50;

export type AnonOpEdCeiling = 'daily' | 'monthly';

const LEDGER_DIR = 'anon-oped-spend';

function dayKey(now: Date): string { return now.toISOString().slice(0, 10); }
function monthKey(now: Date): string { return now.toISOString().slice(0, 7); }
function ledgerPath(kind: 'day' | 'month', key: string): string {
  return path.posix.join(LEDGER_DIR, `${kind}-${key}.json`); // storage keys are '/'-separated on every OS
}

/** Spend recorded so far under one ledger file. Missing file = 0; unreadable file = at the cap (fail closed). */
async function readSpend(filePath: string, cap: number): Promise<number> {
  const raw = await getUserContentBackend().readFile(filePath);
  if (raw === null) return 0;
  try {
    const usd = Number((JSON.parse(raw) as { usd?: unknown }).usd);
    return Number.isFinite(usd) && usd >= 0 ? usd : cap;
  } catch (err) {
    log.server.warn({ component: 'oped', file: filePath, err: String(err), reason: 'anon-oped-spend-ledger-unreadable' }, 'Anonymous op-ed spend ledger is unreadable; treating it as at the ceiling (fail closed)');
    return cap;
  }
}

/** The first ceiling already reached for an anonymous op-ed run, or null when both are under their caps. */
export async function anonOpEdCeilingBreach(now: Date = new Date()): Promise<AnonOpEdCeiling | null> {
  const day = await readSpend(ledgerPath('day', dayKey(now)), ANON_OPED_DAILY_CAP_USD);
  if (day >= ANON_OPED_DAILY_CAP_USD) return 'daily';
  const month = await readSpend(ledgerPath('month', monthKey(now)), ANON_OPED_MONTHLY_CAP_USD);
  if (month >= ANON_OPED_MONTHLY_CAP_USD) return 'monthly';
  return null;
}

/** Add one anonymous run's cost to the day and month ledgers. */
export async function recordAnonOpEdSpend(usd: number, now: Date = new Date()): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const backend = getUserContentBackend();
  for (const [kind, key, cap] of [['day', dayKey(now), ANON_OPED_DAILY_CAP_USD], ['month', monthKey(now), ANON_OPED_MONTHLY_CAP_USD]] as const) {
    const p = ledgerPath(kind, key);
    const prior = await readSpend(p, cap);
    await backend.writeFile(p, JSON.stringify({ usd: prior + usd }));
  }
}
